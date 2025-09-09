// Central controller for external AI subagent providers
// Orchestrates scratchpad fetch/update, run tracking, prompt building,
// tool normalization, provider selection, and timeout behavior.

import {
  getScratchpad as dbGetScratchpad,
  updateScratchpadTasks as dbUpdateScratchpadTasks,
  createSubagentRun as dbCreateSubagentRun,
  setSubagentRunStatus as dbSetSubagentRunStatus,
} from "../db.js";

// Provider modules: keep lightweight; only import ones we support now.
// For initial step, only google (Gemini) is fully wired.
import { infer as inferGemini } from "./gemini.js";

function normalizeTools(toolInput) {
  if (!toolInput) return [];
  const all = new Set(["grounding", "search", "crawling", "read", "code", "code_execution"]);
  if (typeof toolInput === "string") {
    const val = toolInput.toLowerCase().trim();
    if (val === "all") return ["grounding", "crawling", "code_execution"];
    return all.has(val) ? [val] : [];
  }
  if (Array.isArray(toolInput)) {
    const out = [];
    for (const t of toolInput) {
      const v = String(t || "").toLowerCase().trim();
      if (v === "all") return ["grounding", "crawling", "code_execution"];
      if (all.has(v)) out.push(v);
    }
    return Array.from(new Set(out));
  }
  return [];
}

function canonicalizeTools(list) {
  const map = new Map([
    ['search', 'grounding'],
    ['read', 'crawling'],
    ['code', 'code_execution'],
  ]);
  const out = [];
  for (const t of list || []) {
    const k = String(t || '').toLowerCase();
    out.push(map.get(k) || k);
  }
  return Array.from(new Set(out));
}

function newRunId() {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < 10; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return `run-${s}`;
}

function resolveApiType(val) {
  const v = String(val || '').toLowerCase().trim();
  if (v === 'gemini') return 'google';
  if (v === 'oa' || v === 'oai' || v === 'openai') return 'openai';
  if (v === 'openai-compatible' || v === 'openai_compat' || v === 'openai_compatible' || v === 'compat') return 'openai_com';
  return v || 'google';
}

function defaultModelFor(provider) {
  switch (provider) {
    case 'google':
      return 'gemini-2.5-pro';
    case 'openai':
      return 'gpt-5-mini';
    case 'openai_com':
      return 'gpt-4o-mini';
    case 'groq':
      return 'openai/gpt-oss-120b';
    default:
      return '';
  }
}

function providerCapabilities(provider) {
  switch (provider) {
    case 'google':
      return ['grounding', 'crawling', 'code_execution'];
    case 'openai':
      return ['grounding'];
    case 'groq':
      return ['grounding', 'code_execution'];
    case 'openai_com':
    default:
      return [];
  }
}

export function getProviderMeta() {
  const key = resolveApiType(process.env.AI_API_TYPE || 'google');
  const tools = providerCapabilities(key);
  const toolsNote = key === 'openai_com' ? "Tool selection is ignored for OpenAI-compatible endpoints." : '';
  return { key, tools, toolsNote };
}

async function selectProvider(apiType) {
  const key = resolveApiType(apiType);
  try {
    if (key === "google") return { key, infer: inferGemini };
    if (key === "openai") {
      const mod = await import("./openai.js");
      return { key, infer: mod.infer };
    }
    if (key === "groq") {
      const mod = await import("./groq.js");
      return { key, infer: mod.infer };
    }
    if (key === "openai_com") {
      const mod = await import("./openai_com.js");
      return { key, infer: mod.infer };
    }
    return { key, infer: null };
  } catch (e) {
    return { key, infer: null, error: String(e?.message || e) };
  }
}

export async function runScratchpadSubagent(
  userId,
  { name, scratchpad_id, task_id, prompt, sys_prompt, tool }
) {
  // Validate required args
  const sid = String(scratchpad_id || "").trim();
  const tid = String(task_id || "").trim();
  const userPrompt = String(prompt || "").trim();
  const projectName = String(name || "").trim();
  const run_id = newRunId();

  if (!sid || !tid || !userPrompt) {
    return {
      run_id,
      status: "failure",
      error: "scratchpad_id, task_id and prompt are required",
    };
  }
  if (!projectName) {
    return { run_id, status: "failure", error: "project_name_required" };
  }

  // Record run as pending before any long-running work
  await dbCreateSubagentRun(userId, projectName, run_id, "pending");

  // Load current scratchpad to read existing fields and common_memory
  let sp;
  try {
    sp = await dbGetScratchpad(userId, projectName, sid);
  } catch (err) {
    await dbSetSubagentRunStatus(userId, projectName, run_id, "failure");
    return { run_id, status: "failure", error: "scratchpad_not_found" };
  }
  const task = (sp.tasks || []).find((t) => String(t.task_id) === tid);
  if (!task) {
    await dbSetSubagentRunStatus(userId, projectName, run_id, "failure");
    return { run_id, status: "failure", error: "task_not_found_in_scratchpad" };
  }

  const requestedTools = canonicalizeTools(normalizeTools(tool));

  // Append common_memory to prompt if present
  const finalPrompt = sp.common_memory && sp.common_memory.trim().length
    ? `${userPrompt}\n\nContext (scratchpad common_memory):\n${sp.common_memory}`
    : userPrompt;

  // Prepare environment
  const apiType = resolveApiType(process.env.AI_API_TYPE || "google");
  const apiKey = String(process.env.AI_API_KEY || "").trim();
  const { key: providerKey, infer, error: providerErr } = await selectProvider(apiType);
  const model = String(process.env.AI_MODEL || defaultModelFor(providerKey)).replace(/^"|"$/g, "");
  const baseUrl = String(process.env.AI_BASE_ENDPOINT || "").trim();
  const aiTimeoutSec = Number.isFinite(Number(process.env.AI_TIMEOUT))
    ? Number(process.env.AI_TIMEOUT)
    : 120;
  const softReturnMs = 25000;

  if (!infer) {
    await dbSetSubagentRunStatus(userId, projectName, run_id, "failure");
    return {
      run_id,
      status: "failure",
      error: providerErr ? `provider_unavailable:${providerKey} (${providerErr})` : `unsupported_ai_api_type:${providerKey}`,
    };
  }
  if (!apiKey) {
    await dbSetSubagentRunStatus(userId, projectName, run_id, "failure");
    return {
      run_id,
      status: "failure",
      error: "missing_api_key (set AI_API_KEY)",
    };
  }

  // Compute provider-supported tools and filter the request
  const caps = providerCapabilities(providerKey);
  const chosenTools = requestedTools.length ? requestedTools.filter(t => caps.includes(t)) : caps;
  const toolNamesForPrompt = chosenTools.join(', ');
  const defaultSys = `You are a general problem-solving agent with access to ${toolNamesForPrompt || 'no external tools'}. Keep answers concise and accurate.`;
  const systemPrompt = String(sys_prompt || defaultSys);

  const runWork = async () => {
    await dbSetSubagentRunStatus(userId, projectName, run_id, "in_progress");
    try {
      const result = await infer({
        apiKey,
        model,
        baseUrl,
        systemPrompt,
        userPrompt: finalPrompt,
        tools: chosenTools,
        timeoutSec: aiTimeoutSec,
      });

      const textOut = String(result?.text || "");
      const codeSnippets = Array.isArray(result?.codeSnippets)
        ? result.codeSnippets.map((s) => String(s))
        : [];
      const codeResults = Array.isArray(result?.codeResults)
        ? result.codeResults.map((s) => String(s))
        : [];
      const urlsArr = Array.isArray(result?.urls)
        ? result.urls.map((u) => String(u))
        : [];

      const urls = new Set(urlsArr.filter(Boolean));

      const stamp = new Date().toISOString();
      const scratchpadAppend = [
        `\n[subagent ${run_id} @ ${stamp}]`,
        textOut && textOut.trim() ? textOut.trim() : "(no response text)",
      ].join("\n");

      const commentParts = [`[subagent ${run_id} meta]`];
      if (urls.size) {
        commentParts.push("Sources:");
        for (const u of urls.values()) commentParts.push(`- ${u}`);
      }
      if (codeSnippets.length) {
        commentParts.push("Code used:");
        for (const s of codeSnippets) commentParts.push("```\n" + s + "\n```");
      }
      if (codeResults.length) {
        commentParts.push("Code results:");
        for (const r of codeResults) commentParts.push("```\n" + r + "\n```");
      }
      const commentsAppend = commentParts.join("\n");

      const newScratchpad = (
        (task.scratchpad || "") +
        (task.scratchpad && !task.scratchpad.endsWith("\n") ? "\n" : "") +
        scratchpadAppend
      ).trim();

      const newComments = (
        (task.comments || "") +
        (task.comments && !task.comments.endsWith("\n") ? "\n" : "") +
        commentsAppend
      ).trim();

      await dbUpdateScratchpadTasks(userId, projectName, sid, [
        { task_id: tid, scratchpad: newScratchpad, comments: newComments },
      ]);
      await dbSetSubagentRunStatus(userId, projectName, run_id, "success");
      return { run_id, status: "success" };
    } catch (err) {
      await dbSetSubagentRunStatus(userId, projectName, run_id, "failure");
      return {
        run_id,
        status: "failure",
        error: String(err?.message || err),
      };
    }
  };

  const softTimer = new Promise((resolve) =>
    setTimeout(() => resolve({ run_id, status: "in_progress" }), softReturnMs)
  );
  const runPromise = runWork();
  return await Promise.race([runPromise, softTimer]);
}

export default { runScratchpadSubagent };
