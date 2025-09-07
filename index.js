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
    async initProject(name, { agent = defaultAgentMd(name), progress = defaultProgressMd() } = {}) {
      if (!validateProjectName(name)) throw new Error('Invalid project name');
      const agentJson = JSON.stringify({ content: agent });
      // Allow initializing progress from a JSON list (bulk)
      const progressText = coerceProgressContent(progress);
      const progressJson = JSON.stringify({ content: progressText });
      return dbInitProject(userId, name, { agentJson, progressJson });
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
  return null;
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

function normalizeOnlyList(only) {
  if (only == null) return [];
  if (Array.isArray(only)) return only.map(String).map(s => s.trim()).filter(Boolean);
  // Accept JSON list passed as string (e.g., "[\"a\",\"b\"]")
  if (typeof only === 'string') {
    const s = only.trim();
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

function filterExamplesByOnly(examples, onlyList) {
  if (!onlyList.length) return examples;
  const needles = onlyList.map(s => s.toLowerCase());
  return examples.filter(ex => {
    const u = String(ex.usecase || '').toLowerCase();
    const t = String(ex.title || '').toLowerCase();
    return needles.some(n => u.includes(n) || t.includes(n));
  });
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
    const { examples } = await loadAgentExamplesJson();
    const available = examples.map(ex => `${ex.usecase || ''}${ex.title ? ` - ${ex.title}` : ''}`.trim()).filter(Boolean);
    const examplesToolDesc = [
      'Get AGENTS.md examples from example_agent_md.json.',
      available.length ? `Available examples: ${available.join('; ')}` : 'No examples found.',
      "Filter with 'only' by usecase/title (string or list). If 'only' is a JSON string list (e.g., [\"studying_a_subject\",\"exam_review\"]), it is parsed as an array.",
      "Response always includes top-level 'the_art_of_writing_agents_md' (not filtered)."
    ].join(' ');

    return { tools: [
      {
        name: 'list_projects',
        description: 'List all project names',
        inputSchema: { type: 'object', properties: {} }
      },
      {
        name: 'progress_add',
        description: 'Append one or more progress items to progress.md (string or JSON list)',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            item: { oneOf: [ { type: 'string' }, { type: 'array', items: { type: 'string' } } ] }
          },
          required: ['name', 'item']
        }
      },
      {
        name: 'progress_set_state',
        description: 'Set state of one or more progress items by matching text only',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            match: { oneOf: [ { type: 'string' }, { type: 'array', items: { type: 'string' } } ] },
            state: { type: 'string', enum: ['pending', 'in_progress', 'completed'] }
          },
          required: ['name', 'match', 'state']
        }
      },
      {
        name: 'progress_mark_complete',
        description: 'Mark one or more progress items as completed by matching text only',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            match: { oneOf: [ { type: 'string' }, { type: 'array', items: { type: 'string' } } ] }
          },
          required: ['name', 'match']
        }
      },
      {
        name: 'init_project',
        description: 'Create or initialize a project with optional agent/progress content',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            agent: { type: 'string' },
            progress: { type: 'string' }
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
        description: 'Rename a project',
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
        description: 'Read AGENTS.md for a project. Optional: prepend line numbers with N|',
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
        description: 'Write AGENTS.md (mode=full|patch|diff). For patch/diff, provide a unified diff string: use hunk headers like @@ -l,c +l,c @@ and lines prefixed with space (context), + (add), - (delete). If deleting a markdown list item that starts with "- ", the diff line must start with "-- " (delete marker + literal dash). Lines must preserve leading spaces in context.',
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
        description: 'Read progress.md for a project. Optionally filter by state (to-do, in-progress, done).',
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
        name: 'write_progress',
        description: 'Write progress.md for a project. Accepts string or JSON list of items.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            content: { oneOf: [ { type: 'string' }, { type: 'array', items: { type: 'string' } } ] }
          },
          required: ['name', 'content']
        }
      },
      {
        name: 'get_agents_md_examples',
        description: examplesToolDesc,
        inputSchema: {
          type: 'object',
          properties: {
            only: { oneOf: [ { type: 'string' }, { type: 'array', items: { type: 'string' } } ] }
          }
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
          return okText(JSON.stringify({ status: 'ok', ...result }));
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
        const content = await ops.readDoc(projName, 'progress');
        const filtered = typeof only === 'undefined' ? content : filterProgressContent(content, only);
        return okText(filtered);
      }
      case 'write_progress': {
        const { name: projName, content } = args || {};
        try {
          const coerced = coerceProgressContent(content);
          await ops.writeDoc(projName, 'progress', coerced);
          return okText(JSON.stringify({ status: 'ok', bytes: Buffer.byteLength(coerced, 'utf8') }));
        } catch (err) {
          const msg = String(err?.message || err || 'write failed');
          const code = /project not found/i.test(msg) ? 'project_not_found' : 'write_failed';
          const payload = { error: code, message: msg };
          if (code === 'project_not_found') payload.suggest = 'init_project';
          return okText(JSON.stringify(payload));
        }
      }
      case 'get_agents_md_examples': {
        const { only } = args || {};
        const { theArt, examples, rawParsed } = await loadAgentExamplesJson();
        if (!rawParsed) {
          return okText(JSON.stringify({ error: 'examples_file_not_found', message: 'example_agent_md.json not found or invalid', the_art_of_writing_agents_md: '', examples: [] }));
        }
        const onlyList = normalizeOnlyList(only);
        const filtered = filterExamplesByOnly(examples, onlyList);
        const result = {
          the_art_of_writing_agents_md: theArt,
          examples: filtered
        };
        return okText(JSON.stringify(result));
      }
      case 'progress_add': {
        const { name: projName, item } = args || {};
        const arr = coerceJsonArray(item);
        if (arr) {
          const result = await progressAddItems(projName, arr, ops);
          return okText(JSON.stringify(result));
        } else {
          const result = await progressAddItem(projName, String(item), ops);
          return okText(JSON.stringify(result));
        }
      }
      case 'progress_set_state': {
        const { name: projName, match, state } = args || {};
        const result = await progressSetState(projName, { match, state }, ops);
        // If no matches, return a friendly prompt
        if (result && Array.isArray(result.changed) && result.changed.length === 0 && result.notice) {
          return okText(JSON.stringify(result));
        }
        return okText(JSON.stringify(result));
      }
      case 'progress_mark_complete': {
        const { name: projName, match } = args || {};
        const result = await progressSetState(projName, { match, state: 'completed' }, ops);
        if (result && Array.isArray(result.changed) && result.changed.length === 0 && result.notice) {
          return okText(JSON.stringify(result));
        }
        return okText(JSON.stringify(result));
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
