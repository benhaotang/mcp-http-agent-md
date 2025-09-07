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
      'progress_add','progress_set_state','progress_mark_complete',
      'get_agents_md_examples'
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

    // 7) progress_set_state by text match (set second to in_progress)
    await client.callTool({ name: 'progress_set_state', arguments: { name, match: 'second', state: 'in_progress' } });
    readProgress = await client.callTool({ name: 'read_progress', arguments: { name } });
    progressText = readProgress.content?.[0]?.text || '';
    assert(/- \[~\] second/.test(progressText), 'Item 2 should be in_progress');

    // 8) progress_set_state by match (complete the one containing "third")
    await client.callTool({ name: 'progress_set_state', arguments: { name, match: 'third', state: 'completed' } });
    readProgress = await client.callTool({ name: 'read_progress', arguments: { name } });
    progressText = readProgress.content?.[0]?.text || '';
    assert(/- \[x\] third/.test(progressText), 'Item matched by text should be completed');

    // 8.1) read_progress filter tests
    const onlyTodo = await client.callTool({ name: 'read_progress', arguments: { name, only: 'todo' } });
    const todoText = onlyTodo.content?.[0]?.text || '';
    assert(/- \[ \] first/.test(todoText), 'Filter todo should include pending first');
    assert(!/second/.test(todoText) && !/third/.test(todoText), 'Filter todo should exclude other states');

    const onlyDoing = await client.callTool({ name: 'read_progress', arguments: { name, only: 'in_progress' } });
    const doingText = onlyDoing.content?.[0]?.text || '';
    assert(/- \[~\] second/.test(doingText), 'Filter in_progress should include second');

    const onlyDone = await client.callTool({ name: 'read_progress', arguments: { name, only: 'done' } });
    const doneText = onlyDone.content?.[0]?.text || '';
    assert(/- \[x\] third/.test(doneText), 'Filter done should include third');

    // 9) progress_mark_complete by text (complete first)
    await client.callTool({ name: 'progress_mark_complete', arguments: { name, match: 'first' } });
    readProgress = await client.callTool({ name: 'read_progress', arguments: { name } });
    progressText = readProgress.content?.[0]?.text || '';
    assert(/- \[x\] first/.test(progressText), 'Item 1 should be completed');

    // 9.1) progress_add with list, including duplicate should skip
    const bulkAddRes = await client.callTool({ name: 'progress_add', arguments: { name, item: ['fourth', 'third'] } });
    const bulkAdd = JSON.parse(bulkAddRes.content?.[0]?.text || '{}');
    assert(Array.isArray(bulkAdd.added) && bulkAdd.added.includes('fourth'), 'Bulk add should include fourth');
    assert(Array.isArray(bulkAdd.skipped) && bulkAdd.skipped.includes('third'), 'Bulk add should skip duplicate third');

    // 9.2) progress_set_state with list; include a non-matching term and verify notMatched
    const setManyRes = await client.callTool({ name: 'progress_set_state', arguments: { name, match: ['fourth', '__nope__'], state: 'completed' } });
    const setMany = JSON.parse(setManyRes.content?.[0]?.text || '{}');
    assert(Array.isArray(setMany.changed) && setMany.changed.length >= 1, 'Should change at least one item');
    assert(Array.isArray(setMany.notMatched) && setMany.notMatched.includes('__nope__'), 'Should report notMatched terms');

    // 9.3) progress_set_state with no matches should prompt to pull list
    const noMatchRes = await client.callTool({ name: 'progress_set_state', arguments: { name, match: ['__really_nope_only__'], state: 'in_progress' } });
    const noMatch = JSON.parse(noMatchRes.content?.[0]?.text || '{}');
    assert(Array.isArray(noMatch.changed) && noMatch.changed.length === 0, 'No matches should return empty changed');
    assert(typeof noMatch.notice === 'string' && /pull updated list/i.test(noMatch.notice), 'Should include notice to pull updated list');
    assert(noMatch.suggest === 'read_progress', 'Should suggest read_progress');

    // 9.4) write_progress with JSON list content on a new project
    const name3 = `${name}_arr`;
    await client.callTool({ name: 'init_project', arguments: { name: name3 } });
    await client.callTool({ name: 'write_progress', arguments: { name: name3, content: ['A', 'B'] } });
    const rp3 = await client.callTool({ name: 'read_progress', arguments: { name: name3 } });
    const pt3 = rp3.content?.[0]?.text || '';
    assert(/- \[ \] A/.test(pt3) && /- \[ \] B/.test(pt3), 'write_progress should accept JSON list content');

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

    // 13) get_agents_md_examples returns philosophy example and always includes the art field
    const ex1Res = await client.callTool({ name: 'get_agents_md_examples', arguments: { only: 'philosophy' } });
    const ex1 = JSON.parse(ex1Res.content?.[0]?.text || '{}');
    assert(typeof ex1.the_art_of_writing_agents_md === 'string' && ex1.the_art_of_writing_agents_md.length > 0, 'Should include the_art_of_writing_agents_md');
    assert(Array.isArray(ex1.examples), 'examples should be an array');
    if (ex1.examples.length > 0) {
      const allMatch = ex1.examples.every(e => String(e.usecase || e.title || '').toLowerCase().includes('philosophy'));
      assert(allMatch, 'Filtered examples should relate to philosophy');
    }
    // Also test list input for only
    const ex2Res = await client.callTool({ name: 'get_agents_md_examples', arguments: { only: ['philosophy'] } });
    const ex2 = JSON.parse(ex2Res.content?.[0]?.text || '{}');
    assert(typeof ex2.the_art_of_writing_agents_md === 'string' && ex2.the_art_of_writing_agents_md.length > 0, 'List filter should also include art field');

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
