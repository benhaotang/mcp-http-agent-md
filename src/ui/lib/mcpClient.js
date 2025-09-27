import dayjs from 'dayjs';

let rpcId = 1;

export async function callTool(apiKey, name, args = {}) {
  async function send(methodName) {
    const body = { jsonrpc: '2.0', id: rpcId++, method: methodName, params: { name, arguments: args } };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    let res;
    try {
      res = await fetch(`/mcp?apiKey=${encodeURIComponent(apiKey)}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream'
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });
    } catch (e) {
      clearTimeout(timeout);
      throw new Error('Network error: ' + (e?.message || e));
    }
    clearTimeout(timeout);
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new Error(`MCP HTTP ${res.status}: ${text}`);
    }
    const ctype = (res.headers.get('content-type') || '').toLowerCase();
    let json;
    if (ctype.startsWith('text/event-stream')) {
      const raw = await res.text();
      const dataLines = raw.split(/\n/).filter(l => l.startsWith('data:'));
      let last = null;
      for (const line of dataLines) {
        const payload = line.slice(5).trim();
        if (!payload) continue;
        try {
          const parsed = JSON.parse(payload);
          if (parsed.jsonrpc && (parsed.result || parsed.error)) last = parsed;
        } catch {}
      }
      if (!last) throw new Error('MCP stream: no JSON-RPC payload received');
      json = last;
    } else {
      json = await res.json();
    }
    return json;
  }

  // Primary attempt with legacy method name used in docs
  let json = await send('call_tool');
  if (json?.error && /method not found/i.test(json.error.message || '')) {
    // Retry with spec canonical method name
    json = await send('tools/call');
  }
  if (json?.error) {
    throw new Error(json.error?.message || 'MCP tool error');
  }
  const ct = json?.result?.content?.[0]?.text ?? '';
  try { return JSON.parse(ct); } catch { return ct; }
}

export async function listMcpTools(apiKey) {
  async function send(method) {
    const body = { jsonrpc: '2.0', id: rpcId++, method, params: {} };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    let res;
    try {
      res = await fetch(`/mcp?apiKey=${encodeURIComponent(apiKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
    if (!res || !res.ok) throw new Error('Failed to list tools');
    const json = await res.json();
    return json;
  }
  // Try canonical then legacy
  let json;
  try {
    json = await send('tools/list');
  } catch {
    json = await send('list_tools');
  }
  const tools = (json?.result?.tools || []).map(t => t.name);
  return tools;
}

export async function waitForSubagent(apiKey, projectId, runId, { maxChecks = 6, intervalMs = 4000 } = {}) {
  for (let i = 0; i < maxChecks; i++) {
    const info = await callTool(apiKey, 'scratchpad_subagent_status', { project_id: projectId, run_id: runId });
    if (info && info.status && info.status !== 'pending' && info.status !== 'in_progress') return info;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return { run_id: runId, status: 'timeout' };
}

export function normalizeError(e) {
  if (!e) return 'Unknown error';
  if (typeof e === 'string') return e;
  return e.message || String(e);
}

export function relative(ts) {
  return dayjs(ts).from ? dayjs(ts).from(dayjs()) : dayjs(ts).format('YYYY-MM-DD HH:mm');
}
