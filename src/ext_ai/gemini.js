import { GoogleGenAI } from "@google/genai";
import { getScratchpad as dbGetScratchpad, updateScratchpadTasks as dbUpdateScratchpadTasks, createSubagentRun as dbCreateSubagentRun, setSubagentRunStatus as dbSetSubagentRunStatus } from "../db.js";

function normalizeTools(toolInput) {
  if (!toolInput) return [];
  const all = new Set(["grounding", "search", "crawling", "read", "code", "code_execution"]);
  if (typeof toolInput === 'string') {
    if (toolInput.toLowerCase().trim() === 'all') return ["grounding", "crawling", "code_execution"];
    const val = toolInput.toLowerCase().trim();
    return all.has(val) ? [val] : [];
  }
  if (Array.isArray(toolInput)) {
    const out = [];
    for (const t of toolInput) {
      const v = String(t || '').toLowerCase().trim();
      if (v === 'all') return ["grounding", "crawling", "code_execution"];
      if (all.has(v)) out.push(v);
    }
    return Array.from(new Set(out));
  }
  return [];
}

function buildGeminiTools(toolList) {
  const tools = [];
  const set = new Set(toolList);
  if (set.has('grounding') || set.has('search')) tools.push({ googleSearch: {} });
  if (set.has('crawling') || set.has('read')) tools.push({ urlContext: {} });
  if (set.has('code') || set.has('code_execution')) tools.push({ codeExecution: {} });
  return tools;
}

function newRunId() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 10; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return `run-${s}`;
}

export async function runScratchpadSubagent(userId, { name, scratchpad_id, task_id, prompt, sys_prompt, tool }) {
  // Validate required args
  const sid = String(scratchpad_id || '').trim();
  const tid = String(task_id || '').trim();
  const userPrompt = String(prompt || '').trim();
  const run_id = newRunId();
  if (!sid || !tid || !userPrompt) {
    return { run_id, status: 'failure', error: 'scratchpad_id, task_id and prompt are required' };
  }

  const projectName = String(name || '').trim();
  if (!projectName) {
    return { run_id, status: 'failure', error: 'project_name_required' };
  }
  // Record run as pending before any long-running work
  await dbCreateSubagentRun(userId, projectName, run_id, 'pending');
  // Load current scratchpad to read existing fields and common_memory
  let sp;
  try {
    sp = await dbGetScratchpad(userId, projectName, sid);
  } catch (err) {
    await dbSetSubagentRunStatus(userId, projectName, run_id, 'failure');
    return { run_id, status: 'failure', error: 'scratchpad_not_found' };
  }
  const task = (sp.tasks || []).find(t => String(t.task_id) === tid);
  if (!task) {
    await dbSetSubagentRunStatus(userId, projectName, run_id, 'failure');
    return { run_id, status: 'failure', error: 'task_not_found_in_scratchpad' };
  }

  const toolList = normalizeTools(tool);
  const geminiTools = buildGeminiTools(toolList);
  const toolNamesForPrompt = (toolList.length ? toolList : ["grounding", "crawling", "code_execution"]).join(', ');
  const defaultSys = `You are a general problem-solving agent with access to ${toolNamesForPrompt}. Keep answers concise and accurate.`;
  const systemPrompt = String(sys_prompt || defaultSys);

  // Append common_memory to prompt if present
  const finalPrompt = sp.common_memory && sp.common_memory.trim().length
    ? `${userPrompt}\n\nContext (scratchpad common_memory):\n${sp.common_memory}`
    : userPrompt;

  // Prepare environment
  const apiType = (process.env.AI_API_TYPE || 'google').toLowerCase();
  const apiKey = String(process.env.AI_API_KEY || '').trim();
  const model = String((process.env.AI_MODEL || 'gemini-2.5-pro')).replace(/^"|"$/g, '');
  if (apiType !== 'google') {
    await dbSetSubagentRunStatus(userId, projectName, run_id, 'failure');
    return { run_id, status: 'failure', error: `unsupported_ai_api_type:${apiType}` };
  }
  if (!apiKey) {
    await dbSetSubagentRunStatus(userId, projectName, run_id, 'failure');
    return { run_id, status: 'failure', error: 'missing_api_key (set AI_API_KEY)' };
  }

  const aiTimeoutSec = Number.isFinite(Number(process.env.AI_TIMEOUT)) ? Number(process.env.AI_TIMEOUT) : 120;
  const softReturnMs = 25000;

  const runWork = async () => {
    await dbSetSubagentRunStatus(userId, projectName, run_id, 'in_progress');
    const ai = new GoogleGenAI({ apiKey });
    const config = {
      thinkingConfig: { thinkingBudget: 8192 },
      tools: geminiTools.length ? geminiTools : [{ googleSearch: {} }, { urlContext: {} }, { codeExecution: {} }],
    };
    const contents = [
      { role: 'user', parts: [{ text: systemPrompt }] },
      { role: 'user', parts: [{ text: finalPrompt }] },
    ];

    let textOut = '';
    const codeSnippets = [];
    const codeResults = [];
    const urls = new Set();

    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const hardTimer = setTimeout(() => { try { controller?.abort(); } catch {} }, Math.max(1000, aiTimeoutSec * 1000));
    try {
      const stream = await ai.models.generateContentStream({ model, config, contents, signal: controller?.signal });
      for await (const chunk of stream) {
        const c = chunk?.candidates?.[0];
        const part = c?.content?.parts?.[0];
        if (part?.text) textOut += part.text;
        if (part?.executableCode) codeSnippets.push(String(part.executableCode || ''));
        if (part?.codeExecutionResult) codeResults.push(String(part.codeExecutionResult || ''));
        const gm = c?.groundingMetadata;
        const chunks = gm?.groundingChunks || [];
        for (const ch of chunks) {
          const uri = ch?.web?.uri;
          if (uri) urls.add(String(uri));
        }
      }
      clearTimeout(hardTimer);
      const stamp = new Date().toISOString();
      const scratchpadAppend = [
        `\n[subagent ${run_id} @ ${stamp}]`,
        textOut && textOut.trim() ? textOut.trim() : '(no response text)'
      ].join('\n');
      const commentParts = [`[subagent ${run_id} meta]`];
      if (urls.size) {
        commentParts.push('Sources:');
        for (const u of urls.values()) commentParts.push(`- ${u}`);
      }
      if (codeSnippets.length) {
        commentParts.push('Code used:');
        for (const s of codeSnippets) commentParts.push('```\n' + s + '\n```');
      }
      if (codeResults.length) {
        commentParts.push('Code results:');
        for (const r of codeResults) commentParts.push('```\n' + r + '\n```');
      }
      const commentsAppend = commentParts.join('\n');
      const newScratchpad = ((task.scratchpad || '') + (task.scratchpad && !task.scratchpad.endsWith('\n') ? '\n' : '') + scratchpadAppend).trim();
      const newComments = ((task.comments || '') + (task.comments && !task.comments.endsWith('\n') ? '\n' : '') + commentsAppend).trim();
      await dbUpdateScratchpadTasks(userId, projectName, sid, [ { task_id: tid, scratchpad: newScratchpad, comments: newComments } ]);
      await dbSetSubagentRunStatus(userId, projectName, run_id, 'success');
      return { run_id, status: 'success' };
    } catch (err) {
      clearTimeout(hardTimer);
      await dbSetSubagentRunStatus(userId, projectName, run_id, 'failure');
      return { run_id, status: 'failure', error: String(err?.message || err) };
    }
  };

  const softTimer = new Promise(resolve => setTimeout(() => resolve({ run_id, status: 'in_progress' }), softReturnMs));
  const runPromise = runWork();
  return await Promise.race([runPromise, softTimer]);
}
