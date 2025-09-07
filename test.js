import { spawn } from 'node:child_process';
import process from 'node:process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const PORT = process.env.TEST_PORT ? Number(process.env.TEST_PORT) : 43111;
const BASE = `http://localhost:${PORT}/mcp`;

async function waitForServer(proc, timeoutMs = 8000) {
  const start = Date.now();
  return await new Promise((resolve, reject) => {
    let resolved = false;
    const onData = (data) => {
      const s = String(data);
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
        // Any response means server is up (401 expected now)
        if ([200,401,404,405].includes(res.status)) {
          clearInterval(interval);
          if (!resolved) { resolved = true; resolve(true); }
        }
      } catch (_) {
        // ignore until it comes up
      }
    }, 150);
  });
}

// No direct RPC; use official MCP client transport for correctness

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'Assertion failed');
}

async function run() {
  console.log('Starting server for tests on port', PORT);
  const child = spawn(process.execPath, ['index.js'], {
    env: { ...process.env, PORT: String(PORT), MAIN_API_KEY: 'test-main-key' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await waitForServer(child);
    console.log('Server is up. Running MCP tool tests...');

    // Create a user via admin auth
    const createRes = await fetch(`http://localhost:${PORT}/auth/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer test-main-key' },
      body: JSON.stringify({ name: 'test-user' }),
    });
    const created = await createRes.json();
    if (!created?.apiKey) throw new Error('Failed to create user/apiKey');
    const baseWithKey = `${BASE}?apiKey=${encodeURIComponent(created.apiKey)}`;

    // Create MCP client using Streamable HTTP transport
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(baseWithKey));
    await client.connect(transport);

    // 1) tools/list
    const list = await client.listTools({});
    const toolNames = (list.tools || []).map(t => t.name).sort();
    const expected = [
      'list_projects','init_project','delete_project','rename_project',
      'read_agent','write_agent','read_progress','write_progress',
      'progress_add','progress_set_state','progress_mark_complete'
    ];
    for (const n of expected) assert(toolNames.includes(n), `Missing tool: ${n}`);

    // Unique project name
    const name = `testproj_${Date.now()}`;
    const name2 = `${name}_renamed`;

    // 2) init_project
    const init = await client.callTool({ name: 'init_project', arguments: { name } });
    assert(init.content?.[0]?.type === 'text', 'init_project response content type');

    // 3) read_agent default
    const readAgent1 = await client.callTool({ name: 'read_agent', arguments: { name } });
    const agentText1 = readAgent1.content?.[0]?.text || '';
    assert(agentText1.includes(name), 'agent.md should contain project name');

    // 4) write_agent and verify
    await client.callTool({ name: 'write_agent', arguments: { name, content: '# agent\nHello' } });
    const readAgent2 = await client.callTool({ name: 'read_agent', arguments: { name } });
    const agentText2 = readAgent2.content?.[0]?.text || '';
    assert(agentText2.includes('Hello'), 'agent.md should include updated content');

    // 5) write_progress and verify
    await client.callTool({ name: 'write_progress', arguments: { name, content: '# progress\n- [ ] first\n- [ ] second\n' } });
    let readProgress = await client.callTool({ name: 'read_progress', arguments: { name } });
    let progressText = readProgress.content?.[0]?.text || '';
    assert(progressText.includes('- [ ] first') && progressText.includes('- [ ] second'), 'progress.md should include seeded items');

    // 6) progress_add appends a new item
    await client.callTool({ name: 'progress_add', arguments: { name, item: 'third' } });
    readProgress = await client.callTool({ name: 'read_progress', arguments: { name } });
    progressText = readProgress.content?.[0]?.text || '';
    assert(progressText.includes('- [ ] third'), 'progress_add should append pending item');

    // 7) progress_set_state by index (set second to in_progress)
    await client.callTool({ name: 'progress_set_state', arguments: { name, index: 2, state: 'in_progress' } });
    readProgress = await client.callTool({ name: 'read_progress', arguments: { name } });
    progressText = readProgress.content?.[0]?.text || '';
    assert(/- \[~\] second/.test(progressText), 'Item 2 should be in_progress');

    // 8) progress_set_state by match (complete the one containing "third")
    await client.callTool({ name: 'progress_set_state', arguments: { name, match: 'third', state: 'completed' } });
    readProgress = await client.callTool({ name: 'read_progress', arguments: { name } });
    progressText = readProgress.content?.[0]?.text || '';
    assert(/- \[x\] third/.test(progressText), 'Item matched by text should be completed');

    // 9) progress_mark_complete by index (complete first)
    await client.callTool({ name: 'progress_mark_complete', arguments: { name, index: 1 } });
    readProgress = await client.callTool({ name: 'read_progress', arguments: { name } });
    progressText = readProgress.content?.[0]?.text || '';
    assert(/- \[x\] first/.test(progressText), 'Item 1 should be completed');

    // 10) list_projects contains name
    const list2 = await client.callTool({ name: 'list_projects', arguments: {} });
    const projectsList = JSON.parse(list2.content?.[0]?.text || '{}').projects || [];
    assert(projectsList.includes(name), 'list_projects should include the project');

    // 11) rename_project
    await client.callTool({ name: 'rename_project', arguments: { oldName: name, newName: name2 } });
    const list3 = await client.callTool({ name: 'list_projects', arguments: {} });
    const projectsList2 = JSON.parse(list3.content?.[0]?.text || '{}').projects || [];
    assert(projectsList2.includes(name2) && !projectsList2.includes(name), 'rename_project should reflect in list');

    // 12) delete_project
    await client.callTool({ name: 'delete_project', arguments: { name: name2 } });
    const list4 = await client.callTool({ name: 'list_projects', arguments: {} });
    const projectsList3 = JSON.parse(list4.content?.[0]?.text || '{}').projects || [];
    assert(!projectsList3.includes(name2), 'delete_project should remove the project');

    console.log('All MCP tool tests passed.');
  } catch (err) {
    console.error('Test failure:', err);
    process.exitCode = 1;
  } finally {
    try { await new Promise(r => setTimeout(r, 50)); } catch {}
    child.kill('SIGINT');
  }
}

run();
