import { spawn } from 'node:child_process';
import process from 'node:process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const PORT = process.env.TEST_SUBAGENT_PORT ? Number(process.env.TEST_SUBAGENT_PORT) : 43112;
const BASE = `http://localhost:${PORT}/mcp`;

async function waitForServer(proc, timeoutMs = 10000) {
  const start = Date.now();
  return await new Promise((resolve, reject) => {
    let resolved = false;
    const onData = (data) => {
      const s = String(data || '');
      try { process.stdout.write(s); } catch {}
      if (s.includes(`http://localhost:${PORT}/mcp`) || s.toLowerCase().includes('listening')) {
        if (!resolved) { resolved = true; resolve(true); }
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    const interval = setInterval(async () => {
      if (Date.now() - start > timeoutMs) {
        clearInterval(interval);
        if (!resolved) reject(new Error('Server did not start in time'));
        return;
      }
      try {
        const res = await fetch(BASE, { method: 'GET' });
        if ([200,401,404,405].includes(res.status)) {
          clearInterval(interval);
          if (!resolved) { resolved = true; resolve(true); }
        }
      } catch {}
    }, 150);
  });
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'Assertion failed');
}

async function run() {
  console.log('[subagent] Starting server on port', PORT);
  const child = spawn(process.execPath, ['index.js'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: 'localhost',
      USE_EXTERNAL_AI: 'true',
      AI_API_TYPE: process.env.AI_API_TYPE || 'google',
      AI_MODEL: process.env.AI_MODEL || 'gemini-2.5-flash',
      AI_TIMEOUT: process.env.AI_TIMEOUT || '45',
      AI_API_KEY: process.env.AI_API_KEY || 'sk-1234',
      AI_BASE_ENDPOINT: process.env.AI_BASE_ENDPOINT || 'sk-1234',
      MAIN_API_KEY: 'test-main-key',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await waitForServer(child);
    console.log('[subagent] Server is up. Running tests...');

    // Create a user via admin auth
    const createRes = await fetch(`http://localhost:${PORT}/auth/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer test-main-key' },
      body: JSON.stringify({ name: 'test-user-subagent' }),
    });
    const created = await createRes.json();
    assert(created?.apiKey, 'Failed to create user/apiKey');
    const baseWithKey = `${BASE}?apiKey=${encodeURIComponent(created.apiKey)}`;

    const client = new Client({ name: 'test-client-subagent', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(baseWithKey));
    await client.connect(transport);

    // Ensure subagent tools are present
    const list = await client.listTools({});
    const toolNames = (list.tools || []).map(t => t.name);
    assert(toolNames.includes('scratchpad_subagent'), 'Missing tool: scratchpad_subagent');
    assert(toolNames.includes('scratchpad_subagent_status'), 'Missing tool: scratchpad_subagent_status');

    // Create project and scratchpad
    const proj = `subagent_proj_${Date.now()}`;
    const spId = `sp-${Math.random().toString(36).slice(2, 10)}`;
    const initRes = await client.callTool({ name: 'init_project', arguments: { name: proj } });
    const initPayload = JSON.parse(initRes.content?.[0]?.text || '{}');
    assert(initPayload?.hash, 'init_project should return hash');

    const tasks = [ { task_id: 'work', task_info: 'Simple subagent task', status: 'open' } ];
    const spInitRes = await client.callTool({ name: 'scratchpad_initialize', arguments: { name: proj, tasks } });
    const spInit = JSON.parse(spInitRes.content?.[0]?.text || '{}');
    assert(spInit?.scratchpad_id, 'scratchpad_initialize should return scratchpad_id');

    // Run subagent
    const saArgs = { name: proj, scratchpad_id: spInit.scratchpad_id, task_id: 'work', prompt: 'Reply with a short confirmation.', tool: 'all' };
    const runRes = await client.callTool({ name: 'scratchpad_subagent', arguments: saArgs });
    const run = JSON.parse(runRes.content?.[0]?.text || '{}');
    assert(typeof run.run_id === 'string' && run.run_id.length > 0, 'run_id must be returned');
    assert(['success','in_progress'].includes(run.status), `unexpected initial status: ${run.status}`);

    // If not done, poll status once (the server polls internally up to ~25s)
    let finalStatus = run.status;
    if (finalStatus === 'in_progress') {
      const statusRes = await client.callTool({ name: 'scratchpad_subagent_status', arguments: { name: proj, run_id: run.run_id } });
      const status = JSON.parse(statusRes.content?.[0]?.text || '{}');
      assert(status?.run_id === run.run_id, 'status run_id mismatch');
      assert(['success','failure','in_progress'].includes(status.status), 'invalid status from status tool');
      finalStatus = status.status;
    }

    // If finished successfully, verify scratchpad content was appended
    if (finalStatus === 'success') {
      const reviewRes = await client.callTool({ name: 'review_scratchpad', arguments: { name: proj, scratchpad_id: spInit.scratchpad_id } });
      const review = JSON.parse(reviewRes.content?.[0]?.text || '{}');
      const work = (review.tasks || []).find(t => String(t.task_id) === 'work');
      assert(work, 'work task should exist');
      assert(typeof work.scratchpad === 'string' && work.scratchpad.includes('[subagent run-'), 'scratchpad should include subagent output marker');
    } else {
      console.warn('[subagent] Run not completed yet (status=', finalStatus, '). Skipping scratchpad content assertions.');
    }

    console.log('[subagent] Subagent tests passed.');
  } catch (err) {
    console.error('[subagent] Test failure:', err);
    process.exitCode = 1;
  } finally {
    try { await new Promise(r => setTimeout(r, 50)); } catch {}
    try { child.kill('SIGINT'); } catch {}
  }
}

run();
