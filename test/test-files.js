import { spawn } from 'node:child_process';
import process from 'node:process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const PORT = process.env.TEST_PORT ? Number(process.env.TEST_PORT) : 43114;
const BASE = `http://localhost:${PORT}`;
const MCP = `${BASE}/mcp`;

async function waitForServer(proc, timeoutMs = 10000) {
  const start = Date.now();
  return await new Promise((resolve, reject) => {
    let resolved = false;
    const handleResolve = () => {
      if (!resolved) {
        resolved = true;
        resolve(true);
      }
    };
    const onData = (data) => {
      const s = String(data || '');
      if (s.includes(`${BASE}/mcp`) || s.toLowerCase().includes('listening')) {
        handleResolve();
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);

    const interval = setInterval(async () => {
      if (resolved) {
        clearInterval(interval);
        return;
      }
      if (Date.now() - start > timeoutMs) {
        clearInterval(interval);
        if (!resolved) reject(new Error('Server did not start in time'));
        return;
      }
      try {
        const res = await fetch(MCP, { method: 'GET' });
        if ([200, 401, 404, 405].includes(res.status)) {
          clearInterval(interval);
          handleResolve();
        }
      } catch (_) {
        // keep waiting
      }
    }, 200);
  });
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'Assertion failed');
}

async function createUser(mainKey, name) {
  const res = await fetch(`${BASE}/auth/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${mainKey}` },
    body: JSON.stringify({ name }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Failed to create user: ${res.status} ${JSON.stringify(json)}`);
  return json;
}

async function shareProject(ownerKey, body) {
  const res = await fetch(`${BASE}/project/share`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerKey}` },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  return { status: res.status, json };
}

async function uploadFile(apiKey, projectId, { name, content, type = 'text/plain', description }) {
  const form = new FormData();
  form.set('project_id', projectId);
  const file = new File([content], name, { type });
  form.set('file', file);
  if (typeof description !== 'undefined') {
    form.set('description', description);
  }
  const res = await fetch(`${BASE}/project/files`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  let json = null;
  try {
    json = await res.json();
  } catch (_) {
    json = null;
  }
  return { status: res.status, json };
}

async function listFiles(apiKey, projectId) {
  const res = await fetch(`${BASE}/project/files?project_id=${encodeURIComponent(projectId)}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  let json = null;
  try {
    json = await res.json();
  } catch (_) {
    json = null;
  }
  return { status: res.status, json };
}

async function deleteFile(apiKey, projectId, fileId) {
  const res = await fetch(`${BASE}/project/files/${encodeURIComponent(fileId)}?project_id=${encodeURIComponent(projectId)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  let json = null;
  try {
    json = await res.json();
  } catch (_) {
    json = null;
  }
  return { status: res.status, json };
}

async function createTempTextFile(prefix, content) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const filePath = path.join(dir, 'test.txt');
  await fs.writeFile(filePath, content, 'utf8');
  return { dir, filePath };
}

async function run() {
  const MAIN = 'test-main-key-files';
  console.log('Starting server for files tests on port', PORT);
  const child = spawn(process.execPath, ['index.js'], {
    env: { ...process.env, PORT: String(PORT), MAIN_API_KEY: MAIN },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await waitForServer(child);
    console.log('Server is up. Creating users...');

    const owner = await createUser(MAIN, 'files-owner');
    const rwUser = await createUser(MAIN, 'files-rw');
    const roUser = await createUser(MAIN, 'files-ro');
    assert(owner?.apiKey && rwUser?.apiKey && roUser?.apiKey, 'Users should have api keys');

    const projectName = `filesproj_${Date.now()}`;
    const ownerClient = new Client({ name: 'test-client-files', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${MCP}?apiKey=${encodeURIComponent(owner.apiKey)}`));
    await ownerClient.connect(transport);
    const initRes = await ownerClient.callTool({ name: 'init_project', arguments: { name: projectName } });
    const initJson = JSON.parse(initRes.content?.[0]?.text || '{}');
    assert(initJson?.id, 'Project init should return id');
    const projectId = initJson.id;

    console.log('Sharing project to RW/RO users...');
    const shareRw = await shareProject(owner.apiKey, { project_id: projectId, target_user_id: rwUser.id, permission: 'rw' });
    assert(shareRw.status === 200 && shareRw.json.permission === 'rw', 'RW share should succeed');
    const shareRo = await shareProject(owner.apiKey, { project_id: projectId, target_user_id: roUser.id, permission: 'ro' });
    assert(shareRo.status === 200 && shareRo.json.permission === 'ro', 'RO share should succeed');

    console.log('Creating temp file for upload tests...');
    const { dir, filePath } = await createTempTextFile('mcp-files-', 'Initial owner upload for files testing');
    const fileContent = await fs.readFile(filePath, 'utf8');
    const uploadName = 'project-notes.txt';

    console.log('Owner upload...');
    const ownerDescription = 'Initial project notes with detailed summary of requirements.';
    const ownerUpload = await uploadFile(owner.apiKey, projectId, { name: uploadName, content: fileContent, description: ownerDescription });
    assert(ownerUpload.status === 200 && ownerUpload.json?.file?.file_id, 'Owner upload should succeed');
    const firstFileId = ownerUpload.json.file.file_id;

    const listForOwner = await listFiles(owner.apiKey, projectId);
    assert(listForOwner.status === 200, 'Owner should list files');
    assert(Array.isArray(listForOwner.json?.files) && listForOwner.json.files.length === 1, 'Exactly one file after first upload');
    const listed = listForOwner.json.files[0];
    assert(listed.original_name === uploadName, 'Filename should match');
    assert(listed.uploaded_by?.id === owner.id, 'Owner should be recorded as uploader');
    assert(listed.description === ownerDescription, 'Description should be stored on initial upload');

    console.log('RW user replaces the file...');
    const rwDescription = 'RW updated contents including follow-up notes and TODOs.';
    const rwUpload = await uploadFile(rwUser.apiKey, projectId, { name: uploadName, content: 'RW updated document contents.', description: rwDescription });
    assert(rwUpload.status === 200 && rwUpload.json?.file?.file_id, 'RW upload should succeed');
    assert(rwUpload.json.file.file_id !== firstFileId, 'Replacement should get a new file id');

    const listAfterRw = await listFiles(owner.apiKey, projectId);
    assert(listAfterRw.status === 200, 'Owner list after RW upload should succeed');
    assert(listAfterRw.json.files.length === 1, 'Still one file after replacement');
    const updated = listAfterRw.json.files[0];
    assert(updated.uploaded_by?.id === rwUser.id, 'Uploader should update to RW user');
    assert(updated.description === rwDescription, 'Description should update on re-upload');

    console.log('RO user can only list...');
    const roList = await listFiles(roUser.apiKey, projectId);
    assert(roList.status === 200 && Array.isArray(roList.json?.files), 'RO user should list files');
    assert(roList.json.files[0].description === rwDescription, 'RO list should include latest description');
    const roUploadAttempt = await uploadFile(roUser.apiKey, projectId, { name: 'ro.txt', content: 'RO should fail' });
    assert(roUploadAttempt.status === 403, 'RO upload attempt should be forbidden');
    const roDeleteAttempt = await deleteFile(roUser.apiKey, projectId, updated.file_id);
    assert(roDeleteAttempt.status === 403, 'RO delete attempt should be forbidden');

    console.log('RW user deletes file...');
    const rwDelete = await deleteFile(rwUser.apiKey, projectId, updated.file_id);
    assert(rwDelete.status === 200 && rwDelete.json?.ok, 'RW delete should succeed');

    const listAfterDelete = await listFiles(owner.apiKey, projectId);
    assert(listAfterDelete.status === 200 && listAfterDelete.json.files.length === 0, 'No files should remain after delete');

    await ownerClient.close();
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    console.log('Files tests passed.');
  } finally {
    child.kill('SIGTERM');
  }
}

const modulePath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === modulePath) {
  run().catch(err => {
    console.error(err);
    process.exitCode = 1;
  });
}

export default run;
