import express from 'express';
import cors from 'cors';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const BASE_PATH = process.env.BASE_PATH || '/mcp'; // MCP endpoint path
const DATA_DIR = path.resolve(__dirname, 'projects');

// Ensure base data directory exists
async function ensureDataDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

// Utility: sanitize and validate project name
function validateProjectName(name) {
  if (typeof name !== 'string' || name.length === 0) return false;
  return /^[A-Za-z0-9._-]+$/.test(name);
}

function projectDir(name) {
  return path.join(DATA_DIR, name);
}

async function listProjects() {
  await ensureDataDir();
  const entries = await fs.readdir(DATA_DIR, { withFileTypes: true });
  return entries.filter(e => e.isDirectory()).map(e => e.name);
}

async function initProject(name, { agent = defaultAgentMd(name), progress = defaultProgressMd() } = {}) {
  if (!validateProjectName(name)) throw new Error('Invalid project name');
  const dir = projectDir(name);
  await fs.mkdir(dir, { recursive: true });
  const agentPath = path.join(dir, 'agent.md');
  const progressPath = path.join(dir, 'progress.md');
  try { await fs.access(agentPath); } catch { await fs.writeFile(agentPath, agent, 'utf8'); }
  try { await fs.access(progressPath); } catch { await fs.writeFile(progressPath, progress, 'utf8'); }
  return { name };
}

async function removeProject(name) {
  if (!validateProjectName(name)) throw new Error('Invalid project name');
  const dir = projectDir(name);
  await fs.rm(dir, { recursive: true, force: true });
}

async function renameProject(oldName, newName) {
  if (!validateProjectName(oldName) || !validateProjectName(newName)) throw new Error('Invalid project name');
  const oldDir = projectDir(oldName);
  const newDir = projectDir(newName);
  await fs.rename(oldDir, newDir);
  return { name: newName };
}

async function readDoc(name, which) {
  if (!validateProjectName(name)) throw new Error('Invalid project name');
  const dir = projectDir(name);
  const file = which === 'agent' ? 'agent.md' : 'progress.md';
  const filePath = path.join(dir, file);
  return await fs.readFile(filePath, 'utf8');
}

async function writeDoc(name, which, content) {
  if (!validateProjectName(name)) throw new Error('Invalid project name');
  const dir = projectDir(name);
  await fs.mkdir(dir, { recursive: true });
  const file = which === 'agent' ? 'agent.md' : 'progress.md';
  const filePath = path.join(dir, file);
  await fs.writeFile(filePath, String(content ?? ''), 'utf8');
}

// -------- Progress helpers --------
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

async function progressAddItem(projectName, itemText) {
  if (!validateProjectName(projectName)) throw new Error('Invalid project name');
  if (!itemText || typeof itemText !== 'string') throw new Error('item text required');
  const dir = projectDir(projectName);
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, 'progress.md');
  let content = '';
  try {
    content = await fs.readFile(filePath, 'utf8');
  } catch {
    content = defaultProgressMd();
  }
  const endsWithNewline = content.endsWith('\n');
  const addition = formatProgressLine('pending', itemText);
  const updated = content + (endsWithWith(content, '\n\n') ? '' : endsWithNewline ? '' : '\n') + addition + '\n';
  await fs.writeFile(filePath, updated, 'utf8');
  return { added: itemText };
}

function endsWithWith(s, suffix) {
  return s.endsWith(suffix);
}

async function progressSetState(projectName, opts) {
  const { index, match, state } = opts || {};
  if (!validateProjectName(projectName)) throw new Error('Invalid project name');
  if (!['pending', 'in_progress', 'completed'].includes(state)) throw new Error('invalid state');
  if (index == null && (!match || typeof match !== 'string')) throw new Error('index or match required');

  const filePath = path.join(projectDir(projectName), 'progress.md');
  let content = '';
  try {
    content = await fs.readFile(filePath, 'utf8');
  } catch {
    throw new Error('progress.md not found');
  }

  const lines = content.split(/\r?\n/);
  let itemIdx = 0;
  let changedAt = -1;
  for (let i = 0; i < lines.length; i++) {
    const parsed = parseProgressLine(lines[i]);
    if (!parsed.isItem) continue;
    itemIdx++;
    const matchesByIndex = index != null && itemIdx === Number(index);
    const matchesByText = match && parsed.text.toLowerCase().includes(match.toLowerCase());
    if (matchesByIndex || matchesByText) {
      lines[i] = formatProgressLine(state, parsed.text);
      changedAt = itemIdx;
      break;
    }
  }

  if (changedAt === -1) throw new Error('no matching progress item');
  const updated = lines.join('\n');
  await fs.writeFile(filePath, updated, 'utf8');
  return { index: changedAt, state };
}

function defaultAgentMd(projectName) {
  return `# agent.md\n\n- Project: ${projectName}\n- Purpose: Instructions for agents (style, best practices, personality)\n\nGuidance:\n- Keep responses concise, clear, and actionable.\n- Prefer safe defaults; avoid destructive actions.\n- Explain rationale briefly when ambiguity exists.\n`;
}

function defaultProgressMd() {
  return `# progress.md\n\n- [ ] Initial setup\n- [ ] Define tasks\n- [ ] Implement features\n- [ ] Review and refine\n`;
}

// Build a fresh MCP server instance for each request (stateless mode)
function buildMcpServer() {
  const server = new Server(
    { name: 'mcp-http-agent-md', version: '0.0.1' },
    { capabilities: { tools: {} } }
  );

  // Describe available tools
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'list_projects',
        description: 'List all project names',
        inputSchema: { type: 'object', properties: {} }
      },
      {
        name: 'progress_add',
        description: 'Append a new progress item to progress.md',
        inputSchema: {
          type: 'object',
          properties: { name: { type: 'string' }, item: { type: 'string' } },
          required: ['name', 'item']
        }
      },
      {
        name: 'progress_set_state',
        description: 'Set state of a progress item by index or matching text',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            index: { type: 'number' },
            match: { type: 'string' },
            state: { type: 'string', enum: ['pending', 'in_progress', 'completed'] }
          },
          required: ['name', 'state']
        }
      },
      {
        name: 'progress_mark_complete',
        description: 'Mark a progress item as completed by index or matching text',
        inputSchema: {
          type: 'object',
          properties: { name: { type: 'string' }, index: { type: 'number' }, match: { type: 'string' } },
          required: ['name']
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
        description: 'Read agent.md for a project',
        inputSchema: {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name']
        }
      },
      {
        name: 'write_agent',
        description: 'Write agent.md for a project',
        inputSchema: {
          type: 'object',
          properties: { name: { type: 'string' }, content: { type: 'string' } },
          required: ['name', 'content']
        }
      },
      {
        name: 'read_progress',
        description: 'Read progress.md for a project',
        inputSchema: {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name']
        }
      },
      {
        name: 'write_progress',
        description: 'Write progress.md for a project',
        inputSchema: {
          type: 'object',
          properties: { name: { type: 'string' }, content: { type: 'string' } },
          required: ['name', 'content']
        }
      }
    ]
  }));

  // Tool invocation handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    async function okText(text) {
      return { content: [{ type: 'text', text }] };
    }

    switch (name) {
      case 'list_projects': {
        const projects = await listProjects();
        return okText(JSON.stringify({ projects }));
      }
      case 'init_project': {
        const { name: projName, agent, progress } = args || {};
        const result = await initProject(projName, { agent, progress });
        return okText(JSON.stringify(result));
      }
      case 'delete_project': {
        const { name: projName } = args || {};
        await removeProject(projName);
        return okText('deleted');
      }
      case 'rename_project': {
        const { oldName, newName } = args || {};
        const result = await renameProject(oldName, newName);
        return okText(JSON.stringify(result));
      }
      case 'read_agent': {
        const { name: projName } = args || {};
        const content = await readDoc(projName, 'agent');
        return okText(content);
      }
      case 'write_agent': {
        const { name: projName, content } = args || {};
        await writeDoc(projName, 'agent', content);
        return okText('ok');
      }
      case 'read_progress': {
        const { name: projName } = args || {};
        const content = await readDoc(projName, 'progress');
        return okText(content);
      }
      case 'write_progress': {
        const { name: projName, content } = args || {};
        await writeDoc(projName, 'progress', content);
        return okText('ok');
      }
      case 'progress_add': {
        const { name: projName, item } = args || {};
        const result = await progressAddItem(projName, item);
        return okText(JSON.stringify(result));
      }
      case 'progress_set_state': {
        const { name: projName, index, match, state } = args || {};
        const result = await progressSetState(projName, { index, match, state });
        return okText(JSON.stringify(result));
      }
      case 'progress_mark_complete': {
        const { name: projName, index, match } = args || {};
        const result = await progressSetState(projName, { index, match, state: 'completed' });
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
app.use(cors({ origin: '*', exposedHeaders: ['Mcp-Session-Id'], allowedHeaders: ['Content-Type', 'mcp-session-id'] }));
app.use(express.json({ limit: '2mb' }));

// POST /mcp handles MCP JSON-RPC requests via Streamable HTTP
app.post(BASE_PATH, async (req, res) => {
  try {
    const server = buildMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    res.on('close', () => {
      transport.close();
      server.close();
    });

    await server.connect(transport);
    await ensureDataDir();
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
  res.type('text/plain').send(`mcp-http-agent-md MCP server. POST ${BASE_PATH} for MCP JSON-RPC`);
});

// Start server
async function start() {
  await ensureDataDir();
  app.listen(PORT, () => {
    console.log(`MCP server listening on http://localhost:${PORT}${BASE_PATH}`);
  });
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
