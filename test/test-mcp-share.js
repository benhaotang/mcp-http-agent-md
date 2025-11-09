import { spawn } from 'node:child_process';
import process from 'node:process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { decode as decodeToon } from '@toon-format/toon';

// Helper to parse MCP tool responses (toon or JSON format)
function parseResponse(text) {
  if (!text) return {};
  try {
    const decoded = decodeToon(text);
    return decoded;
  } catch (toonErr) {
    try {
      return JSON.parse(text);
    } catch (jsonErr) {
      return { _raw: text };
    }
  }
}

const PORT = process.env.TEST_PORT ? Number(process.env.TEST_PORT) : 43113;
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
      } catch (_) {}
    }, 150);
  });
}

function assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion failed'); }

async function createUser(mainKey, name) {
  const res = await fetch(`${BASE}/auth/users`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${mainKey}` },
    body: JSON.stringify({ name }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Failed to create user: ${res.status} ${JSON.stringify(json)}`);
  return json;
}

async function shareProject(mainOrOwnerAuthHeader, projectId, targetUserId, permission, revoke=false) {
  const res = await fetch(`${BASE}/project/share`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...mainOrOwnerAuthHeader },
    body: JSON.stringify({ project_id: projectId, target_user_id: targetUserId, permission, revoke }),
  });
  const json = await res.json();
  return { status: res.status, json };
}

async function adminList(mainKey) {
  const res = await fetch(`${BASE}/project/list`, { headers: { 'Authorization': `Bearer ${mainKey}` } });
  const json = await res.json();
  if (!res.ok) throw new Error(`Admin list failed: ${res.status} ${JSON.stringify(json)}`);
  return json.projects;
}

async function run() {
  const MAIN = 'test-main-key';
  console.log('Starting server for MCP share tests on port', PORT);
  const child = spawn(process.execPath, ['index.js'], {
    env: { ...process.env, PORT: String(PORT), MAIN_API_KEY: MAIN },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await waitForServer(child);
    const u1 = await createUser(MAIN, 'u1');
    const u2 = await createUser(MAIN, 'u2');

    // user1 creates project via MCP
    const projName = `mcp_share_${Date.now()}`;
    const client1 = new Client({ name: 'client1', version: '0.0.0' });
    const t1 = new StreamableHTTPClientTransport(new URL(`${MCP}?apiKey=${encodeURIComponent(u1.apiKey)}`));
    await client1.connect(t1);
    const initRes = await client1.callTool({ name: 'init_project', arguments: { name: projName } });
    const initJson = parseResponse(initRes.content?.[0]?.text || '{}');
    assert(initJson.hash, 'init_project should return hash');
    assert(initJson.id, 'init_project should return project id');
    const projectId = initJson.id;

    // verify project id via admin list
    const list = await adminList(MAIN);
    const row = list.find(p => p.id === projectId);
    assert(row && row.owner_id === u1.id && row.name === projName, 'Project should be owned by u1 with correct name');

    // user2 list should not show it
    const resNoAccessList = await fetch(`${BASE}/project/list?apiKey=${encodeURIComponent(u2.apiKey)}`);
    const jsonNoAccessList = await resNoAccessList.json();
    assert(!(jsonNoAccessList.projects || []).some(n => String(n).startsWith(projName)), 'No list before share');

    // user2 read should be project_not_found
    const client2 = new Client({ name: 'client2', version: '0.0.0' });
    const t2 = new StreamableHTTPClientTransport(new URL(`${MCP}?apiKey=${encodeURIComponent(u2.apiKey)}`));
    await client2.connect(t2);
    const readBefore = await client2.callTool({ name: 'read_agent', arguments: { project_id: projectId } });
    const readBeforeJson = parseResponse(readBefore.content?.[0]?.text || '{}');
    assert(readBeforeJson.error === 'project_not_found', 'read_agent should be project_not_found before share');

    // Share RO to u2
    const ownerHeader = { 'Authorization': `Bearer ${u1.apiKey}` };
    const sro = await shareProject(ownerHeader, projectId, u2.id, 'ro');
    assert(sro.status === 200, 'Share RO should succeed');

    // list_projects shows Read-Only suffix and project data
    const list2 = await client2.listTools({}); // ensure connected
    const listProjRes = await client2.callTool({ name: 'list_projects', arguments: {} });
    const listProjJson = parseResponse(listProjRes.content?.[0]?.text || '{}');
    const projects = listProjJson.projects || [];
    assert(Array.isArray(projects), 'list_projects should return array of project objects');
    const sharedProj = projects.find(p => p.id === projectId);
    assert(sharedProj && sharedProj.read_only === true, 'Shared project should have read_only flag');

    // write_agent should return read_only_project
    const writeRo = await client2.callTool({ name: 'write_agent', arguments: { project_id: projectId, content: '# agent\nfrom u2' } });
    const writeRoJson = parseResponse(writeRo.content?.[0]?.text || '{}');
    assert(writeRoJson.error === 'read_only_project', 'RO participant cannot write');

    // Upgrade to RW
    const srw = await shareProject({ 'Authorization': `Bearer ${MAIN}` }, projectId, u2.id, 'rw');
    assert(srw.status === 200 && srw.json.permission === 'rw', 'Upgrade to RW');

    // RW write should succeed and commit with Modified by
    await client2.callTool({ name: 'write_agent', arguments: { project_id: projectId, content: '# agent\nRW edit' } });
    const logsRes = await client2.callTool({ name: 'list_project_logs', arguments: { project_id: projectId } });
    const logsJson = parseResponse(logsRes.content?.[0]?.text || '{}');
    // Commit messages no longer have "Modified by" prefix since we have the modified_by field for blame

    // Test modified_by field in list_project_logs
    const logs = logsJson.logs || [];
    const lastLog = logs[logs.length - 1];
    assert(lastLog.modified_by === u2.name, 'Last commit should have modified_by set to u2 name');
    const firstLog = logs[0];
    assert(firstLog.modified_by === u1.name, 'First commit (init) should have modified_by set to u1 name');

    // Test project rename restriction for shared projects
    const renameAttempt = await client2.callTool({ name: 'rename_project', arguments: { project_id: projectId, newName: 'NewName' } });
    const renameJson = parseResponse(renameAttempt.content?.[0]?.text || '{}');
    assert(renameJson.error === 'forbidden', 'RW participant should not be able to rename project');
    
    // Test project delete restriction for shared projects
    const deleteAttempt = await client2.callTool({ name: 'delete_project', arguments: { project_id: projectId } });
    const deleteJson = parseResponse(deleteAttempt.content?.[0]?.text || '{}');
    assert(deleteJson.error === 'forbidden', 'RW participant should not be able to delete project');
    
    // Owner should be able to rename
    const ownerRename = await client1.callTool({ name: 'rename_project', arguments: { project_id: projectId, newName: 'OwnerRenamed' } });
    const ownerRenameJson = parseResponse(ownerRename.content?.[0]?.text || '{}');
    assert(ownerRenameJson.hash, 'Owner should be able to rename project and get hash back');

    // Test revert restriction to consecutive user commits
    // First, make u1 make a commit after u2's commit
    await client1.callTool({ name: 'write_agent', arguments: { project_id: projectId, content: '# agent\nU1 commit after U2', comment: 'U1 after U2' } });
    
    // Get current logs to find commit hashes
    const newLogsRes = await client1.callTool({ name: 'list_project_logs', arguments: { project_id: projectId } });
    const newLogsJson = parseResponse(newLogsRes.content?.[0]?.text || '{}');
    const newLogs = newLogsJson.logs || [];
    
    // Find commits by user
    const u1Commits = newLogs.filter(log => log.modified_by === u1.name);
    const u2Commits = newLogs.filter(log => log.modified_by === u2.name);
    
    assert(u1Commits.length >= 2, 'Should have at least 2 commits by u1');
    assert(u2Commits.length >= 1, 'Should have at least 1 commit by u2');
    
    // u2 should NOT be able to revert to their own commit since there are u1 commits after it
    // which would be discarded in a linear history
    const u2LatestHash = u2Commits[u2Commits.length - 1].hash;
    const revertToU2Latest = await client2.callTool({ name: 'revert_project', arguments: { project_id: projectId, hash: u2LatestHash } });
    const revertToU2LatestJson = parseResponse(revertToU2Latest.content?.[0]?.text || '{}');
    assert(revertToU2LatestJson.error, 'u2 should NOT be able to revert to their commit when it would discard others work');
    
    // u1 should be able to revert to their most recent commit (which is the latest overall)
    const u1LatestHash = u1Commits[u1Commits.length - 1].hash;
    const revertToU1Latest = await client1.callTool({ name: 'revert_project', arguments: { project_id: projectId, hash: u1LatestHash } });
    const revertToU1LatestJson = parseResponse(revertToU1Latest.content?.[0]?.text || '{}');
    assert(revertToU1LatestJson.hash === u1LatestHash, 'u1 should be able to revert to their latest commit');
    
    // But u2 should NOT be able to revert to u1's init commit (if there's a u2 commit in between)
    if (u1Commits.length > 1 && u2Commits.length > 0) {
      const u1InitHash = u1Commits[0].hash; // First commit by u1
      const revertToU1Init = await client2.callTool({ name: 'revert_project', arguments: { project_id: projectId, hash: u1InitHash } });
      const revertToU1InitJson = parseResponse(revertToU1Init.content?.[0]?.text || '{}');
      assert(revertToU1InitJson.error || revertToU1InitJson.message, 'u2 should not be able to revert to old u1 commit');
    }

    // Test read-only participant cannot revert
    // First, downgrade u2 to read-only
    const sro2 = await shareProject({ 'Authorization': `Bearer ${MAIN}` }, projectId, u2.id, 'ro');
    assert(sro2.status === 200 && sro2.json.permission === 'ro', 'Downgrade to RO');
    
    // u2 (now RO) should not be able to revert to any commit
    const roRevertAttempt = await client2.callTool({ name: 'revert_project', arguments: { project_id: projectId, hash: u1LatestHash } });
    const roRevertJson = parseResponse(roRevertAttempt.content?.[0]?.text || '{}');
    assert(roRevertJson.error === 'read_only_project', 'RO participant should not be able to revert project');

    console.log('MCP share tests passed');
  } catch (err) {
    console.error('MCP share tests failed:', err);
    process.exitCode = 1;
  } finally {
    // cleanup
    try { child.kill(); } catch {}
  }
}

run();

