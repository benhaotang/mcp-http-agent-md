// Central controller for external AI subagent providers
// Orchestrates scratchpad fetch/update, run tracking, prompt building,
// tool normalization, provider selection, and timeout behavior.

import fs from "fs/promises";
import path from "path";

import {
  getScratchpad as dbGetScratchpad,
  updateScratchpadTasks as dbUpdateScratchpadTasks,
  createSubagentRun as dbCreateSubagentRun,
  setSubagentRunStatus as dbSetSubagentRunStatus,
  resolveProjectAccess as dbResolveProjectAccess,
  listProjectFiles as dbListProjectFiles,
  getDataDir,
} from "../db.js";

function normalizeTools(toolInput) {
  if (!toolInput) return [];
  if (typeof toolInput === "string") {
    const val = toolInput.toLowerCase().trim();
    if (val === "all") return ["grounding", "crawling", "code_execution"];
    return val ? [val] : [];
  }
  if (Array.isArray(toolInput)) {
    const out = [];
    for (const t of toolInput) {
      const v = String(t || "").toLowerCase().trim();
      if (v === "all") return ["grounding", "crawling", "code_execution"];
      if (v) out.push(v);
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
  if (v === 'openai-compatible' || v === 'openai_compat' || v === 'openai_compatible' || v === 'compat' || v === 'openai_com') return 'openai_com';
  if (v === 'mcp') return 'mcp';
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
    case 'mcp':
      return 'gpt-4o-mini';
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
    case 'mcp':
      // MCP tools are provided externally via subagent_config.json; no built-in caps needed here.
      return [];
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
    if (key === "google") {
      const mod = await import("./gemini.js");
      return { key, infer: inferGemini };
    }
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
    if (key === "mcp") {
      const mod = await import("./aisdkmcp.js");
      return { key, infer: mod.infer };
    }
    return { key, infer: null };
  } catch (e) {
    return { key, infer: null, error: String(e?.message || e) };
  }
}

async function prepareAiEnv() {
  const apiType = resolveApiType(process.env.AI_API_TYPE || 'google');
  const apiKey = String(process.env.AI_API_KEY || '').trim();
  const { key: providerKey, infer, error: providerErr } = await selectProvider(apiType);
  const model = String(process.env.AI_MODEL || defaultModelFor(providerKey)).replace(/^"|"$/g, "");
  const baseUrl = String(process.env.AI_BASE_ENDPOINT || '').trim();
  const aiTimeoutSec = Number.isFinite(Number(process.env.AI_TIMEOUT)) ? Number(process.env.AI_TIMEOUT) : 120;
  return { providerKey, infer, providerErr, model, baseUrl, aiTimeoutSec, apiKey };
}

async function resolveAttachmentFromFileId(userId, projectId, fileId) {
  const trimmed = String(fileId || "").trim();
  if (!trimmed) return null;
  if (!/^[a-f0-9]{16}$/i.test(trimmed)) {
    throw new Error("invalid_file_id");
  }
  const access = await dbResolveProjectAccess(userId, projectId);
  if (!access) {
    throw new Error("project_not_found_or_access_denied");
  }
  const files = await dbListProjectFiles(access.owner_id, access.project_id);
  const meta = files.find((f) => String(f.file_id) === trimmed);
  if (!meta) {
    throw new Error("file_not_found");
  }
  const baseDir = path.join(getDataDir(), access.project_id);
  const resolved = path.join(baseDir, trimmed);
  try {
    await fs.access(resolved);
  } catch (err) {
    throw new Error("file_missing_on_disk");
  }
  return { path: resolved, meta };
}

export async function runScratchpadSubagent(
  userId,
  { project_id, scratchpad_id, task_id, prompt, sys_prompt, tool, file_path, file_id }
) {
  // Validate required args
  const sid = String(scratchpad_id || "").trim();
  const tid = String(task_id || "").trim();
  const userPrompt = String(prompt || "").trim();
  const projectId = String(project_id || "").trim();
  const run_id = newRunId();

  if (!sid || !tid || !userPrompt) {
    return {
      run_id,
      status: "failure",
      error: "scratchpad_id, task_id and prompt are required",
    };
  }
  if (!projectId) {
    return { run_id, status: "failure", error: "project_id_required" };
  }

  // Record run as pending before any long-running work
  await dbCreateSubagentRun(userId, projectId, run_id, "pending");

  // Load current scratchpad to read existing fields and common_memory
  let sp;
  try {
    sp = await dbGetScratchpad(userId, projectId, sid);
  } catch (err) {
    await dbSetSubagentRunStatus(userId, projectId, run_id, "failure");
    return { run_id, status: "failure", error: "scratchpad_not_found" };
  }
  const task = (sp.tasks || []).find((t) => String(t.task_id) === tid);
  if (!task) {
    await dbSetSubagentRunStatus(userId, projectId, run_id, "failure");
    return { run_id, status: "failure", error: "task_not_found_in_scratchpad" };
  }

  const requestedTools = canonicalizeTools(normalizeTools(tool));

  // Append common_memory to prompt if present
  const finalPrompt = sp.common_memory && sp.common_memory.trim().length
    ? `${userPrompt}\n\nContext (scratchpad common_memory):\n${sp.common_memory}`
    : userPrompt;

  // Prepare environment (reused across helpers)
  const { providerKey, infer, providerErr, model, baseUrl, apiKey, aiTimeoutSec } = await prepareAiEnv();
  const softReturnMs = 25000;

  if (!infer) {
    await dbSetSubagentRunStatus(userId, projectId, run_id, "failure");
    return {
      run_id,
      status: "failure",
      error: providerErr ? `provider_unavailable:${providerKey} (${providerErr})` : `unsupported_ai_api_type:${providerKey}`,
    };
  }
  if (!apiKey) {
    await dbSetSubagentRunStatus(userId, projectId, run_id, "failure");
    return {
      run_id,
      status: "failure",
      error: "missing_api_key (set AI_API_KEY)",
    };
  }

  // Compute provider-supported tools and filter the request
  const caps = providerCapabilities(providerKey);

  if (providerKey !== 'mcp' && requestedTools.length > 0) {
    const unsupported = requestedTools.filter(t => !caps.includes(t));
    if (unsupported.length > 0) {
      await dbSetSubagentRunStatus(userId, projectId, run_id, 'failure');
      return {
        run_id,
        status: 'failure',
        error: `Tool(s) not supported by ${providerKey}: [${unsupported.join(', ')}]`,
      };
    }
  }

  let chosenTools = requestedTools.length ? requestedTools : caps;

  // For MCP provider, interpret the raw 'tool' argument as specific MCP tool names (or 'all')
  let mcpToolSelection = null; // null means 'all'
  if (providerKey === 'mcp') {
    const raw = tool;
    if (raw == null) {
      mcpToolSelection = 'all';
    } else if (typeof raw === 'string') {
      const val = raw.trim();
      mcpToolSelection = /^all$/i.test(val)
        ? 'all'
        : val.split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
    } else if (Array.isArray(raw)) {
      const arr = raw.map(v => String(v || '').trim()).filter(Boolean);
      mcpToolSelection = arr.length === 1 && /^all$/i.test(arr[0]) ? 'all' : arr;
    } else {
      mcpToolSelection = 'all';
    }
  }

  const toolNamesForPrompt = providerKey === 'mcp'
    ? (mcpToolSelection === 'all' || (Array.isArray(mcpToolSelection) && mcpToolSelection.length === 0)
        ? 'MCP tools'
        : `MCP tools (${(mcpToolSelection || []).join(', ')})`)
    : (chosenTools.join(', ') || 'no external tools');
  const defaultSys = `You are a general problem-solving agent with access to ${toolNamesForPrompt}. Keep answers concise and accurate.`;
  const systemPrompt = String(sys_prompt || defaultSys);

  let attachmentPath = typeof file_path === 'string' ? file_path.trim() : null;
  const attachmentFileId = typeof file_id === 'string' ? file_id.trim() : null;
  let attachmentMeta = null;
  if (!attachmentPath && attachmentFileId) {
    try {
      const att = await resolveAttachmentFromFileId(userId, projectId, attachmentFileId);
      attachmentPath = att.path;
      attachmentMeta = att.meta ? { mimeType: att.meta.file_type || '', originalName: att.meta.original_name || '' } : null;
    } catch (err) {
      try {
        await dbSetSubagentRunStatus(userId, projectId, run_id, "failure");
      } catch {}
      return {
        run_id,
        status: "failure",
        error: `file_attachment_error:${String(err?.message || err)}`,
      };
    }
  }

  const runWork = async () => {
    await dbSetSubagentRunStatus(userId, projectId, run_id, "in_progress");
    try {
      const result = await infer({
        apiKey,
        model,
        baseUrl,
        systemPrompt,
        userPrompt: finalPrompt,
        tools: providerKey === 'mcp' ? (mcpToolSelection || 'all') : chosenTools,
        timeoutSec: aiTimeoutSec,
        filePath: attachmentPath,
        fileMeta: attachmentMeta,
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

      await dbUpdateScratchpadTasks(userId, projectId, sid, [
        { task_id: tid, scratchpad: newScratchpad, comments: newComments },
      ]);
      await dbSetSubagentRunStatus(userId, projectId, run_id, "success");
      return { run_id, status: "success" };
    } catch (err) {
      await dbSetSubagentRunStatus(userId, projectId, run_id, "failure");
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

// Direct summary generator (no scratchpad, no MCP); returns raw text
export async function summarizeFile(
  userId,
  { project_id, file_id, prompt: promptOverride }
) {
  const projectId = String(project_id || '').trim();
  const fid = String(file_id || '').trim();
  if (!projectId) return { error: 'project_id_required' };
  if (!fid) return { error: 'file_id_required' };

  const { providerKey, infer, providerErr, model, baseUrl, apiKey, aiTimeoutSec } = await prepareAiEnv();

  if (!infer) {
    return { error: providerErr ? `provider_unavailable:${providerKey} (${providerErr})` : `unsupported_ai_api_type:${providerKey}` };
  }
  if (!apiKey) {
    return { error: 'missing_api_key' };
  }

  let att;
  try {
    att = await resolveAttachmentFromFileId(userId, projectId, fid);
  } catch (e) {
    return { error: String(e?.message || e) };
  }

  const systemPrompt = 'You are a concise, accurate summarizer.';
  const prompt = String(promptOverride || '').trim() || `Read the attached document and produce the following Markdown sections only:

# Summary
A concise but detailed summary of the document.

# Outline
A hierarchical outline of the document (sections/subsections).

# Summary per section/part/outline
For each section/part in the outline, provide a short summary capturing key points.

Only return these three sections as Markdown.`;

  const result = await infer({
    apiKey,
    model,
    baseUrl,
    systemPrompt,
    userPrompt: prompt,
    tools: [],
    timeoutSec: aiTimeoutSec,
    filePath: att.path,
    fileMeta: att.meta ? { mimeType: att.meta.file_type || '', originalName: att.meta.original_name || '' } : null,
  });
  return { text: String(result?.text || '') };
}
