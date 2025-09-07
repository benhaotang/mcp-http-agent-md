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

    // 0) write to non-existent project should return error payload
    const badWrite = await client.callTool({ name: 'write_agent', arguments: { name: '__no_such_project__', content: 'x' } });
    const badPayload = JSON.parse(badWrite.content?.[0]?.text || '{}');
    assert(badPayload.error === 'project_not_found', 'write_agent should error for non-existent project');
    // Also ensure state updates error when project does not exist
    const badState = await client.callTool({ name: 'progress_set_new_state', arguments: { name: '__no_such_project__', match: ['ffffffff'], state: 'completed' } });
    const badStatePayload = JSON.parse(badState.content?.[0]?.text || '{}');
    assert(badStatePayload.error === 'project_not_found', 'progress_set_new_state should error for non-existent project');

    // 1) tools/list
    const list = await client.listTools({});
    const toolNames = (list.tools || []).map(t => t.name).sort();
    const expected = [
      'list_projects','init_project','delete_project','rename_project',
      'read_agent','write_agent','read_progress',
      'progress_add','progress_set_new_state',
      'get_agents_md_best_practices_and_examples','generate_task_ids'
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

    // 4.1) write_agent patch mode (explicit)
    const patch1 = [
      '--- a/AGENTS.md',
      '+++ b/AGENTS.md',
      '@@ -1,2 +1,3 @@',
      ' # agent',
      '-Hello',
      '+Hello world',
      '+New line'
    ].join('\n');
    await client.callTool({ name: 'write_agent', arguments: { name, mode: 'patch', patch: patch1 } });
    const readAgent2b = await client.callTool({ name: 'read_agent', arguments: { name } });
    const agentText2b = readAgent2b.content?.[0]?.text || '';
    assert(agentText2b.includes('Hello world') && agentText2b.includes('New line'), 'patch mode should update content via unified diff');

    // 4.2) write_agent patch mode inferred by presence of patch (no mode provided)
    const patch2 = [
      '--- a/AGENTS.md',
      '+++ b/AGENTS.md',
      '@@ -1,3 +1,4 @@',
      ' # agent',
      '-Hello world',
      '+Hello world!!!',
      ' New line',
      '+More'
    ].join('\n');
    await client.callTool({ name: 'write_agent', arguments: { name, patch: patch2 } });
    const readAgent2c = await client.callTool({ name: 'read_agent', arguments: { name } });
    const agentText2c = readAgent2c.content?.[0]?.text || '';
    assert(agentText2c.includes('Hello world!!!') && agentText2c.includes('More'), 'implicit patch mode should apply when patch is provided');

    // 5) Add structured tasks (8-char IDs)
    const t1 = { task_id: 'a1b2c3d4', task_info: 'first', status: 'pending' };
    const t2 = { task_id: 'b2c3d4e5', task_info: 'second', status: 'in_progress' };
    const t3 = { task_id: 'c3d4e5f6', task_info: 'third', status: 'completed' };
    const addTasksRes = await client.callTool({ name: 'progress_add', arguments: { name, item: [t1, t2, t3] } });
    const addTasks = JSON.parse(addTasksRes.content?.[0]?.text || '{}');
    assert(Array.isArray(addTasks.added) && addTasks.added.length === 3, 'Should add three tasks');

    // Attempt to update non-existent task should error
    const noMatch = await client.callTool({ name: 'progress_set_new_state', arguments: { name, match: ['zzzzzzzz'], state: 'completed' } });
    const noMatchPayload = JSON.parse(noMatch.content?.[0]?.text || '{}');
    assert(noMatchPayload.error === 'task_not_found', 'Should error when no matching tasks found');

    // 6) read_progress returns JSON tasks and filter by status
    let readProgress = await client.callTool({ name: 'read_progress', arguments: { name } });
    let tasksPayload = JSON.parse(readProgress.content?.[0]?.text || '{}');
    assert(Array.isArray(tasksPayload.tasks) && tasksPayload.tasks.length >= 3, 'Should list tasks');
    const ids = tasksPayload.tasks.map(t => t.task_id);
    assert(ids.includes('a1b2c3d4') && ids.includes('b2c3d4e5') && ids.includes('c3d4e5f6'), 'Should contain all task ids');

    const onlyPending = await client.callTool({ name: 'read_progress', arguments: { name, only: 'pending' } });
    const onlyPendingJson = JSON.parse(onlyPending.content?.[0]?.text || '{}');
    assert(onlyPendingJson.tasks.every(t => t.status === 'pending'), 'Filter pending should include only pending');
    const onlyDoing = await client.callTool({ name: 'read_progress', arguments: { name, only: 'in_progress' } });
    const onlyDoingJson = JSON.parse(onlyDoing.content?.[0]?.text || '{}');
    assert(onlyDoingJson.tasks.every(t => t.status === 'in_progress'), 'Filter in_progress should include only in_progress');
    const onlyDone = await client.callTool({ name: 'read_progress', arguments: { name, only: 'done' } });
    const onlyDoneJson = JSON.parse(onlyDone.content?.[0]?.text || '{}');
    assert(onlyDoneJson.tasks.every(t => t.status === 'completed'), 'Filter done should include only completed');

    // 7) progress_add duplicate should report skipped list
    const dupRes = await client.callTool({ name: 'progress_add', arguments: { name, item: [{ task_id: 'c3d4e5f6', task_info: 'third-dup' }] } });
    const dup = JSON.parse(dupRes.content?.[0]?.text || '{}');
    assert(Array.isArray(dup.skipped) && dup.skipped.includes('c3d4e5f6'), 'Duplicate add should indicate skipped id');

    // 8) progress_set_new_state with list (one id and one non-matching id)
    const setRes = await client.callTool({ name: 'progress_set_new_state', arguments: { name, match: ['b2c3d4e5', 'ffffffff'], state: 'completed' } });
    const setPayload = JSON.parse(setRes.content?.[0]?.text || '{}');
    assert(Array.isArray(setPayload.changed) && setPayload.changed.includes('b2c3d4e5'), 'Should change b2c3d4e5');
    assert(Array.isArray(setPayload.notMatched) && setPayload.notMatched.includes('ffffffff'), 'Should report notMatched');

    // 9.4) progress_add structured tasks on a new project
    const name3 = `${name}_arr`;
    await client.callTool({ name: 'init_project', arguments: { name: name3 } });
    const tA = { task_id: 'abcd1234', task_info: 'A' };
    const tB = { task_id: 'bcde2345', task_info: 'B', parent_id: 'abcd1234' };
    const wr = await client.callTool({ name: 'progress_add', arguments: { name: name3, item: [tA, tB] } });
    const wrPayload = JSON.parse(wr.content?.[0]?.text || '{}');
    assert(Array.isArray(wrPayload.added) && wrPayload.added.length === 2, 'progress_add should add two tasks');
    const rp3 = await client.callTool({ name: 'read_progress', arguments: { name: name3 } });
    const pt3 = JSON.parse(rp3.content?.[0]?.text || '{}');
    const ids3 = pt3.tasks.map(t => t.task_id);
    assert(ids3.includes('abcd1234') && ids3.includes('bcde2345'), 'read_progress should list tasks we wrote');

    // 13) Update fields via progress_set_new_state: change task_info and extra_note of bcde2345
    const updRes = await client.callTool({ name: 'progress_set_new_state', arguments: { name: name3, match: ['bcde2345'], state: 'in_progress', task_info: 'B updated', extra_note: 'note' } });
    const upd = JSON.parse(updRes.content?.[0]?.text || '{}');
    assert(Array.isArray(upd.changed) && upd.changed.includes('bcde2345'), 'Should report changed id bcde2345');
    const rp4 = await client.callTool({ name: 'read_progress', arguments: { name: name3 } });
    const p4 = JSON.parse(rp4.content?.[0]?.text || '{}');
    const bRow = p4.tasks.find(t => t.task_id === 'bcde2345');
    assert(bRow && bRow.task_info === 'B updated' && bRow.extra_note === 'note' && bRow.status === 'in_progress', 'Fields should be updated');

    // 14) Archive root abcd1234; child bcde2345 should cascade to archived
    await client.callTool({ name: 'progress_set_new_state', arguments: { name: name3, match: ['abcd1234'], state: 'archived' } });
    const rp5 = await client.callTool({ name: 'read_progress', arguments: { name: name3 } });
    const p5 = JSON.parse(rp5.content?.[0]?.text || '{}');
    const ids5 = p5.tasks.map(t => t.task_id);
    assert(!ids5.includes('abcd1234') && !ids5.includes('bcde2345'), 'Default read excludes archived');
    const rp5arch = await client.callTool({ name: 'read_progress', arguments: { name: name3, only: 'archived' } });
    const p5a = JSON.parse(rp5arch.content?.[0]?.text || '{}');
    const ids5a = p5a.tasks.map(t => t.task_id);
    assert(ids5a.includes('abcd1234') && ids5a.includes('bcde2345'), 'Archived filter shows archived tasks including children');

    // 15) Completed cascades to children recursively
    const name4 = `${name}_cascade_complete`;
    await client.callTool({ name: 'init_project', arguments: { name: name4 } });
    const p1 = { task_id: 'aaaa1111', task_info: 'P1' };
    const c1 = { task_id: 'bbbb2222', task_info: 'C1', parent_id: 'aaaa1111' };
    const c2 = { task_id: 'cccc3333', task_info: 'C2', parent_id: 'bbbb2222' }; // deep child
    await client.callTool({ name: 'progress_add', arguments: { name: name4, item: [p1, c1, c2] } });
    await client.callTool({ name: 'progress_set_new_state', arguments: { name: name4, match: ['aaaa1111'], state: 'completed' } });
    const rp6 = await client.callTool({ name: 'read_progress', arguments: { name: name4, only: 'completed' } });
    const p6 = JSON.parse(rp6.content?.[0]?.text || '{}');
    const ids6 = new Set((p6.tasks || []).map(t => t.task_id));
    assert(ids6.has('aaaa1111') && ids6.has('bbbb2222') && ids6.has('cccc3333'), 'Completing parent should cascade to all descendants');

    // 15.1) Attempt to modify child while parent is locked (completed) should be forbidden
    const forbidEditRes = await client.callTool({ name: 'progress_set_new_state', arguments: { name: name4, match: ['bbbb2222'], task_info: 'C1 edited while locked' } });
    const forbidEdit = JSON.parse(forbidEditRes.content?.[0]?.text || '{}');
    assert(Array.isArray(forbidEdit.forbidden) && forbidEdit.forbidden.includes('bbbb2222'), 'Editing child fields should be forbidden when parent is locked');
    // Attempt to unlock child status alone should also be forbidden while ancestor locked
    const forbidUnlockChildRes = await client.callTool({ name: 'progress_set_new_state', arguments: { name: name4, match: ['bbbb2222'], state: 'pending' } });
    const forbidUnlockChild = JSON.parse(forbidUnlockChildRes.content?.[0]?.text || '{}');
    assert(Array.isArray(forbidUnlockChild.forbidden) && forbidUnlockChild.forbidden.includes('bbbb2222'), 'Unlocking child should be forbidden when ancestor is locked');

    // 15.2) Revert parent to in_progress; should cascade to descendants
    await client.callTool({ name: 'progress_set_new_state', arguments: { name: name4, match: ['aaaa1111'], state: 'in_progress' } });
    const rp7 = await client.callTool({ name: 'read_progress', arguments: { name: name4, only: 'in_progress' } });
    const p7 = JSON.parse(rp7.content?.[0]?.text || '{}');
    const ids7 = new Set((p7.tasks || []).map(t => t.task_id));
    assert(ids7.has('aaaa1111') && ids7.has('bbbb2222') && ids7.has('cccc3333'), 'Unlocking parent should cascade in_progress to all descendants');

    // 15.3) Now child can be edited
    const childEditRes = await client.callTool({ name: 'progress_set_new_state', arguments: { name: name4, match: ['bbbb2222'], task_info: 'C1 unlocked edit', extra_note: 'ok' } });
    const childEdit = JSON.parse(childEditRes.content?.[0]?.text || '{}');
    assert(Array.isArray(childEdit.changed) && childEdit.changed.includes('bbbb2222'), 'Child edit should be allowed after unlock');
    const rp8 = await client.callTool({ name: 'read_progress', arguments: { name: name4 } });
    const p8 = JSON.parse(rp8.content?.[0]?.text || '{}');
    const c1row = (p8.tasks || []).find(t => t.task_id === 'bbbb2222');
    assert(c1row && c1row.task_info === 'C1 unlocked edit' && c1row.extra_note === 'ok', 'Child fields should reflect unlocked edits');

    // 11) generate_task_ids returns unique 8-char ids not colliding with user tasks
    const genRes = await client.callTool({ name: 'generate_task_ids', arguments: { count: 5 } });
    const gen = JSON.parse(genRes.content?.[0]?.text || '{}');
    assert(Array.isArray(gen.ids) && gen.ids.length === 5, 'generate_task_ids should return requested count');
    const allValid = gen.ids.every(id => /^[a-z0-9]{8}$/.test(id));
    assert(allValid, 'All generated ids should be 8-char lowercase a-z0-9');
    const known = new Set(['a1b2c3d4','b2c3d4e5','c3d4e5f6','abcd1234','bcde2345']);
    const noneCollide = gen.ids.every(id => !known.has(id));
    assert(noneCollide, 'Generated ids should not collide with existing user tasks');

    // 12) Verify project_id consistency: project_tasks rows use the same id as user_projects.id
    // This is guaranteed by FK and our insert code; assert it explicitly.
    const { _internal: dbInternal, getProjectByName } = await import('./src/db.js');
    const db = await dbInternal.openDb();
    const projRow = await getProjectByName(created.id, name3);
    const stmt = db.prepare('SELECT DISTINCT project_id FROM project_tasks WHERE user_id = $u AND project_id = $p');
    stmt.bind({ $u: created.id, $p: projRow.id });
    const hasRow = stmt.step();
    stmt.free();
    assert(hasRow, 'Tasks should refer to the same project_id as user_projects.id');

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

    // 13) Best practices only by default, and include filters
    // Default (no include) should return only best-practices and no examples
    const ex0Res = await client.callTool({ name: 'get_agents_md_best_practices_and_examples', arguments: {} });
    const ex0 = JSON.parse(ex0Res.content?.[0]?.text || '{}');
    assert(typeof ex0.the_art_of_writing_agents_md === 'string' && ex0.the_art_of_writing_agents_md.length > 0, 'Should include the_art_of_writing_agents_md');
    assert(Array.isArray(ex0.examples) && ex0.examples.length === 0, 'Default should return no examples');

    // Filter by include
    const ex1Res = await client.callTool({ name: 'get_agents_md_best_practices_and_examples', arguments: { include: 'philosophy' } });
    const ex1 = JSON.parse(ex1Res.content?.[0]?.text || '{}');
    assert(typeof ex1.the_art_of_writing_agents_md === 'string' && ex1.the_art_of_writing_agents_md.length > 0, 'Should include the_art_of_writing_agents_md');
    assert(Array.isArray(ex1.examples), 'examples should be an array');
    if (ex1.examples.length > 0) {
      const allMatch = ex1.examples.every(e => String(e.usecase || e.title || '').toLowerCase().includes('philosophy'));
      assert(allMatch, 'Filtered examples should relate to philosophy');
    }
    // Also test list input for only
    const ex2Res = await client.callTool({ name: 'get_agents_md_best_practices_and_examples', arguments: { include: ['philosophy'] } });
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
