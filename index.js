import express from 'express';
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

// Load environment from .env (no external dependency)
function loadEnvFromDotenv() {
  try {
    const envPath = path.resolve(process.cwd(), '.env');
    if (!fs.existsSync(envPath)) return;
    const content = fs.readFileSync(envPath, 'utf8');
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const m = line.match(/^\s*(?:export\s+)?([^=\s]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const key = m[1];
      let val = m[2] ?? '';
      // Strip surrounding quotes if present
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith('\'') && val.endsWith('\''))) {
        val = val.slice(1, -1);
      }
      if (typeof process.env[key] === 'undefined') {
        process.env[key] = val;
      }
    }
  } catch {
    // Best-effort: ignore parse errors
  }
}

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
} from './src/db.js';

// Utility: sanitize and validate project name (letters, digits, space, dot, underscore, hyphen)
function validateProjectName(name) {
  if (typeof name !== 'string') return false;
  const trimmed = name.trim();
  if (trimmed.length === 0) return false;
  // Allow common characters and spaces; disallow control characters and symbols
  return /^[A-Za-z0-9._\- ]{1,100}$/.test(trimmed);
}
// DB-backed project and file operations (per-user)
function userOps(userId) {
  return {
    async listProjects() {
      return dbListProjects(userId);
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
          const addRes = await dbAddTasks(userId, name, valid.tasks);
          res.added = addRes.added;
          res.exists = addRes.exists;
        } else {
          res.added = [];
          res.exists = [];
        }
      }
      return res;
    },
    async removeProject(name) {
      if (!validateProjectName(name)) throw new Error('Invalid project name');
      await dbDeleteProject(userId, name);
    },
    async renameProject(oldName, newName) {
      if (!validateProjectName(oldName) || !validateProjectName(newName)) throw new Error('Invalid project name');
      return dbRenameProject(userId, oldName, newName);
    },
    async readDoc(name, which) {
      if (!validateProjectName(name)) throw new Error('Invalid project name');
      return dbReadDoc(userId, name, which);
    },
    async writeDoc(name, which, content) {
      if (!validateProjectName(name)) throw new Error('Invalid project name');
      await dbWriteDoc(userId, name, which, content);
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
          // Heuristic: many generators forget the extra '-' when deleting a markdown bullet.
          // If the file has '-' + want, treat this as a context-keep (not a deletion).
          if (got === '-' + want) {
            // Keep the line as-is instead of deleting
            out.push(got);
            origIndex++;
          } else {
            throw new Error(`Patch delete mismatch: expected "${text}" got "${got}"`);
          }
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

async function progressAddItem(projectName, itemText, ops) {
  if (!validateProjectName(projectName)) throw new Error('Invalid project name');
  if (!itemText || typeof itemText !== 'string') throw new Error('item text required');
  let content = '';
  try {
    content = await ops.readDoc(projectName, 'progress');
  } catch {
    content = defaultProgressMd();
  }
  const existing = extractExistingTasks(content);
  const norm = normalizeTaskText(itemText);
  if (existing.has(norm)) {
    return { added: null, exists: true, item: itemText, notice: 'Task already exists. Not added.' };
  }
  const endsWithNewline = content.endsWith('\n');
  const addition = formatProgressLine('pending', itemText);
  const updated = content + (endsWithWith(content, '\n\n') ? '' : endsWithNewline ? '' : '\n') + addition + '\n';
  await ops.writeDoc(projectName, 'progress', updated);
  return { added: itemText };
}

async function progressAddItems(projectName, items, ops) {
  if (!validateProjectName(projectName)) throw new Error('Invalid project name');
  const list = (items || []).filter(v => typeof v === 'string' && v.trim().length > 0);
  if (!list.length) throw new Error('items array is empty');
  let content = '';
  try {
    content = await ops.readDoc(projectName, 'progress');
  } catch {
    content = defaultProgressMd();
  }
  const existing = extractExistingTasks(content);
  const seenInput = new Set();
  const toAdd = [];
  const skipped = [];
  for (const raw of list) {
    const norm = normalizeTaskText(raw);
    if (!norm) continue;
    if (seenInput.has(norm) || existing.has(norm)) {
      skipped.push(raw);
      continue;
    }
    seenInput.add(norm);
    toAdd.push(raw.trim());
  }
  if (!toAdd.length) {
    return { added: [], skipped, notice: 'No new tasks added. All provided tasks already exist or are duplicates.' };
  }
  const endsWithNewline = content.endsWith('\n');
  const additions = toAdd.map(v => formatProgressLine('pending', v)).join('\n') + '\n';
  const updated = content + (endsWithWith(content, '\n\n') ? '' : endsWithNewline ? '' : '\n') + additions;
  await ops.writeDoc(projectName, 'progress', updated);
  return { added: toAdd, skipped };
}

function endsWithWith(s, suffix) {
  return s.endsWith(suffix);
}

async function progressSetState(projectName, opts, ops) {
  const { match, state } = opts || {};
  if (!validateProjectName(projectName)) throw new Error('Invalid project name');
  if (!['pending', 'in_progress', 'completed'].includes(state)) throw new Error('invalid state');
  const maybeList = coerceJsonArray(match);
  const matchList = (maybeList || (match == null ? [] : [match]))
    .map(v => (typeof v === 'string' ? v.trim() : ''))
    .filter(v => v.length > 0);
  if (!matchList.length) throw new Error('match required');

  let content = '';
  try {
    content = await ops.readDoc(projectName, 'progress');
  } catch {
    throw new Error('progress.md not found');
  }

  const lines = content.split(/\r?\n/);
  let itemIdx = 0;
  const changedSet = new Set();
  const foundFlags = matchList.map(() => false);
  const matchedByTerm = matchList.map(() => []);
  for (let i = 0; i < lines.length; i++) {
    const parsed = parseProgressLine(lines[i]);
    if (!parsed.isItem) continue;
    itemIdx++;
    const lowerText = parsed.text.toLowerCase();
    let matchedAny = false;
    for (let t = 0; t < matchList.length; t++) {
      const term = matchList[t];
      if (lowerText.includes(term.toLowerCase())) {
        foundFlags[t] = true;
        matchedByTerm[t].push(itemIdx);
        matchedAny = true;
      }
    }
    if (matchedAny) {
      lines[i] = formatProgressLine(state, parsed.text);
      changedSet.add(itemIdx);
    }
  }

  const changed = Array.from(changedSet.values());
  const notMatched = matchList.filter((_, i) => !foundFlags[i]);
  if (!changed.length) {
    return {
      changed: [],
      state,
      notMatched,
      notice: 'No items matched by text. The list may have changed. Pull updated list again?',
      suggest: 'read_progress'
    };
  }
  const updated = lines.join('\n');
  await ops.writeDoc(projectName, 'progress', updated);
  return { changed, state, notMatched };
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
function buildMcpServer(userId) {
  const ops = userOps(userId);
  const server = new Server(
    { name: 'mcp-http-agent-md', version: '0.0.1' },
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

    return { tools: [
      {
        name: 'list_projects',
        description: 'List all project names',
        inputSchema: { type: 'object', properties: {} }
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
        description: 'Add one or more structured project-level tasks. Provide an array of task objects. Each requires 8-char task_id (lowercase a-z0-9), task_info; optional parent_id (root task_id), status (pending|in_progress|completed|archived), extra_note. ' + agentsReminder,
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
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
            }
          },
          required: ['name', 'item']
        }
      },
      {
        name: 'progress_set_new_state',
        description: 'Update project-level tasks by task_id (8-char) or by matching task_info substring. Provide an array of match terms (ids or substrings). Can set state (pending|in_progress|completed|archived) and/or update fields task_info, parent_id, extra_note. Archiving or completing cascades to all children recursively. Lock rules: when a task or any ancestor is completed/archived, no edits are allowed except unlocking the task itself to pending/in_progress, and only if no ancestor is locked. ' + agentsReminder,
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            match: { type: 'array', items: { type: 'string' } },
            state: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'archived'] },
            task_info: { type: 'string' },
            parent_id: { type: 'string', minLength: 8, maxLength: 8 },
            extra_note: { type: 'string' }
          },
          required: ['name', 'match']
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
        description: 'Delete a project and its files',
        inputSchema: {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name']
        }
      },
      {
        name: 'rename_project',
        description: 'Rename a project. ' + agentsReminder,
        inputSchema: {
          type: 'object',
          properties: {
            oldName: { type: 'string' },
            newName: { type: 'string' }
          },
          required: ['oldName', 'newName']
        }
      },
      {
        name: 'read_agent',
        description: 'Read AGENTS.md for a project. Optional: prepend line numbers with N|. ' + agentsReminder,
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            lineNumbers: { type: 'boolean', description: 'If true, prepend line numbers as N|line' }
          },
          required: ['name']
        }
      },
      {
        name: 'write_agent',
        description: 'Write AGENTS.md (mode=full|patch|diff). For patch/diff, provide a unified diff string: use hunk headers like @@ -l,c +l,c @@ and lines prefixed with space (context), + (add), - (delete). If deleting a markdown list item that starts with "- ", the diff line must start with "-- " (delete marker + literal dash). Lines must preserve leading spaces in context. ' + agentsReminder,
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            content: { type: 'string', description: 'Full file contents when mode=full (default)' },
            patch: { type: 'string', description: 'Unified diff (git-style) when mode=patch/diff' },
            mode: { type: 'string', enum: ['full', 'patch', 'diff'], description: 'Edit mode; defaults to full' }
          },
          required: ['name']
        }
      },
      {
        name: 'read_progress',
        description: 'Read structured project-level tasks as JSON. Optionally filter by status (pending, in_progress, completed) or synonyms. ' + agentsReminder,
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            only: {
              oneOf: [
                { type: 'string', enum: ['todo', 'to-do', 'pending', 'in_progress', 'in-progress', 'done', 'completed'] },
                { type: 'array', items: { type: 'string' } }
              ]
            }
          },
          required: ['name']
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
            name: { type: 'string', description: 'Project name' },
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
          required: ['name','tasks']
        }
      },
      {
        name: 'review_scratchpad',
        description: 'Read‑only view of a scratchpad for a one‑off task. Provide (project name, scratchpad_id). Returns the current tasks (max 6) and the append‑only common_memory so you can review steps and notes you take for solving this immediate problem.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            scratchpad_id: { type: 'string' }
          },
          required: ['name','scratchpad_id']
        }
      },
      {
        name: 'scratchpad_update_task',
        description: 'Update existing scratchpad tasks by task_id to reflect progress on a temporary problem. You can change status (open|complete), task_info, scratchpad (quick notes), and comments. If you need a different set of tasks, create a new scratchpad and use its scratchpad_id. Returns the updated scratchpad.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
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
          required: ['name','scratchpad_id','updates']
        }
      },
      {
        name: 'scratchpad_append_common_memory',
        description: 'Append notes to the scratchpad\'s shared common_memory (append‑only). Use this to log core thinking steps, findings, and conclusions for a one‑off task without editing progress.md. Accepts a string or array of strings and returns the updated scratchpad. If you want to store something non-volatile, please edit agents.md or write into the extra_node entry of a task in progress.md. ',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            scratchpad_id: { type: 'string' },
            append: { oneOf: [ { type: 'string' }, { type: 'array', items: { type: 'string' } } ] }
          },
          required: ['name','scratchpad_id','append']
        }
      }
    ]};
  });

  // Tool invocation handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    async function okText(text) {
      return { content: [{ type: 'text', text }] };
    }

    switch (name) {
      case 'list_projects': {
        const projects = await ops.listProjects();
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
          return okText(JSON.stringify({ status: 'ok', note: 'Tasks use exactly 8 lowercase a-z0-9 IDs (e.g., abcd1234).', ...result }));
        } catch (err) {
          const msg = String(err?.message || err || 'init failed');
          const code = /user not authenticated/i.test(msg) ? 'unauthorized' : (/project name required/i.test(msg) ? 'invalid_request' : 'init_failed');
          return okText(JSON.stringify({ error: code, message: msg }));
        }
      }
      case 'delete_project': {
        const { name: projName } = args || {};
        await ops.removeProject(projName);
        return okText('deleted');
      }
      case 'rename_project': {
        const { oldName, newName } = args || {};
        const result = await ops.renameProject(oldName, newName);
        return okText(JSON.stringify(result));
      }
      case 'read_agent': {
        const { name: projName, lineNumbers } = args || {};
        const content = await ops.readDoc(projName, 'agent');
        if (lineNumbers) {
          const lines = String(content ?? '').split('\n');
          const numbered = lines.map((l, idx) => `${idx + 1}|${l.replace(/\r$/, '')}`).join('\n');
          return okText(numbered);
        }
        return okText(content);
      }
      case 'write_agent': {
        const { name: projName } = args || {};
        let { content, patch, mode } = args || {};
        const editMode = String(mode || (patch ? 'patch' : 'full')).toLowerCase();
        try {
          if (editMode === 'full') {
            if (typeof content !== 'string') throw new Error('content (string) required for full mode');
            await ops.writeDoc(projName, 'agent', content);
            return okText(JSON.stringify({ mode: 'full', status: 'ok', bytes: Buffer.byteLength(content, 'utf8') }));
          }
          if (editMode === 'patch' || editMode === 'diff') {
            if (typeof patch !== 'string') throw new Error('patch (unified diff string) required for patch/diff mode');
            const current = await ops.readDoc(projName, 'agent');
            const updated = applyUnifiedDiff(current, patch);
            await ops.writeDoc(projName, 'agent', updated);
            return okText(JSON.stringify({ mode: 'patch', status: 'ok', oldBytes: Buffer.byteLength(current, 'utf8'), newBytes: Buffer.byteLength(updated, 'utf8') }));
          }
          throw new Error(`Unknown mode: ${mode}`);
        } catch (err) {
          const msg = String(err?.message || err || 'write failed');
          const code = /project not found/i.test(msg) ? 'project_not_found' : (/patch/i.test(msg) ? 'patch_failed' : 'write_failed');
          const suggest = code === 'project_not_found' ? 'init_project' : (code === 'patch_failed' ? 'read_agent' : undefined);
          const payload = { error: code, message: msg };
          if (suggest) payload.suggest = suggest;
          return okText(JSON.stringify(payload));
        }
      }
      case 'read_progress': {
        const { name: projName, only } = args || {};
        const list = Array.isArray(only) ? only : (typeof only === 'undefined' ? [] : [only]);
        let wanted = list.map(normalizeStateFilter).filter(Boolean);
        // Default excludes archived at DB layer when wanted is empty.
        // If a filter includes 'archived', include archived alongside other requested statuses.
        const filterProvided = typeof only !== 'undefined';
        try {
          // If a filter was provided but normalized to empty (no recognized statuses), return empty set.
          if (filterProvided && wanted.length === 0) {
            return okText(JSON.stringify({ tasks: [], markdown: '' }));
          }
          const rows = await dbListTasks(userId, projName, { only: wanted });
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
        const { name: projName, tasks } = args || {};
        try {
          if (!validateProjectName(projName)) {
            return okText(JSON.stringify({ error: 'invalid_request', message: 'Invalid project name. Allowed: letters, digits, space, . _ -' }));
          }
          // Server generates scratchpad_id
          const sp = await dbInitScratchpad(userId, projName, '', Array.isArray(tasks) ? tasks : []);
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
        const { name: projName, scratchpad_id } = args || {};
        try {
          if (!validateProjectName(projName)) {
            return okText(JSON.stringify({ error: 'invalid_request', message: 'Invalid project name. Allowed: letters, digits, space, . _ -' }));
          }
          const sp = await dbGetScratchpad(userId, projName, String(scratchpad_id || ''));
          // Return only tasks and common_memory per spec
          return okText(JSON.stringify({ tasks: sp.tasks || [], common_memory: sp.common_memory || '' }));
        } catch (err) {
          const msg = String(err?.message || err || 'review failed');
          const code = /project not found/i.test(msg) ? 'project_not_found' : (/scratchpad not found/i.test(msg) ? 'scratchpad_not_found' : 'review_failed');
          return okText(JSON.stringify({ error: code, message: msg }));
        }
      }
      case 'scratchpad_update_task': {
        const { name: projName, scratchpad_id, updates } = args || {};
        try {
          if (!validateProjectName(projName)) {
            return okText(JSON.stringify({ error: 'invalid_request', message: 'Invalid project name. Allowed: letters, digits, space, . _ -' }));
          }
          const res = await dbUpdateScratchpadTasks(userId, projName, String(scratchpad_id || ''), Array.isArray(updates) ? updates : []);
          return okText(JSON.stringify(res));
        } catch (err) {
          const msg = String(err?.message || err || 'update failed');
          const code = /project not found/i.test(msg) ? 'project_not_found' : (/scratchpad not found/i.test(msg) ? 'scratchpad_not_found' : 'update_failed');
          return okText(JSON.stringify({ error: code, message: msg }));
        }
      }
      case 'scratchpad_append_common_memory': {
        const { name: projName, scratchpad_id, append } = args || {};
        try {
          if (!validateProjectName(projName)) {
            return okText(JSON.stringify({ error: 'invalid_request', message: 'Invalid project name. Allowed: letters, digits, space, . _ -' }));
          }
          const sp = await dbAppendScratchpadCommonMemory(userId, projName, String(scratchpad_id || ''), append);
          return okText(JSON.stringify(sp));
        } catch (err) {
          const msg = String(err?.message || err || 'append failed');
          const code = /project not found/i.test(msg) ? 'project_not_found' : (/scratchpad not found/i.test(msg) ? 'scratchpad_not_found' : 'append_failed');
          return okText(JSON.stringify({ error: code, message: msg }));
        }
      }
      case 'progress_add': {
        const { name: projName, item } = args || {};
        try {
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
          const res = await dbAddTasks(userId, projName, tasks);
          return okText(JSON.stringify({ added: res.added, skipped: res.exists, invalid }));
        } catch (err) {
          const msg = String(err?.message || err || 'add failed');
          const code = /project not found/i.test(msg) ? 'project_not_found' : 'add_failed';
          return okText(JSON.stringify({ error: code, message: msg }));
        }
      }
      case 'progress_set_new_state': {
        const { name: projName, match, state, task_info, parent_id, extra_note } = args || {};
        try {
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
          const res = await dbSetTasksState(userId, projName, { matchIds: ids, matchText: terms, state: normalizedState, task_info, parent_id, extra_note });
          if (res.changedIds.length === 0) {
            if ((res.notMatched?.length || 0) > 0 && (res.forbidden?.length || 0) === 0) {
              return okText(JSON.stringify({ error: 'task_not_found', message: 'No matching tasks found for provided match terms', notMatched: res.notMatched }));
            }
            return okText(JSON.stringify({ changed: [], state: normalizedState, notMatched: res.notMatched, forbidden: res.forbidden, notice: 'No items changed. Items may be locked or list changed. Pull updated list?', suggest: 'read_progress' }));
          }
          return okText(JSON.stringify({ changed: res.changedIds, state: normalizedState, notMatched: res.notMatched, forbidden: res.forbidden }));
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
    const server = buildMcpServer(req.user?.id);
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

// Start server
async function start() {
  app.listen(PORT, HOST, () => {
    console.log(`MCP server listening on http://${HOST}:${PORT}${BASE_PATH}?apiKey=XXXX`);
    console.log(`Admin auth endpoint: http://${HOST}:${PORT}/auth (Bearer MAIN_API_KEY)`);
  });
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
