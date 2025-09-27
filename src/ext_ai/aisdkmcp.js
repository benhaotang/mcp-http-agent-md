// MCP provider using AI SDK + OpenAI-compatible provider.
// - Loads MCP servers from subagent_config.json
// - Connects using stdio or Streamable HTTP (prefer HTTP; do not use SSE)
// - Aggregates tools and runs generateText with @ai-sdk/openai-compatible

import { experimental_createMCPClient, generateText, stepCountIs } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import fs from 'fs/promises';
import path from 'path';
import { loadFilePayload, buildFileContextBlock } from './fileUtils.js';

async function loadMcpConfig() {
  try {
    const root = process.cwd();
    const p = path.join(root, 'subagent_config.json');
    const raw = await fs.readFile(p, 'utf-8');
    const json = JSON.parse(raw);
    console.log('[mcp] Loaded subagent_config.json with servers:', Object.keys(json?.mcpServers || {}));
    return json || {};
  } catch (e) {
    console.warn('[mcp] No subagent_config.json found or failed to parse. Skipping MCP client setup.');
    return {};
  }
}

async function createMcpClientsFromConfig(conf) {
  const servers = conf?.mcpServers || {};
  const clients = [];
  const resolveHttpUrl = (value) => {
    try {
      const url = new URL(String(value || ''));
      if (url.pathname.endsWith('/sse')) {
        try { console.warn(`[mcp] serverUrl points to an SSE endpoint (${url.toString()}). SSE is legacy; consider migrating to Streamable HTTP at the corresponding /mcp endpoint.`); } catch {}
      }
      return url;
    } catch {
      return null;
    }
  };
  for (const [name, cfg] of Object.entries(servers)) {
    try {
      if (cfg && typeof cfg.serverUrl === 'string' && cfg.serverUrl.trim()) {
        const url = resolveHttpUrl(cfg.serverUrl);
        if (!url) throw new Error('invalid_server_url');
        const isSse = url.pathname.endsWith('/sse');
        console.log(`[mcp] Initializing ${isSse ? 'SSE' : 'HTTP'} MCP server '${name}' at`, url.toString());
        const transport = isSse
          ? new SSEClientTransport(url)
          : new StreamableHTTPClientTransport(url);
        const client = await experimental_createMCPClient({ transport });
        console.log(`[mcp] Connected to ${isSse ? 'SSE' : 'HTTP'} MCP server '${name}'.`);
        clients.push({ name, client });
        continue;
      }
      if (cfg && typeof cfg.command === 'string' && cfg.command.trim()) {
        const args = Array.isArray(cfg.args) ? cfg.args : [];
        console.log(`[mcp] Spawning stdio MCP server '${name}':`, cfg.command, args.join(' '));
        const transport = new StdioClientTransport({ command: cfg.command, args });
        const client = await experimental_createMCPClient({ transport });
        console.log(`[mcp] Connected to stdio MCP server '${name}'.`);
        clients.push({ name, client });
        continue;
      }
    } catch (err) {
      // Skip failing client; continue with others
      // eslint-disable-next-line no-console
      console.error(`[mcp] Failed to initialize server '${name}':`, err?.message || err);
    }
  }
  console.log(`[mcp] Initialized ${clients.length} MCP client(s).`);
  return clients;
}

export async function infer({ apiKey, model, baseUrl, systemPrompt, userPrompt, tools = [], timeoutSec = 120, filePath, fileMeta }) {
  // Prepare OpenAI-compatible provider
  const baseURL = String(baseUrl || '').trim() || 'https://api.openai.com/v1';
  const provider = createOpenAICompatible({ name: 'openai-compatible', apiKey, baseURL });

  // Load MCP config and clients
  const skipServers = /^(1|true)$/i.test(String(process.env.MCP_SKIP_SERVERS || ''));
  if (skipServers) {
    console.log('[mcp] MCP_SKIP_SERVERS=true – skipping MCP client initialization.');
  }
  const conf = skipServers ? {} : await loadMcpConfig();
  const clients = skipServers ? [] : await createMcpClientsFromConfig(conf);

  // Aggregate MCP tools per server
  const perServerTools = {};
  let totalCount = 0;
  try {
    for (const { name, client } of clients) {
      const t = await client.tools();
      const names = Object.keys(t || {});
      perServerTools[name] = t || {};
      totalCount += names.length;
      console.log(`[mcp] Loaded ${names.length} tool(s) from '${name}':`, names.slice(0, 20).join(', '));
    }
    console.log(`[mcp] Total aggregated tools: ${totalCount}`);
  } catch (e) {
    // If tools fail, continue without tools
    // eslint-disable-next-line no-console
    console.error('[mcp] error loading tools:', e?.message || e);
  }

  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const hardTimer = setTimeout(() => { try { controller?.abort(); } catch {} }, Math.max(1000, Number(timeoutSec || 0) * 1000));

  try {
    const systemText = String(systemPrompt || '').trim();
    let userText = String(userPrompt ?? '');
    if (!userText.trim()) {
      userText = 'Prompt missing?';
    }

    let prompt = (systemText ? `${systemText}\n\n` : '') + userText;

    if (filePath) {
      const attachment = await loadFilePayload(filePath, fileMeta || {});
      const contextBlock = buildFileContextBlock(attachment);
      if (contextBlock) {
        prompt = `${prompt}\n\n<attached_file>\n\nFile attachment content:\n\n${contextBlock}\n\n</attached_file>`;
      }
    }

    // Determine requested server names from 'tools' param: 'all' or an array of server names
    let requestedServers = null; // null means 'all'
    if (typeof tools === 'string') {
      requestedServers = /^all$/i.test(tools.trim()) ? null : tools.split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
    } else if (Array.isArray(tools)) {
      requestedServers = tools.map(v => String(v || '').trim()).filter(Boolean);
    }
    const availableServers = Object.keys(perServerTools);
    let selectedServers = availableServers;
    if (requestedServers && requestedServers.length) {
      const reqSet = new Set(requestedServers);
      const missing = requestedServers.filter(n => !availableServers.includes(n));
      if (missing.length) {
        throw new Error(`mcp_requested_servers_not_found: ${missing.join(', ')}`);
      }
      selectedServers = availableServers.filter(n => reqSet.has(n));
    }
    console.log('[mcp] Selected servers:', selectedServers.join(', '));

    // Instrument tools to capture toolcall history reliably regardless of provider step reporting
    const toolcall_history = [];
    const instrumentedTools = {};
    for (const serverName of selectedServers) {
      const tmap = perServerTools[serverName] || {};
      for (const [toolName, def] of Object.entries(tmap)) {
        if (!def || typeof def.execute !== 'function') continue;
        instrumentedTools[toolName] = {
          ...def,
          execute: async (input, opts) => {
            // Only log the input; do not log outputs to avoid large payloads.
            toolcall_history.push({ type: 'call', server: serverName, toolName, input });
            return await def.execute(input, opts);
          },
        };
      }
    }

    const result = await generateText({
      model: provider(String(model || '').trim() || 'gpt-4o-mini'),
      tools: instrumentedTools,
      prompt,
      stopWhen: stepCountIs(8),
      abortSignal: controller?.signal,
    });

    clearTimeout(hardTimer);
    const steps = Array.isArray(result?.steps) ? result.steps : [];
    const toolCalls = steps.filter(s => s && s.type === 'tool-call');
    const toolNamesUsed = toolCalls.map(s => s.toolName).filter(Boolean);
    if (toolCalls.length) {
      console.log('[mcp] Tool calls executed:', toolNamesUsed.join(', ') || String(toolCalls.length));
    }
    // Merge provider-reported tool-call steps (inputs only); ignore tool-result payloads
    for (const s of steps) {
      const kind = String(s?.type || '').toLowerCase();
      if (kind === 'tool-call') {
        const entry = { type: 'call', toolName: s?.toolName, toolCallId: s?.toolCallId, input: s?.args ?? s?.input ?? s?.parameters ?? null };
        if (!toolcall_history.some(h => h.type === 'call' && h.toolName === entry.toolName && h.toolCallId === entry.toolCallId)) {
          toolcall_history.push(entry);
        }
      }
    }
    return {
      text: String(result?.text || ''),
      codeSnippets: [],
      codeResults: [],
      urls: [],
      toolcall_history,
    };
  } catch (err) {
    console.error(err);
    clearTimeout(hardTimer);
    // Re-throw to let caller capture and update run status
    throw err;
  } finally {
    // Ensure we close clients
    try { await Promise.all(clients.map((e) => e.client.close())); } catch {}
  }
}

export default { infer };
