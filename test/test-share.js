import { spawn } from 'node:child_process';
import process from 'node:process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const PORT = process.env.TEST_PORT ? Number(process.env.TEST_PORT) : 43112;
const BASE = `http://localhost:${PORT}`;
const MCP = `${BASE}/mcp`;

async function waitForServer(proc, timeoutMs = 8000) {
  const start = Date.now();
  return await new Promise((resolve, reject) => {
    let resolved = false;
    const onData = (data) => {
      const s = String(data || '');
      if (s.includes(`${BASE}/mcp`) || s.toLowerCase().includes('listening')) {
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
        const res = await fetch(MCP, { method: 'GET' });
        if ([200,401,404,405].includes(res.status)) {
          clearInterval(interval);
          if (!resolved) { resolved = true; resolve(true); }
        }
      } catch (_) {
        // keep waiting
      }
    }, 150);
  });
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'Assertion failed');
}

async function createUser(mainKey, name) {
  const res = await fetch(`${BASE}/auth/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${mainKey}` },
    body: JSON.stringify({ name }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Failed to create user: ${res.status} ${JSON.stringify(json)}`);
  return json; // { id, apiKey, name }
}

async function listProjectsAdmin(mainKey) {
  const res = await fetch(`${BASE}/project/list`, { headers: { 'Authorization': `Bearer ${mainKey}` } });
  const json = await res.json();
  if (!res.ok) throw new Error(`Admin list failed: ${res.status} ${JSON.stringify(json)}`);
  return json;
}

async function listProjectsUser(apiKey) {
  const res = await fetch(`${BASE}/project/list?apiKey=${encodeURIComponent(apiKey)}`);
  const json = await res.json();
  if (!res.ok) throw new Error(`User list failed: ${res.status} ${JSON.stringify(json)}`);
  return json;
}

async function shareProject(headers, body) {
  const res = await fetch(`${BASE}/project/share`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  return { status: res.status, json };
}

async function statusProject(headers, projectId, isUser = true) {
  const url = new URL(`${BASE}/project/status`);
  url.searchParams.set('project_id', projectId);
  const res = await fetch(url, { headers });
  const json = await res.json();
  return { status: res.status, json };
}

async function run() {
  const MAIN = 'test-main-key';
  console.log('Starting server for share tests on port', PORT);
  const child = spawn(process.execPath, ['index.js'], {
    env: { ...process.env, PORT: String(PORT), MAIN_API_KEY: MAIN },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await waitForServer(child);
    console.log('Server is up. Creating users...');

    const user1 = await createUser(MAIN, 'user1');
    const user2 = await createUser(MAIN, 'user2');
    assert(user1?.id && user1?.apiKey && user2?.id && user2?.apiKey, 'Users should be created');

    // Init MCP client for user1 and create a project
    const name = `shareproj_${Date.now()}`;
    const client1 = new Client({ name: 'test-client-share', version: '0.0.0' });
    const transport1 = new StreamableHTTPClientTransport(new URL(`${MCP}?apiKey=${encodeURIComponent(user1.apiKey)}`));
    await client1.connect(transport1);
    const initRes = await client1.callTool({ name: 'init_project', arguments: { name } });
    const initJson = JSON.parse(initRes.content?.[0]?.text || '{}');
    assert(initJson?.hash, 'init_project should return hash');

    // Admin list should include the project with owner info
    const adminList1 = await listProjectsAdmin(MAIN);
    const found = (adminList1.projects || []).find(p => p.name === name);
    assert(found && found.owner_id === user1.id, 'Admin list should include project with correct owner');
    const projectId = found.id;

    // User2 has no access yet
    const u2List0 = await listProjectsUser(user2.apiKey);
    assert(!(u2List0.projects || []).some(p => p.name.startsWith(name)), 'User2 should not see project before share');
    const u2Status0 = await statusProject({ 'Authorization': `Bearer ${user2.apiKey}` }, projectId);
    assert(u2Status0.status === 404, 'User2 status should be 404 without access');

    // Owner shares RO to user2
    const ownerHeaders = { 'Authorization': `Bearer ${user1.apiKey}` };
    const shareRo = await shareProject(ownerHeaders, { project_id: projectId, target_user_id: user2.id, permission: 'ro' });
    assert(shareRo.status === 200 && shareRo.json.permission === 'ro', 'Owner should share RO to user2');
    const ownerStatus1 = await statusProject(ownerHeaders, projectId);
    assert(Array.isArray(ownerStatus1.json.shared_read) && ownerStatus1.json.shared_read.some(u => u.id === user2.id), 'Owner status should list user2 under read');

    // User2 sees Read-Only tag and limited status
    const u2List1 = await listProjectsUser(user2.apiKey);
    const u2FoundRo = (u2List1.projects || []).find(p => p.name === `${name} (Read-Only)`);
    assert(u2FoundRo && u2FoundRo.id === projectId, 'User2 list should show RO with suffix');
    const u2Status1 = await statusProject({ 'Authorization': `Bearer ${user2.apiKey}` }, projectId);
    assert(u2Status1.status === 200 && u2Status1.json.your_permission === 'ro', 'User2 status should show ro permission');

    // User2 cannot re-share (not owner)
    const u2ShareTry = await shareProject({ 'Authorization': `Bearer ${user2.apiKey}` }, { project_id: projectId, target_user_id: user1.id, permission: 'ro' });
    assert(u2ShareTry.status === 403, 'User2 should not be allowed to share');

    // Admin upgrades to RW
    const adminShareRw = await shareProject({ 'Authorization': `Bearer ${MAIN}` }, { project_id: projectId, target_user_id: user2.id, permission: 'rw' });
    assert(adminShareRw.status === 200 && adminShareRw.json.permission === 'rw', 'Admin should upgrade to RW');
    const adminStatus2 = await statusProject({ 'Authorization': `Bearer ${MAIN}` }, projectId);
    assert(Array.isArray(adminStatus2.json.shared_read_write) && adminStatus2.json.shared_read_write.some(u => u.id === user2.id), 'Admin status should list user2 under read-write');
    assert(!(adminStatus2.json.shared_read || []).some(u => u.id === user2.id), 'User2 should not be listed under read after upgrade');

    // User2 list shows project without Read-Only suffix now
    const u2List2 = await listProjectsUser(user2.apiKey);
    const u2FoundRw = (u2List2.projects || []).find(p => p.id === projectId && p.name === name);
    assert(!!u2FoundRw, 'User2 list should include project name without suffix for RW');

    // Backup and revert still work (owner)
    const write1 = await client1.callTool({ name: 'write_agent', arguments: { name, content: '# agent\nowner edit' } });
    const logs1Res = await client1.callTool({ name: 'list_project_logs', arguments: { name } });
    const logs1 = JSON.parse(logs1Res.content?.[0]?.text || '{}');
    assert(Array.isArray(logs1.logs) && logs1.logs.length >= 2, 'Logs should have at least two entries');
    const initialHash = logs1.logs[0]?.hash; // initial commit first in history
    const headHash = logs1.logs[logs1.logs.length - 1]?.hash; // latest commit last
    assert(initialHash && headHash && initialHash !== headHash, 'Should have distinct initial and head hashes');

    // Revert to initial
    await client1.callTool({ name: 'revert_project', arguments: { name, hash: initialHash } });
    const readAgent = await client1.callTool({ name: 'read_agent', arguments: { name } });
    const agentContent = readAgent.content?.[0]?.text || '';
    assert(agentContent.includes(name), 'After revert, agent should include project name (default content)');

    // Owner revokes shares
    const revoke = await shareProject(ownerHeaders, { project_id: projectId, target_user_id: user2.id, revoke: true });
    assert(revoke.status === 200 && revoke.json.permission === 'none', 'Owner should revoke share');
    const u2Status2 = await statusProject({ 'Authorization': `Bearer ${user2.apiKey}` }, projectId);
    assert(u2Status2.status === 404, 'After revoke, user2 should not access status');

    console.log('All share tests passed');
    process.exit(0);
  } catch (err) {
    console.error('Share tests failed:', err);
    process.exit(1);
  } finally {
    try { child.kill(); } catch {}
  }
}

run();
