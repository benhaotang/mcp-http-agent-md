import express from 'express';
import next from 'next';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import { loadEnvFromDotenv } from './src/env.js';

loadEnvFromDotenv();

// Configuration
const BASE_PATH = process.env.BASE_PATH || '/mcp'; // MCP endpoint path
const HOST = process.env.HOST || process.env.MCP_HOST || 'localhost';
const PORT = process.env.PORT ? Number(process.env.PORT) : (process.env.MCP_PORT ? Number(process.env.MCP_PORT) : 3000);
import { buildAuthRouter, apiKeyQueryMiddleware } from './src/auth.js';
import {
  listProjects as dbListProjects,
  initProject as dbInitProject,
  deleteProject as dbDeleteProject,
  renameProject as dbRenameProject,
  readDoc as dbReadDoc,
  writeDoc as dbWriteDoc,
  listTasks as dbListTasks,
  addTasks as dbAddTasks,
  replaceTasks as dbReplaceTasks,
  setTasksState as dbSetTasksState,
  listUserTaskIds as dbListUserTaskIds,
  initScratchpad as dbInitScratchpad,
  getScratchpad as dbGetScratchpad,
  updateScratchpadTasks as dbUpdateScratchpadTasks,
  appendScratchpadCommonMemory as dbAppendScratchpadCommonMemory,
  getSubagentRun as dbGetSubagentRun,
  listProjectsForUserWithShares as dbListProjectsWithShares,
  resolveProjectAccess as dbResolveProjectAccess,
} from './src/db.js';
import { onInitProject as vcOnInitProject, commitProject as vcCommitProject, listProjectLogs as vcListLogs, revertProject as vcRevertProject } from './src/version.js';
import { runScratchpadSubagent, getProviderMeta } from './src/ext_ai/ext_ai.js';
import { buildProjectsRouter } from './src/share.js';

// Utility: sanitize and validate project name (letters, digits, space, dot, underscore, hyphen)
function validateProjectName(name) {
  if (typeof name !== 'string') return false;
  const trimmed = name.trim();
  if (trimmed.length === 0) return false;
  // Allow common characters and spaces; disallow control characters and symbols
  return /^[A-Za-z0-9._\- ]{1,100}$/.test(trimmed);
}
// DB-backed project and file operations (per-user)
function userOps(userId, userName) {
  return {
    async listProjects() {
      const rows = await dbListProjectsWithShares(userId);
      return rows;
    },
    async initProject(name, { agent = defaultAgentMd(name), progress = [] } = {}) {
      if (!validateProjectName(name)) throw new Error('Invalid project name');
      const agentJson = JSON.stringify({ content: agent });
      // Progress now stored in structured tasks table; keep placeholder in project row
      const progressJson = JSON.stringify({ content: '' });
      const res = await dbInitProject(userId, name, { agentJson, progressJson });
      // If structured tasks provided on init, try to insert them
      const tasks = Array.isArray(progress) ? progress : [];
      if (tasks.length) {
        const valid = validateAndNormalizeTasks(tasks);
        if (valid.invalid.length) {
          res.invalid = valid.invalid;
        }
        if (valid.tasks.length) {
          const addRes = await dbAddTasks(userId, res.id, valid.tasks);
          res.added = addRes.added;
          res.exists = addRes.exists;
        } else {
          res.added = [];
          res.exists = [];
        }
      }
      try {
        const hash = await vcOnInitProject(userId, res.id);
        res.hash = hash;
      } catch (err) {
        console.error(`Failed to initialize versioning for project "${name}":`, err);
      }
      return res;
    },
    async removeProject(projectId) {
      await dbDeleteProject(userId, String(projectId || ''));
    },
    async renameProject(projectId, newName) {
      if (!validateProjectName(newName)) throw new Error('Invalid project name');
      return dbRenameProject(userId, String(projectId || ''), newName);
    },
    async readDoc(projectId, which) {
      const acc = await dbResolveProjectAccess(userId, String(projectId || ''));
      if (!acc) throw new Error('project not found');
      return dbReadDoc(acc.owner_id, acc.project_id, which);
    },
    async writeDoc(projectId, which, content) {
      const acc = await dbResolveProjectAccess(userId, String(projectId || ''));
      if (!acc) throw new Error('project not found');
      if (acc.permission === 'ro') { const e = new Error('read_only_project'); e.code = 'read_only_project'; throw e; }
      await dbWriteDoc(acc.owner_id, acc.project_id, which, content);
      return { modifiedBy: (acc.permission !== 'owner') ? (userName || userId) : null, ownerId: acc.owner_id };
    },
  };
}

// -------- Progress helpers --------
function coerceJsonArray(input) {
  if (Array.isArray(input)) return input;
  if (typeof input === 'string') {
    const s = input.trim();
    if (s.startsWith('[')) {
      try {
        const parsed = JSON.parse(s);
        if (Array.isArray(parsed)) return parsed;
      } catch {}
    }
  }
  return null;
}

function coerceProgressContent(content) {
  // Accept either raw markdown string or a JSON array of strings
  const arr = coerceJsonArray(content);
  if (arr) {
    const lines = arr
      .filter(v => typeof v === 'string' && v.trim().length > 0)
      .map(v => formatProgressLine('pending', v.trim()));
    return lines.join('\n') + (lines.length ? '\n' : '');
  }
  return String(content ?? '');
}
function parseProgressLine(line) {
  // Returns { isItem, state, text }
  const m = line.match(/^\s*-\s*\[(.|\s)\]\s*(.*)$/);
  if (m) {
    const raw = m[1].toLowerCase();
    const text = m[2] ?? '';
    let state = 'pending';
    if (raw === 'x') state = 'completed';
    else if (raw === '~' || raw === '-') state = 'in_progress';
    else state = 'pending';
    return { isItem: true, state, text };
  }
  // Fallback: dash bullet without checkbox
  const m2 = line.match(/^\s*-\s+(.*)$/);
  if (m2) {
    return { isItem: true, state: 'pending', text: m2[1] };
  }
  return { isItem: false };
}

function formatProgressLine(state, text) {
  let marker = '[ ]';
  if (state === 'completed') marker = '[x]';
  else if (state === 'in_progress') marker = '[~]';
  return `- ${marker} ${text}`;
}

function normalizeStateFilter(val) {
  const v = String(val || '').toLowerCase().trim();
  if (['todo', 'to-do', 'pending', 'not_started', 'not-started', 'open'].includes(v)) return 'pending';
  if (['in_progress', 'in-progress', 'doing', 'wip'].includes(v)) return 'in_progress';
  if (['done', 'completed', 'complete', 'closed'].includes(v)) return 'completed';
  if (['archived', 'archive'].includes(v)) return 'archived';
  return null;
}

function validateTaskId(id) {
  return typeof id === 'string' && /^[a-z0-9]{8}$/.test(id);
}

function normalizeStatus(s) {
  const v = String(s || '').toLowerCase().trim();
  if (v === 'pending' || v === 'in_progress' || v === 'completed' || v === 'archived') return v;
  if (['todo', 'to-do', 'open', 'not-started', 'not_started'].includes(v)) return 'pending';
  if (['doing', 'wip', 'in-progress'].includes(v)) return 'in_progress';
  if (['done', 'complete', 'closed'].includes(v)) return 'completed';
  if (['archive', 'archived'].includes(v)) return 'archived';
  return 'pending';
}

// Accept tasks as array, single object, or JSON string of either; returns { tasks, invalid }
function validateAndNormalizeTasks(input) {
  let list = input;
  if (typeof input === 'string') {
    const s = input.trim();
    try {
      const parsed = JSON.parse(s);
      list = Array.isArray(parsed) ? parsed : (parsed && typeof parsed === 'object' ? [parsed] : []);
    } catch {
      list = [];
    }
  }
  // If a single object was provided directly, wrap it into an array
  if (!Array.isArray(list)) {
    if (list && typeof list === 'object') list = [list];
    else list = [];
  }
  const tasks = [];
  const invalid = [];
  for (const t of list) {
    if (!t || typeof t !== 'object') { invalid.push({ item: t, reason: 'not_an_object' }); continue; }
    const task_id = String(t.task_id || '').trim();
    const task_info = String(t.task_info || '').trim();
    const parent_id = t.parent_id == null ? null : String(t.parent_id).trim();
    const extra_note = t.extra_note == null ? null : String(t.extra_note);
    const status = normalizeStatus(t.status || 'pending');
    if (!validateTaskId(task_id)) { invalid.push({ item: t, reason: 'invalid_task_id_format', hint: 'Use exactly 8 lowercase a-z0-9, e.g., abcd1234' }); continue; }
    if (!task_info) { invalid.push({ item: t, reason: 'missing_task_info' }); continue; }
    if (parent_id && !validateTaskId(parent_id)) { invalid.push({ item: t, reason: 'invalid_parent_id_format', hint: 'Use exactly 8 lowercase a-z0-9' }); continue; }
    tasks.push({ task_id, task_info, parent_id, status, extra_note });
  }
  return { tasks, invalid };
}

function filterProgressContent(md, only) {
  const list = Array.isArray(only) ? only : (only == null ? [] : [only]);
  const wanted = new Set(list.map(normalizeStateFilter).filter(Boolean));
  if (!wanted.size) return String(md ?? '');
  const out = [];
  const lines = String(md || '').split(/\r?\n/);
  for (const line of lines) {
    const p = parseProgressLine(line);
    if (!p.isItem) continue;
    if (wanted.has(p.state)) out.push(formatProgressLine(p.state, p.text));
  }
  return out.join('\n') + (out.length ? '\n' : '');
}

// ---------- Unified Diff Patch (git-style) helper ----------
// Minimal unified diff applier for single-file patches.
// Supports headers (diff --git, index, ---/+++), and @@ hunks with ' ', '+', '-' lines.
// Strictly validates that each hunk's header counts match the number of lines provided:
// - oldCount === (#context ' ' + #deletes '-')
// - newCount === (#context ' ' + #adds '+')
// Also enforces the "-- " rule for deleting markdown bullets that literally begin with "- ":
// deletion lines must start with "-- " to include the literal dash in the deleted content.
function applyUnifiedDiff(oldText, diffText) {
  const oldLines = String(oldText ?? '').split(/\n/);
  const diffLines = String(diffText ?? '').split(/\n/);
  const noCR = (s) => String(s ?? '').replace(/\r$/, '');
  // Collect hunks
  const hunks = [];
  let i = 0;
  while (i < diffLines.length) {
    const line = diffLines[i];
    // Skip file headers and metadata
    if (/^(diff --git |index |--- |\+\+\+ )/.test(line)) {
      i++;
      continue;
    }
    const m = line.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@.*$/);
    if (m) {
      const oldStart = parseInt(m[1], 10);
      const oldCount = m[2] ? parseInt(m[2], 10) : 1;
      const newStart = parseInt(m[3], 10);
      const newCount = m[4] ? parseInt(m[4], 10) : 1;
      i++;
      const hunkLines = [];
      while (i < diffLines.length && !/^@@/.test(diffLines[i])) {
        const hl = diffLines[i];
        if (/^(diff --git |index |--- |\+\+\+ )/.test(hl)) break;
        // Ignore end-of-file marker lines
        if (/^\\ No newline at end of file/.test(hl)) { i++; continue; }
        // Only accept proper hunk lines starting with ' ', '+', or '-'.
        // Ignore other metadata and blank lines.
        if (/^[ \+\-]/.test(hl)) {
          hunkLines.push(hl);
        }
        i++;
      }
      // Validate hunk counts strictly before applying
      let ctxCount = 0, addCount = 0, delCount = 0;
      for (const hl of hunkLines) {
        if (!hl || typeof hl !== 'string') continue;
        const p = hl[0];
        if (p === ' ') ctxCount++;
        else if (p === '+') addCount++;
        else if (p === '-') delCount++;
      }
      const oldSpan = ctxCount + delCount;
      const newSpan = ctxCount + addCount;
      if (oldSpan !== oldCount || newSpan !== newCount) {
        throw new Error(
          `Patch hunk header/count mismatch at @@ -${oldStart},${oldCount} +${newStart},${newCount} @@: ` +
          `have context=${ctxCount}, deletes=${delCount}, adds=${addCount}`
        );
      }
      hunks.push({ oldStart, oldCount, newStart, newCount, lines: hunkLines });
      continue;
    }
    // Otherwise ignore
    i++;
  }

  if (!hunks.length) {
    throw new Error('No hunks found in unified diff');
  }

  // Apply hunks in order
  const out = [];
  let origIndex = 0; // 0-based index into oldLines

  // Helper: find where to apply hunk based on its context (' ' and '-') lines
  function findHunkAnchor(startAt, hunk) {
    const expected = [];
    for (const hl of hunk.lines) {
      const p = hl[0];
      if (p === ' ' || p === '-') expected.push(noCR(hl.slice(1)));
    }
    if (!expected.length) return Math.max(0, hunk.oldStart - 1); // no anchor; fall back to header
    // Search from current position forward
    for (let pos = Math.max(0, startAt); pos + expected.length <= oldLines.length; pos++) {
      let ok = true;
      for (let k = 0; k < expected.length; k++) {
        if (noCR(oldLines[pos + k]) !== expected[k]) { ok = false; break; }
      }
      if (ok) return pos;
    }
    // As a fallback, search entire file
    for (let pos = 0; pos + expected.length <= oldLines.length; pos++) {
      let ok = true;
      for (let k = 0; k < expected.length; k++) {
        if (noCR(oldLines[pos + k]) !== expected[k]) { ok = false; break; }
      }
      if (ok) return pos;
    }
    // If not found, return header-based index so we still error with a clear message
    return Math.max(0, hunk.oldStart - 1);
  }

  for (const h of hunks) {
    const anchor = findHunkAnchor(origIndex, h);
    while (origIndex < anchor) {
      out.push(noCR(oldLines[origIndex]));
      origIndex++;
    }
    // Apply hunk at anchor
    for (const hl of h.lines) {
      const prefix = hl[0];
      const text = hl.slice(1);
      if (prefix === ' ') {
        const got = noCR(oldLines[origIndex]);
        if (got !== noCR(text)) {
          throw new Error(`Patch context mismatch: expected "${text}" got "${got}"`);
        }
        out.push(got);
        origIndex++;
      } else if (prefix === '-') {
        const got = noCR(oldLines[origIndex]);
        const want = noCR(text);
        if (got !== want) {
          // Enforce the special rule for markdown bullets that begin with "- ".
          // If the target line literally starts with "- " but the diff line omitted the
          // extra dash (i.e., diff line started with "- " instead of "-- "), instruct the caller.
          if (got.startsWith('- ') && (' ' + got.slice(2) === want || got.slice(1) === want)) {
            throw new Error(
              `Patch delete mismatch: deleting a markdown bullet must use "-- " (delete marker + literal dash). ` +
              `Provided line "${text}" does not include the literal dash; expected "-${text}"`
            );
          }
          throw new Error(`Patch delete mismatch: expected "${text}" got "${got}"`);
        } else {
          origIndex++;
        }
      } else if (prefix === '+') {
        out.push(noCR(text));
      } else {
        throw new Error('Invalid hunk line in patch');
      }
    }
  }
  while (origIndex < oldLines.length) {
    out.push(noCR(oldLines[origIndex]));
    origIndex++;
  }
  return out.join('\n');
}

function normalizeTaskText(s) {
  return String(s || '').trim().toLowerCase();
}

function extractExistingTasks(mdContent) {
  const set = new Set();
  const lines = String(mdContent || '').split(/\r?\n/);
  for (const line of lines) {
    const p = parseProgressLine(line);
    if (p.isItem && p.text) set.add(normalizeTaskText(p.text));
  }
  return set;
}

function defaultAgentMd(projectName) {
  return `# AGENTS.md\n\n- Project: ${projectName}\n- Purpose: Instructions for agents (style, best practices, personality)\n\nGuidance:\n- Keep responses concise, clear, and actionable.\n- Prefer safe defaults; avoid destructive actions.\n- Explain rationale briefly when ambiguity exists.\n`;
}

function defaultProgressMd() {
  return `# progress.md\n\n- [ ] Initial setup\n- [ ] Define tasks\n- [ ] Implement features\n- [ ] Review and refine\n`;
}

// ---------- Agent MD Examples (from example_agent_md.json) ----------
const EXAMPLES_JSON_PATH = path.resolve(__dirname, 'example_agent_md.json');

async function loadAgentExamplesJson() {
  try {
    const raw = await fs.promises.readFile(EXAMPLES_JSON_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    const theArt = parsed.the_art_of_writing_agents_md || parsed["the_art_of_writing_agents_md"] || '';
    const examples = Array.isArray(parsed.examples) ? parsed.examples : [];
    return { theArt, examples, rawParsed: parsed };
  } catch (err) {
    return { theArt: '', examples: [], rawParsed: null };
  }
}

function normalizeIncludeList(include) {
  if (include == null) return [];
  if (Array.isArray(include)) return include.map(String).map(s => s.trim()).filter(Boolean);
  // Accept JSON list passed as string (e.g., "[\"a\",\"b\"]")
  if (typeof include === 'string') {
    const s = include.trim();
    if (s.startsWith('[')) {
      try {
        const parsed = JSON.parse(s);
        if (Array.isArray(parsed)) {
          return parsed.map(String).map(v => v.trim()).filter(Boolean);
        }
      } catch {}
    }
    return [s].filter(Boolean);
  }
  return [];
}

function filterExamplesByInclude(examples, includeList) {
  if (!includeList.length) return [];
  const needles = includeList.map(s => s.toLowerCase());
  return examples.filter(ex => {
    const u = String(ex.usecase || '').toLowerCase();
    const t = String(ex.title || '').toLowerCase();
    return needles.some(n => u.includes(n) || t.includes(n));
  });
}

// Render tasks to nested Markdown for readability
function renderTasksMarkdown(rows) {
  const marker = (st) => {
    if (st === 'completed') return '[x]';
    if (st === 'in_progress') return '[~]';
    if (st === 'archived') return '[A]';
    return '[ ]';
  };
  // Build node map
  const nodes = new Map();
  for (const r of rows) {
    nodes.set(r.task_id, { task: r, children: [] });
  }
  const roots = [];
  for (const r of rows) {
    const node = nodes.get(r.task_id);
    const pid = r.parent_id || null;
    if (pid && nodes.has(pid)) nodes.get(pid).children.push(node); else roots.push(node);
  }
  const lines = [];
  function walk(node, depth) {
    const t = node.task;
    const indent = '  '.repeat(depth);
    lines.push(`${indent}- ${marker(t.status)} ${t.task_info} (${t.task_id})`);
    for (const ch of node.children) walk(ch, depth + 1);
  }
  for (const n of roots) walk(n, 0);
  return lines.join('\n');
}

// Build a fresh MCP server instance for each request (stateless mode)
function buildMcpServer(userId, userName) {
  const ops = userOps(userId, userName);
  const server = new Server(
    { name: 'mcp-http-agent-md', version: '0.1.0' },
    { capabilities: { tools: {} } }
  );

  // Describe available tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const agentsReminder = 'Reminder: Proactively update AGENTS.md to capture new project knowledge and evolving user preferences. Call get_agents_md_best_practices_and_examples to learn more.';
    const { examples } = await loadAgentExamplesJson();
    const available = examples.map(ex => `${ex.usecase || ''}${ex.title ? ` - ${ex.title}` : ''}`.trim()).filter(Boolean);
    const examplesToolDesc = [
      'Best practices and examples for AGENTS.md from example_agent_md.json.',
      available.length ? `Available examples: ${available.join('; ')}` : 'No examples found.',
      "Use 'include' to control examples: include='all' returns all examples; include can also be a string or a JSON/array of filters matching usecase/title.",
      "Default returns only 'the_art_of_writing_agents_md' (best-practices)."
    ].join(' ') + ' ' + agentsReminder;

    const meta = getProviderMeta();
    const hasTools = Array.isArray(meta.tools) && meta.tools.length > 0;
    const capLabels = {
      grounding: 'grounding (search)',
      crawling: 'crawling (web fetch)',
      code_execution: 'code_execution (run code)',
    };
    const shown = hasTools ? meta.tools.filter(t => capLabels[t]).map(t => capLabels[t]) : [];
    const toolsSentence = hasTools
      ? `Available subagent tools: ${shown.join(', ')}. Provide 'tool' as "all" or a subset of the above.`
      : `This subagent is configured with no tools; the 'tool' argument is ignored.`;

    // For provider 'mcp', surface MCP server tool short descriptions from subagent_config.json
    let mcpToolsHint = '';
    if (String(meta.key) === 'mcp') {
      try {
        const cfgPath = path.join(process.cwd(), 'subagent_config.json');
        const raw = fs.readFileSync(cfgPath, 'utf-8');
        const json = JSON.parse(raw);
        const servers = json?.mcpServers || {};
        const parts = [];
        for (const [name, cfg] of Object.entries(servers)) {
          const desc = String(cfg?.short_descriptions || '').trim();
          if (desc) {
            parts.push(`${name} (${desc})`);
          } else {
            // Warn in console so users can improve discoverability next time
            try { console.warn(`[mcp] short_descriptions missing for server '${name}' in subagent_config.json. Consider adding a concise hint (e.g., \"${name}(one‑line purpose)\").`); } catch {}
            parts.push(String(name));
          }
        }
        if (parts.length) mcpToolsHint = ` MCP tools (listed as tool_name (short description)): ${parts.join(', ')}. Provide 'tool' as "all" or a subset of the above.`;
      } catch {}
    }

    const result = { tools: [
      {
        name: 'list_projects',
        description: 'List accessible projects with id, name, owner_id, and permission.',
        inputSchema: { type: 'object', properties: {} }
      },
      {
        name: 'scratchpad_subagent',
        description: `Start a subagent (provider: ${meta.key}) to work on a scratchpad task. Required: project_id, scratchpad_id, task_id, prompt. Optional: sys_prompt, tool (array or "all"). ${toolsSentence}${mcpToolsHint} The server auto-appends the scratchpad's common_memory to the prompt when present. The subagent appends its answer to the task's scratchpad and logs any sources/code it used into comments. Note that the subagent's context is isolated: it can ONLY see common_memory without other project context; update common_memory if needed.`,
        inputSchema: {
          type: 'object',
          properties: {
            project_id: { type: 'string' },
            scratchpad_id: { type: 'string' },
            task_id: { type: 'string' },
            prompt: { type: 'string' },
            sys_prompt: { type: 'string' , description: 'Default: You are a general problem-solving agent with access to tool_list. Keep answers concise and accurate.'},
            tool: { oneOf: [ { type: 'string' }, { type: 'array', items: { type: 'string' } } ] }
          },
          required: ['project_id','scratchpad_id','task_id','prompt']
        }
      },
      {
        name: 'generate_task_ids',
        description: 'Generate N random 8-character task IDs (lowercase a-z0-9) not used by this user across any project.',
        inputSchema: {
          type: 'object',
          properties: {
            count: { type: 'number', minimum: 1, maximum: 200, default: 5 }
          }
        }
      },
      {
        name: 'progress_add',
        description: 'Add one or more structured project-level tasks. Provide an array of task objects. Each requires 8-char task_id (lowercase a-z0-9), task_info; optional parent_id (root task_id), status (pending|in_progress|completed|archived), extra_note. Optionally include a commit message via comment.' + agentsReminder,
        inputSchema: {
          type: 'object',
          properties: {
            project_id: { type: 'string' },
            item: {
              type: 'array', items: {
                type: 'object',
                properties: {
                  task_id: { type: 'string', minLength: 8, maxLength: 8 },
                  task_info: { type: 'string' },
                  parent_id: { type: 'string', minLength: 8, maxLength: 8, description: 'Root task_id this task belongs under; enables arbitrary-depth nesting.' },
                  status: { type: 'string', enum: ['pending','in_progress','completed','archived'] },
                  extra_note: { type: 'string' }
                },
                required: ['task_id','task_info']
              }
            },
            comment: { type: 'string' }
          },
          required: ['project_id', 'item']
        }
      },
      {
        name: 'progress_set_new_state',
        description: 'Update project-level tasks by task_id (8-char) or by matching task_info substring. Provide an array of match terms (ids or substrings). Can set state (pending|in_progress|completed|archived) and/or update fields task_info, parent_id, extra_note. Archiving or completing cascades to all children recursively. Lock rules: when a task or any ancestor is completed/archived, no edits are allowed except unlocking the task itself to pending/in_progress, and only if no ancestor is locked. Optionally include a commit message via comment.' + agentsReminder,
        inputSchema: {
          type: 'object',
          properties: {
            project_id: { type: 'string' },
            match: { type: 'array', items: { type: 'string' } },
            state: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'archived'] },
            task_info: { type: 'string' },
            parent_id: { type: 'string', minLength: 8, maxLength: 8 },
            extra_note: { type: 'string' },
            comment: { type: 'string' }
          },
          required: ['project_id', 'match']
        }
      },
      
      {
        name: 'init_project',
        description: 'Create or initialize a project with optional agent content and structured tasks. Task IDs must be exactly 8 lowercase a-z0-9 (e.g., abcd1234). Use parent_id to reference the root task for nesting. ' + agentsReminder,
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            agent: { type: 'string' },
            progress: { type: 'array', items: {
              type: 'object',
              properties: {
                task_id: { type: 'string', minLength: 8, maxLength: 8 },
                task_info: { type: 'string' },
                parent_id: { type: 'string', minLength: 8, maxLength: 8, description: 'Root task_id for this task; enables nested subtasks' },
                status: { type: 'string', enum: ['pending','in_progress','completed'] },
                extra_note: { type: 'string' }
              },
              required: ['task_id','task_info']
            } }
          },
          required: ['name']
        }
      },
      {
        name: 'delete_project',
        description: 'Delete a project by id (owner only).',
        inputSchema: {
          type: 'object',
          properties: { project_id: { type: 'string' } },
          required: ['project_id']
        }
      },
      {
        name: 'rename_project',
        description: 'Rename a project by id. Optionally include a commit message via comment. ' + agentsReminder,
        inputSchema: {
          type: 'object',
          properties: {
            project_id: { type: 'string' },
            newName: { type: 'string' },
            comment: { type: 'string' }
          },
          required: ['project_id', 'newName']
        }
      },
      {
        name: 'read_agent',
        description: 'Read AGENTS.md for a project. Optional: prepend line numbers with N|. ' + agentsReminder,
        inputSchema: {
          type: 'object',
          properties: {
            project_id: { type: 'string' },
            lineNumbers: { type: 'boolean', description: 'If true, prepend line numbers as N|line' }
          },
          required: ['project_id']
        }
      },
      {
        name: 'write_agent',
        description: 'Write AGENTS.md (mode=full|patch|diff). For patch/diff, provide a unified diff string: use hunk headers like @@ -l,c +l,c @@ and lines prefixed with space (context), + (add), - (delete). If deleting a markdown list item that starts with "- ", the diff line must start with "-- " (delete marker + literal dash). Lines must preserve leading spaces in context. Optionally include a commit message via comment.' + agentsReminder,
        inputSchema: {
          type: 'object',
          properties: {
            project_id: { type: 'string' },
            content: { type: 'string', description: 'Full file contents when mode=full (default)' },
            patch: { type: 'string', description: 'Unified diff (git-style) when mode=patch/diff' },
            mode: { type: 'string', enum: ['full', 'patch', 'diff'], description: 'Edit mode; defaults to full' },
            comment: { type: 'string' }
          },
          required: ['project_id']
        }
      },
      {
        name: 'list_project_logs',
        description: 'List commit logs (hash, message, created_at) for a project. Requires project_id.',
        inputSchema: { type: 'object', properties: { project_id: { type: 'string' } }, required: ['project_id'] }
      },
      {
        name: 'revert_project',
        description: 'Revert a project to a previous version by hash. Removes newer hashes from history (no branches). Requires project_id and hash.',
        inputSchema: { type: 'object', properties: { project_id: { type: 'string' }, hash: { type: 'string' } }, required: ['project_id', 'hash'] }
      },
      {
        name: 'read_progress',
        description: 'Read structured project-level tasks as JSON. Optionally filter by status (pending, in_progress, completed) or synonyms. ' + agentsReminder,
        inputSchema: {
          type: 'object',
          properties: {
            project_id: { type: 'string' },
            only: {
              oneOf: [
                { type: 'string', enum: ['todo', 'to-do', 'pending', 'in_progress', 'in-progress', 'done', 'completed'] },
                { type: 'array', items: { type: 'string' } }
              ]
            }
          },
          required: ['project_id']
        }
      },
      {
        name: 'get_agents_md_best_practices_and_examples',
        description: examplesToolDesc,
        inputSchema: {
          type: 'object',
          properties: {
            include: { oneOf: [ { type: 'string' }, { type: 'array', items: { type: 'string' } } ] }
          }
        }
      },
      {
        name: 'scratchpad_initialize',
        description: 'Start a temporary scratchpad for a one-off task that doesn\'t require documentation in agents.md/progress.md or won\'t need future reference by other agents—like side quests, experiments, or quick calculations outside the main project scope and shouldn\'t belong in the main project tracking. Use this to split the immediate task into manageable (up to 6) small steps (status: open|complete) and keep lightweight notes. The server generates and returns a unique scratchpad_id; use (project name, scratchpad_id) with review/update/append tools. Returns the full scratchpad (tasks + common_memory). If you want to store something non-volatile and is project-level, please edit agents.md or write into the extra_node entry of a task in progress.md.',
        inputSchema: {
          type: 'object',
          properties: {
            project_id: { type: 'string', description: 'Project id' },
            tasks: {
              type: 'array',
              maxItems: 6,
              items: {
                type: 'object',
                properties: {
                  task_id: { type: 'string' },
                  status: { type: 'string', enum: ['open','complete'] },
                  task_info: { type: 'string' },
                  scratchpad: { type: 'string' },
                  comments: { type: 'string' }
                },
                required: ['task_id','task_info']
              }
            }
          },
          required: ['project_id','tasks']
        }
      },
      {
        name: 'review_scratchpad',
        description: 'Read‑only view of a scratchpad for a one‑off task. Provide (project_id, scratchpad_id). By default returns tasks (max 6) and common_memory. Optionally control output with IncludeCM (boolean) and IncludeTk (array of task_id or task_info needles). If neither is provided, outputs everything; otherwise includes only requested fields and filters tasks.',
        inputSchema: {
          type: 'object',
          properties: {
            project_id: { type: 'string' },
            scratchpad_id: { type: 'string' },
            IncludeCM: { type: 'boolean', description: 'When true, include common_memory in the response. If omitted and IncludeTk is set, common_memory is omitted.' },
            IncludeTk: {
              type: 'array',
              items: { type: 'string' },
              description: 'Array of task_id values or task_info needles to include. Matches task_id (case-insensitive) or task_info substring (case-insensitive). If omitted, no tasks are returned unless IncludeCM and IncludeTk are both omitted.'
            }
          },
          required: ['project_id','scratchpad_id']
        }
      },
      {
        name: 'scratchpad_update_task',
        description: 'Update existing scratchpad tasks by task_id to reflect progress on a temporary problem. You can change status (open|complete), task_info, scratchpad (quick notes), and comments. If you need a different set of tasks, create a new scratchpad and use its scratchpad_id. Returns the updated scratchpad.',
        inputSchema: {
          type: 'object',
          properties: {
            project_id: { type: 'string' },
            scratchpad_id: { type: 'string' },
            updates: {
              type: 'array',
              minItems: 1,
              items: {
                type: 'object',
                properties: {
                  task_id: { type: 'string' },
                  status: { type: 'string', enum: ['open','complete'] },
                  task_info: { type: 'string' },
                  scratchpad: { type: 'string' },
                  comments: { type: 'string' }
                },
                required: ['task_id']
              }
            }
          },
          required: ['project_id','scratchpad_id','updates']
        }
      },
      {
        name: 'scratchpad_append_common_memory',
        description: 'Append notes to the scratchpad\'s shared common_memory (append‑only). Use this to log core thinking steps, findings, and conclusions for a one‑off task without editing progress.md. Accepts a string or array of strings and returns the updated scratchpad. If you want to store something non-volatile, please edit agents.md or write into the extra_node entry of a task in progress.md. ',
        inputSchema: {
          type: 'object',
          properties: {
            project_id: { type: 'string' },
            scratchpad_id: { type: 'string' },
            append: { oneOf: [ { type: 'string' }, { type: 'array', items: { type: 'string' } } ] }
          },
          required: ['project_id','scratchpad_id','append']
        }
      },
      {
        name: 'scratchpad_subagent_status',
        description: 'Check subagent run status by run_id for a project. If status is success or failure, return immediately. If pending/in_progress, poll up to 5 times at 5s intervals until it changes; otherwise return the latest status.',
        inputSchema: {
          type: 'object',
          properties: {
            project_id: { type: 'string' },
            run_id: { type: 'string' }
          },
          required: ['project_id','run_id']
        }
      }
    ]};

    // Hide external-AI tools when USE_EXTERNAL_AI=false
    const externalAi = String(process.env.USE_EXTERNAL_AI || '').toLowerCase() !== 'false' ? true : false;
    if (!externalAi) {
      result.tools = result.tools.filter(t => t.name !== 'scratchpad_subagent' && t.name !== 'scratchpad_subagent_status');
    }
    return result;
  });

  // Tool invocation handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    async function okText(text) {
      return { content: [{ type: 'text', text }] };
    }

    switch (name) {
      case 'list_projects': {
        const rows = await ops.listProjects();
        const projects = rows.map(r => ({ id: r.id, name: r.name, owner_id: r.owner_id, permission: r.permission, read_only: r.permission === 'ro' }));
        return okText(JSON.stringify({ projects }));
      }
      case 'init_project': {
        const { name: projName, agent, progress } = args || {};
        try {
          if (!validateProjectName(projName)) {
            return okText(JSON.stringify({ error: 'invalid_request', message: 'Invalid project name. Allowed: letters, digits, space, . _ -' }));
          }
          const result = await ops.initProject(projName, { agent, progress });
          // Tell agents about task_id constraint
          const finalResult = { status: 'ok', note: 'Tasks use exactly 8 lowercase a-z0-9 IDs (e.g., abcd1234).', ...result };
          return okText(JSON.stringify(finalResult));
        } catch (err) {
          const msg = String(err?.message || err || 'init failed');
          const code = /user not authenticated/i.test(msg) ? 'unauthorized' : (/project name required/i.test(msg) ? 'invalid_request' : 'init_failed');
          return okText(JSON.stringify({ error: code, message: msg }));
        }
      }
      case 'delete_project': {
        const { project_id } = args || {};
        try {
          const acc = await dbResolveProjectAccess(userId, String(project_id || ''));
          if (!acc) return okText(JSON.stringify({ error: 'project_not_found', message: 'project not found' }));
          if (acc.permission !== 'owner') return okText(JSON.stringify({ error: 'forbidden', message: 'Only the project owner can delete the project' }));
          await ops.removeProject(String(project_id || ''));
          return okText('deleted');
        } catch (err) {
          const msg = String(err?.message || err || 'delete failed');
          const code = /project not found/i.test(msg) ? 'project_not_found' : 'delete_failed';
          return okText(JSON.stringify({ error: code, message: msg }));
        }
      }
      case 'rename_project': {
        const { project_id, newName, comment } = args || {};
        try {
          const acc = await dbResolveProjectAccess(userId, String(project_id || ''));
          if (!acc) return okText(JSON.stringify({ error: 'project_not_found', message: 'project not found' }));
          if (acc.permission !== 'owner') return okText(JSON.stringify({ error: 'forbidden', message: 'Only the project owner can rename the project' }));
          const result = await ops.renameProject(String(project_id || ''), String(newName || ''));
          try {
            const hash = await vcCommitProject(acc.owner_id, acc.project_id, { action: 'rename_project', comment, modifiedBy: userId });
            return okText(JSON.stringify({ ...result, hash }));
          } catch {
            return okText(JSON.stringify(result));
          }
        } catch (err) {
          const msg = String(err?.message || err || 'rename failed');
          const code = /project not found/i.test(msg) ? 'project_not_found' : 'rename_failed';
          return okText(JSON.stringify({ error: code, message: msg }));
        }
      }
      case 'read_agent': {
        const { project_id, lineNumbers } = args || {};
        try {
          const content = await ops.readDoc(String(project_id || ''), 'agent');
          if (lineNumbers) {
            const lines = String(content ?? '').split('\n');
            const numbered = lines.map((l, idx) => `${idx + 1}|${l.replace(/\r$/, '')}`).join('\n');
            return okText(numbered);
          }
          return okText(content);
        } catch (err) {
          const msg = String(err?.message || err);
          const code = /project not found/i.test(msg) ? 'project_not_found' : 'read_failed';
          return okText(JSON.stringify({ error: code, message: msg }));
        }
      }
      case 'write_agent': {
        const { project_id } = args || {};
        let { content, patch, mode, comment } = args || {};
        const editMode = String(mode || (patch ? 'patch' : 'full')).toLowerCase();
        try {
          const acc = await dbResolveProjectAccess(userId, String(project_id || ''));
          if (!acc) return okText(JSON.stringify({ error: 'project_not_found', message: 'project not found' }));
          if (acc.permission === 'ro') return okText(JSON.stringify({ error: 'read_only_project', message: 'You have read-only access to this project.' }));

          if (editMode === 'full') {
            if (typeof content !== 'string') throw new Error('content (string) required for full mode');
            await dbWriteDoc(acc.owner_id, acc.project_id, 'agent', content);
            let hash = null;
            try { hash = await vcCommitProject(acc.owner_id, acc.project_id, { action: 'write_agent', comment, modifiedBy: userId }); } catch {}
            return okText(JSON.stringify({ mode: 'full', status: 'ok', bytes: Buffer.byteLength(content, 'utf8'), hash }));
          }
          if (editMode === 'patch' || editMode === 'diff') {
            if (typeof patch !== 'string') throw new Error('patch (unified diff string) required for patch/diff mode');
            const current = await dbReadDoc(acc.owner_id, acc.project_id, 'agent');
            const updated = applyUnifiedDiff(current, patch);
            await dbWriteDoc(acc.owner_id, acc.project_id, 'agent', updated);
            let hash = null;
            try { hash = await vcCommitProject(acc.owner_id, acc.project_id, { action: 'write_agent', comment, modifiedBy: userId }); } catch {}
            return okText(JSON.stringify({ mode: 'patch', status: 'ok', oldBytes: Buffer.byteLength(current, 'utf8'), newBytes: Buffer.byteLength(updated, 'utf8'), hash }));
          }
          throw new Error(`Unknown mode: ${mode}`);
        } catch (err) {
          const msg = String(err?.message || err || 'write failed');
          const code = /project_not_found/i.test(msg) || /project not found/i.test(msg) ? 'project_not_found' : (/patch/i.test(msg) ? 'patch_failed' : (/read_only_project/i.test(msg) ? 'read_only_project' : 'write_failed'));
          const suggest = code === 'project_not_found' ? 'init_project' : (code === 'patch_failed' ? 'read_agent' : undefined);
          const payload = { error: code, message: msg };
          if (suggest) payload.suggest = suggest;
          return okText(JSON.stringify(payload));
        }
      }
      case 'read_progress': {
        const { project_id, only } = args || {};
        const list = Array.isArray(only) ? only : (typeof only === 'undefined' ? [] : [only]);
        let wanted = list.map(normalizeStateFilter).filter(Boolean);
        // Default excludes archived at DB layer when wanted is empty.
        // If a filter includes 'archived', include archived alongside other requested statuses.
        const filterProvided = typeof only !== 'undefined';
        try {
          const acc = await dbResolveProjectAccess(userId, String(project_id || ''));
          if (!acc) return okText(JSON.stringify({ error: 'project_not_found', message: 'project not found' }));
          // If a filter was provided but normalized to empty (no recognized statuses), return empty set.
          if (filterProvided && wanted.length === 0) {
            return okText(JSON.stringify({ tasks: [], markdown: '' }));
          }
          const rows = await dbListTasks(acc.owner_id, acc.project_id, { only: wanted });
          const markdown = renderTasksMarkdown(rows);
          return okText(JSON.stringify({ tasks: rows, markdown }));
        } catch (err) {
          const msg = String(err?.message || err);
          const code = /project not found/i.test(msg) ? 'project_not_found' : 'read_failed';
          return okText(JSON.stringify({ error: code, message: msg }));
        }
      }
      
      case 'get_agents_md_best_practices_and_examples': {
        const { include } = args || {};
        const { theArt, examples, rawParsed } = await loadAgentExamplesJson();
        if (!rawParsed) {
          return okText(JSON.stringify({ error: 'examples_file_not_found', message: 'example_agent_md.json not found or invalid', the_art_of_writing_agents_md: '', examples: [] }));
        }
        const includeList = normalizeIncludeList(include);
        // Default: only best-practices
        let result = { the_art_of_writing_agents_md: theArt, examples: [] };
        // If include contains 'all', return all examples
        const wantsAll = includeList.map(s => s.toLowerCase()).includes('all');
        if (wantsAll) {
          result = { the_art_of_writing_agents_md: theArt, examples };
        } else if (includeList.length) {
          const filtered = filterExamplesByInclude(examples, includeList);
          result = { the_art_of_writing_agents_md: theArt, examples: filtered };
        }
        return okText(JSON.stringify(result));
      }
      case 'scratchpad_initialize': {
        const { project_id, tasks } = args || {};
        try {
          // Server generates scratchpad_id
          const sp = await dbInitScratchpad(userId, String(project_id || ''), '', Array.isArray(tasks) ? tasks : []);
          return okText(JSON.stringify(sp));
        } catch (err) {
          const msg = String(err?.message || err || 'init failed');
          const code = /project not found/i.test(msg)
            ? 'project_not_found'
            : (/failed_to_generate_scratchpad_id/i.test(msg) ? 'init_failed' : 'init_failed');
          return okText(JSON.stringify({ error: code, message: msg }));
        }
      }
      case 'review_scratchpad': {
        const { project_id, scratchpad_id, IncludeCM, IncludeTk } = args || {};
        try {
          const sp = await dbGetScratchpad(userId, String(project_id || ''), String(scratchpad_id || ''));

          // If neither IncludeCM nor IncludeTk is provided, return full content (backwards-compatible default)
          const includeAllByDefault = (typeof IncludeCM === 'undefined' && typeof IncludeTk === 'undefined');
          if (includeAllByDefault) {
            return okText(JSON.stringify({ tasks: sp.tasks || [], common_memory: sp.common_memory || '' }));
          }

          const result = {};

          // Conditionally include common_memory
          if (IncludeCM === true) {
            result.common_memory = sp.common_memory || '';
          }

          // Conditionally include filtered tasks
          if (Array.isArray(IncludeTk)) {
            const needles = IncludeTk.map(v => String(v || '')).filter(Boolean).map(v => v.toLowerCase());
            const hasNeedles = needles.length > 0;
            const tasks = Array.isArray(sp.tasks) ? sp.tasks : [];
            if (hasNeedles) {
              const filtered = tasks.filter(t => {
                const tid = String(t?.task_id || '').toLowerCase();
                const info = String(t?.task_info || '').toLowerCase();
                // Match task_id equality or task_info substring (case-insensitive)
                return needles.some(n => tid === n || (info && info.includes(n)));
              });
              result.tasks = filtered;
            } else {
              result.tasks = [];
            }
          }

          return okText(JSON.stringify(result));
        } catch (err) {
          const msg = String(err?.message || err || 'review failed');
          const code = /project not found/i.test(msg) ? 'project_not_found' : (/scratchpad not found/i.test(msg) ? 'scratchpad_not_found' : 'review_failed');
          return okText(JSON.stringify({ error: code, message: msg }));
        }
      }
      case 'scratchpad_update_task': {
        const { project_id, scratchpad_id, updates } = args || {};
        try {
          const res = await dbUpdateScratchpadTasks(userId, String(project_id || ''), String(scratchpad_id || ''), Array.isArray(updates) ? updates : []);
          return okText(JSON.stringify(res));
        } catch (err) {
          const msg = String(err?.message || err || 'update failed');
          const code = /project not found/i.test(msg) ? 'project_not_found' : (/scratchpad not found/i.test(msg) ? 'scratchpad_not_found' : 'update_failed');
          return okText(JSON.stringify({ error: code, message: msg }));
        }
      }
      case 'scratchpad_append_common_memory': {
        const { project_id, scratchpad_id, append } = args || {};
        try {
          const sp = await dbAppendScratchpadCommonMemory(userId, String(project_id || ''), String(scratchpad_id || ''), append);
          return okText(JSON.stringify(sp));
        } catch (err) {
          const msg = String(err?.message || err || 'append failed');
          const code = /project not found/i.test(msg) ? 'project_not_found' : (/scratchpad not found/i.test(msg) ? 'scratchpad_not_found' : 'append_failed');
          return okText(JSON.stringify({ error: code, message: msg }));
        }
      }
      case 'scratchpad_subagent': {
        const { project_id, scratchpad_id, task_id, prompt, sys_prompt, tool } = args || {};
        try {
          const externalAi = String(process.env.USE_EXTERNAL_AI || '').toLowerCase() !== 'false';
          if (!externalAi) {
            return okText(JSON.stringify({ error: 'external_ai_disabled', message: 'scratchpad_subagent is disabled (USE_EXTERNAL_AI=false)' }));
          }
          const result = await runScratchpadSubagent(userId, { project_id: String(project_id || ''), scratchpad_id, task_id, prompt, sys_prompt, tool });
          return okText(JSON.stringify(result));
        } catch (err) {
          const msg = String(err?.message || err || 'subagent failed');
          return okText(JSON.stringify({ run_id: `run-${Math.random().toString(36).slice(2, 10)}`, status: 'failure', error: msg }));
        }
      }
      case 'scratchpad_subagent_status': {
        const { project_id, run_id } = args || {};
        try {
          const externalAi = String(process.env.USE_EXTERNAL_AI || '').toLowerCase() !== 'false';
          if (!externalAi) {
            return okText(JSON.stringify({ error: 'external_ai_disabled', message: 'scratchpad_subagent_status is disabled (USE_EXTERNAL_AI=false)' }));
          }
          const pollable = new Set(['pending','in_progress']);
          const maxChecks = 5;
          const waitMs = 5000;
          let info = await dbGetSubagentRun(userId, String(project_id || ''), String(run_id || ''));
          if (!info) return okText(JSON.stringify({ error: 'run_not_found', message: 'Unknown run_id for this project', run_id }));
          if (!pollable.has(info.status)) return okText(JSON.stringify(info));
          for (let i = 0; i < maxChecks; i++) {
            await new Promise(r => setTimeout(r, waitMs));
            info = await dbGetSubagentRun(userId, String(project_id || ''), String(run_id || ''));
            if (!info) return okText(JSON.stringify({ error: 'run_not_found', message: 'Unknown run_id for this project', run_id }));
            if (!pollable.has(info.status)) break;
          }
          return okText(JSON.stringify(info));
        } catch (err) {
          const msg = String(err?.message || err || 'status failed');
          return okText(JSON.stringify({ error: 'status_failed', message: msg }));
        }
      }
      case 'progress_add': {
        const { project_id, item, comment } = args || {};
        try {
          const acc = await dbResolveProjectAccess(userId, String(project_id || ''));
          if (!acc) return okText(JSON.stringify({ error: 'project_not_found', message: 'project not found' }));
          if (acc.permission === 'ro') return okText(JSON.stringify({ error: 'read_only_project', message: 'You have read-only access to this project.' }));
          // Enforce arrays: either an array directly, or a JSON string that parses to an array
          let incoming;
          if (Array.isArray(item)) {
            incoming = item;
          } else if (typeof item === 'string') {
            try {
              const parsed = JSON.parse(item.trim());
              if (!Array.isArray(parsed)) {
                return okText(JSON.stringify({ error: 'invalid_request', message: 'item must be an array of task objects (JSON array supported when string)' }));
              }
              incoming = parsed;
            } catch {
              return okText(JSON.stringify({ error: 'invalid_request', message: 'item must be valid JSON array when provided as a string' }));
            }
          } else {
            return okText(JSON.stringify({ error: 'invalid_request', message: 'item must be an array of task objects' }));
          }

          const { tasks, invalid } = validateAndNormalizeTasks(incoming);
          if (!tasks.length && invalid.length) {
            return okText(JSON.stringify({ added: [], exists: [], invalid, notice: 'No valid tasks to add' }));
          }
          const res = await dbAddTasks(acc.owner_id, acc.project_id, tasks);
          let hash = null;
          if ((res.added?.length || 0) > 0) {
            try { hash = await vcCommitProject(acc.owner_id, acc.project_id, { action: 'progress_add', comment, modifiedBy: userId }); } catch {}
          }
          return okText(JSON.stringify({ added: res.added, skipped: res.exists, invalid, hash }));
        } catch (err) {
          const msg = String(err?.message || err || 'add failed');
          const code = /project not found/i.test(msg) ? 'project_not_found' : 'add_failed';
          return okText(JSON.stringify({ error: code, message: msg }));
        }
      }
      case 'progress_set_new_state': {
        const { project_id, match, state, task_info, parent_id, extra_note, comment } = args || {};
        try {
          const acc = await dbResolveProjectAccess(userId, String(project_id || ''));
          if (!acc) return okText(JSON.stringify({ error: 'project_not_found', message: 'project not found' }));
          if (acc.permission === 'ro') return okText(JSON.stringify({ error: 'read_only_project', message: 'You have read-only access to this project.' }));
          const normalizedState = typeof state === 'undefined' ? undefined : normalizeStatus(state);
          // Enforce arrays: either an array directly, or a JSON string that parses to an array of strings
          let matchList = [];
          if (Array.isArray(match)) {
            matchList = match.map(v => (typeof v === 'string' ? v.trim() : '')).filter(Boolean);
          } else if (typeof match === 'string') {
            try {
              const parsed = JSON.parse(match.trim());
              if (!Array.isArray(parsed)) {
                return okText(JSON.stringify({ error: 'invalid_request', message: 'match must be an array of strings (JSON array supported when string)' }));
              }
              matchList = parsed.map(v => (typeof v === 'string' ? v.trim() : '')).filter(Boolean);
            } catch {
              return okText(JSON.stringify({ error: 'invalid_request', message: 'match must be a valid JSON array of strings when provided as a string' }));
            }
          } else {
            return okText(JSON.stringify({ error: 'invalid_request', message: 'match must be an array of strings' }));
          }
          if (!matchList.length) throw new Error('match required');
          const ids = matchList.filter(validateTaskId);
          const terms = matchList.filter(s => !validateTaskId(s));
          const res = await dbSetTasksState(acc.owner_id, acc.project_id, { matchIds: ids, matchText: terms, state: normalizedState, task_info, parent_id, extra_note });
          if (res.changedIds.length === 0) {
            if ((res.notMatched?.length || 0) > 0 && (res.forbidden?.length || 0) === 0) {
              return okText(JSON.stringify({ error: 'task_not_found', message: 'No matching tasks found for provided match terms', notMatched: res.notMatched }));
            }
            return okText(JSON.stringify({ changed: [], state: normalizedState, notMatched: res.notMatched, forbidden: res.forbidden, notice: 'No items changed. Items may be locked or list changed. Pull updated list?', suggest: 'read_progress' }));
          }
          let hash = null;
          try { hash = await vcCommitProject(acc.owner_id, acc.project_id, { action: 'progress_set_new_state', comment, modifiedBy: userId }); } catch {}
          return okText(JSON.stringify({ changed: res.changedIds, state: normalizedState, notMatched: res.notMatched, forbidden: res.forbidden, hash }));
        } catch (err) {
          const msg = String(err?.message || err || 'set_state failed');
          const code = /project not found/i.test(msg) ? 'project_not_found' : 'update_failed';
          return okText(JSON.stringify({ error: code, message: msg }));
        }
      }
      case 'generate_task_ids': {
        const { count } = args || {};
        const n = Math.min(200, Math.max(1, Number.isFinite(count) ? Math.floor(count) : 5));
        const existing = new Set((await dbListUserTaskIds(userId)).map(String));
        const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
        function rand8() {
          let s = '';
          for (let i = 0; i < 8; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
          return s;
        }
        const ids = new Set();
        let attempts = 0;
        const maxAttempts = n * 1000;
        while (ids.size < n && attempts < maxAttempts) {
          attempts++;
          const id = rand8();
          if (!existing.has(id) && !ids.has(id)) ids.add(id);
        }
        if (ids.size < n) {
          return okText(JSON.stringify({ error: 'generation_exhausted', message: 'Unable to generate enough unique IDs', generated: Array.from(ids.values()) }));
        }
        return okText(JSON.stringify({ ids: Array.from(ids.values()) }));
      }
      case 'list_project_logs': {
        const { project_id } = args || {};
        try {
          const acc = await dbResolveProjectAccess(userId, String(project_id || ''));
          if (!acc) return okText(JSON.stringify({ error: 'project_not_found', message: 'project not found' }));
          const logs = await vcListLogs(acc.owner_id, acc.project_id);
          return okText(JSON.stringify({ logs }));
        } catch (err) {
          const msg = String(err?.message || err || 'list logs failed');
          const code = /project not found/i.test(msg) ? 'project_not_found' : 'list_failed';
          return okText(JSON.stringify({ error: code, message: msg }));
        }
      }
      case 'revert_project': {
        const { project_id, hash } = args || {};
        try {
          const acc = await dbResolveProjectAccess(userId, String(project_id || ''));
          if (!acc) return okText(JSON.stringify({ error: 'project_not_found', message: 'project not found' }));
          if (acc.permission === 'ro') return okText(JSON.stringify({ error: 'read_only_project', message: 'You have read-only access to this project.' }));
          const res = await vcRevertProject(acc.owner_id, acc.project_id, String(hash || ''), userId);
          return okText(JSON.stringify({ project_id: acc.project_id, hash: res.hash }));
        } catch (err) {
          const msg = String(err?.message || err || 'revert failed');
          let code = 'revert_failed';
          if (/project not found/i.test(msg)) code = 'project_not_found';
          else if (/read_only_project/i.test(msg)) code = 'read_only_project';
          else if (/hash_not_found/i.test(msg)) code = 'hash_not_found';
          return okText(JSON.stringify({ error: code, message: msg }));
        }
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  });

  return server;
}

// Express app for Streamable HTTP transport (stateless mode)
const app = express();
app.use(cors({
  origin: '*',
  exposedHeaders: ['Mcp-Session-Id'],
  allowedHeaders: ['Content-Type', 'mcp-session-id', 'Authorization']
}));
app.use(express.json({ limit: '2mb' }));

// handler inlined in route below to include user context

// POST /mcp now requires apiKey via query or Bearer
app.post(BASE_PATH, apiKeyQueryMiddleware, async (req, res) => {
  if (req.user?.id) res.setHeader('X-User-Id', req.user.id);
  // Rebuild server with user context
  try {
    const server = buildMcpServer(req.user?.id, req.user?.name || null);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error('Error handling MCP request:', error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      });
    }
  }
});

// GET/DELETE not supported in stateless JSON mode
app.get(BASE_PATH, async (req, res) => {
  res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
});
app.delete(BASE_PATH, async (req, res) => {
  res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
});


// Root info
app.get('/', (req, res) => {
  res.type('text/plain').send(
    `mcp-http-agent-md MCP server. POST ${BASE_PATH}?apiKey=... for MCP JSON-RPC.`
  );
});

// Admin auth router under /auth (Bearer MAIN_API_KEY)
app.use('/auth', buildAuthRouter());

// Projects REST API (admin + user apiKey)
// Mount under /project: exposes /project/list, /project/share, /project/status
app.use('/project', buildProjectsRouter());

// Start server (with Next.js UI mounted at /ui)
async function start() {
  const dev = process.env.NODE_ENV !== 'production';
  const nextDir = path.join(__dirname, 'src', 'ui');
  const nextApp = next({ dev, dir: nextDir });
  const handle = nextApp.getRequestHandler();
  await nextApp.prepare();

  // Delegate all /ui* (including /ui/_next assets) directly to Next (basePath=/ui)
  app.all('/ui*', (req, res) => {
    //console.log('[ui] passthrough', req.method, req.originalUrl); // for debug
    return handle(req, res);
  });

  app.listen(PORT, HOST, () => {
    console.log(`MCP server listening on http://${HOST}:${PORT}${BASE_PATH}?apiKey=XXXX`);
    console.log(`Admin auth endpoint: http://${HOST}:${PORT}/auth (Bearer MAIN_API_KEY)`);
    console.log(`UI available at: http://${HOST}:${PORT}/ui`);
  });
}

start().catch(err => {
  console.error('Failed to start server (Next or Express init error):', err);
  process.exit(1);
});
