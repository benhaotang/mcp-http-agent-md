import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import initSqlJs from 'sql.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.resolve(__dirname, '..', 'data');
const DB_PATH = process.env.DATABASE_PATH || path.join(DATA_DIR, 'app.sqlite');

let sqlModule = null;
let dbInstance = null;

async function ensureDataDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function openDb() {
  if (dbInstance) return dbInstance;
  await ensureDataDir();
  if (!sqlModule) {
    const wasmPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', 'sql.js', 'dist');
    sqlModule = await initSqlJs({ locateFile: (file) => path.join(wasmPath, file) });
  }
  let db;
  try {
    const buf = await fs.readFile(DB_PATH);
    db = new sqlModule.Database(new Uint8Array(buf));
  } catch {
    db = new sqlModule.Database();
  }
  // Schema
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT,
      api_key TEXT UNIQUE NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS user_projects (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      agent_json TEXT NOT NULL,
      progress_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT,
      UNIQUE(user_id, name),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    -- Structured tasks per project
    CREATE TABLE IF NOT EXISTS project_tasks (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      task_id TEXT NOT NULL, -- exactly 8 lowercase a-z0-9
      task_info TEXT NOT NULL,
      parent_id TEXT, -- references task_id within same project (not FK-enforced)
      status TEXT NOT NULL, -- 'pending' | 'in_progress' | 'completed'
      extra_note TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT,
      UNIQUE(user_id, project_id, task_id),
      FOREIGN KEY (project_id) REFERENCES user_projects(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_user_project ON project_tasks(user_id, project_id);
  `);
  // Enable foreign key constraints in SQLite (helps catch bad user_id early)
  try { db.exec('PRAGMA foreign_keys = ON;'); } catch {}
  dbInstance = db;
  return dbInstance;
}

async function persistDb() {
  if (!dbInstance) return;
  const data = dbInstance.export();
  await fs.writeFile(DB_PATH, Buffer.from(data));
}

function newApiKey() {
  return crypto.randomBytes(24).toString('hex');
}

function newUserId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const s = b.toString('hex');
  return `${s.slice(0,8)}-${s.slice(8,12)}-${s.slice(12,16)}-${s.slice(16,20)}-${s.slice(20)}`;
}

export async function createUser({ name } = {}) {
  const db = await openDb();
  const user = {
    id: newUserId(),
    apiKey: newApiKey(),
    name: name || null,
    createdAt: new Date().toISOString(),
  };
  const stmt = db.prepare('INSERT INTO users (id, name, api_key, created_at) VALUES ($id, $name, $apiKey, $createdAt)');
  stmt.bind({ $id: user.id, $name: user.name, $apiKey: user.apiKey, $createdAt: user.createdAt });
  stmt.step();
  stmt.free();
  await persistDb();
  return user;
}

export async function listUsers() {
  const db = await openDb();
  const stmt = db.prepare('SELECT id, name, api_key, created_at, updated_at FROM users ORDER BY created_at ASC');
  const rows = [];
  while (stmt.step()) {
    const r = stmt.getAsObject();
    rows.push({
      id: r.id,
      name: r.name || null,
      apiKey: r.api_key,
      createdAt: r.created_at,
      updatedAt: r.updated_at || null,
    });
  }
  stmt.free();
  return rows;
}

export async function getUserById(id) {
  const db = await openDb();
  const stmt = db.prepare('SELECT id, name, api_key, created_at, updated_at FROM users WHERE id = $id');
  stmt.bind({ $id: id });
  const exists = stmt.step();
  if (!exists) { stmt.free(); return null; }
  const r = stmt.getAsObject();
  stmt.free();
  return { id: r.id, name: r.name || null, apiKey: r.api_key, createdAt: r.created_at, updatedAt: r.updated_at || null };
}

export async function getUserByApiKey(apiKey) {
  const db = await openDb();
  const stmt = db.prepare('SELECT id, name, api_key, created_at, updated_at FROM users WHERE api_key = $k');
  stmt.bind({ $k: apiKey });
  const exists = stmt.step();
  if (!exists) { stmt.free(); return null; }
  const r = stmt.getAsObject();
  stmt.free();
  return { id: r.id, name: r.name || null, apiKey: r.api_key, createdAt: r.created_at, updatedAt: r.updated_at || null };
}

export async function deleteUser(id) {
  const db = await openDb();
  const stmt = db.prepare('DELETE FROM users WHERE id = $id');
  stmt.bind({ $id: id });
  const startRows = db.prepare('SELECT changes() AS c').getAsObject().c || 0;
  stmt.step();
  stmt.free();
  await persistDb();
  const endRows = db.prepare('SELECT changes() AS c').getAsObject().c || 0;
  return endRows > startRows;
}

export async function regenerateApiKey(id) {
  const db = await openDb();
  const apiKey = newApiKey();
  const updatedAt = new Date().toISOString();
  const stmt = db.prepare('UPDATE users SET api_key = $k, updated_at = $u WHERE id = $id');
  stmt.bind({ $k: apiKey, $u: updatedAt, $id: id });
  stmt.step();
  stmt.free();
  await persistDb();
  return await getUserById(id);
}

export default {
  createUser,
  listUsers,
  getUserByApiKey,
  getUserById,
  regenerateApiKey,
  deleteUser,
};

// ---------------- Project + Files APIs (per-user) ----------------

export async function listProjects(userId) {
  const db = await openDb();
  const stmt = db.prepare('SELECT name FROM user_projects WHERE user_id = $u ORDER BY name');
  stmt.bind({ $u: userId });
  const names = [];
  while (stmt.step()) {
    const r = stmt.getAsObject();
    names.push(r.name);
  }
  stmt.free();
  return names;
}

export async function getProjectByName(userId, name) {
  const db = await openDb();
  const stmt = db.prepare('SELECT id, name FROM user_projects WHERE user_id = $u AND name = $n');
  stmt.bind({ $u: userId, $n: name });
  const ok = stmt.step();
  if (!ok) { stmt.free(); return null; }
  const r = stmt.getAsObject();
  stmt.free();
  return { id: r.id, name: r.name };
}

export async function listUserTaskIds(userId) {
  const db = await openDb();
  const stmt = db.prepare('SELECT task_id FROM project_tasks WHERE user_id = $u');
  stmt.bind({ $u: userId });
  const ids = [];
  while (stmt.step()) {
    const r = stmt.getAsObject();
    ids.push(String(r.task_id));
  }
  stmt.free();
  return ids;
}

export async function initProject(userId, name, { agentJson, progressJson }) {
  const db = await openDb();
  const now = new Date().toISOString();
  if (!userId) throw new Error('user not authenticated');
  if (!name) throw new Error('project name required');
  const upsert = db.prepare(`
    INSERT INTO user_projects (id, user_id, name, agent_json, progress_json, created_at, updated_at)
    VALUES ($id, $u, $n, $a, $p, $c, $uAt)
    ON CONFLICT(user_id, name) DO UPDATE SET
      agent_json = excluded.agent_json,
      progress_json = excluded.progress_json,
      updated_at = excluded.updated_at
  `);
  upsert.bind({ $id: newUserId(), $u: userId, $n: name, $a: agentJson, $p: progressJson, $c: now, $uAt: now });
  upsert.step();
  upsert.free();
  await persistDb();
  return { name };
}

export async function deleteProject(userId, name) {
  const db = await openDb();
  const stmt = db.prepare('DELETE FROM user_projects WHERE user_id = $u AND name = $n');
  stmt.bind({ $u: userId, $n: name });
  stmt.step();
  stmt.free();
  await persistDb();
}

export async function renameProject(userId, oldName, newName) {
  const db = await openDb();
  const now = new Date().toISOString();
  const stmt = db.prepare('UPDATE user_projects SET name = $new, updated_at = $now WHERE user_id = $u AND name = $old');
  stmt.bind({ $new: newName, $now: now, $u: userId, $old: oldName });
  stmt.step();
  stmt.free();
  await persistDb();
  return { name: newName };
}

export async function readDoc(userId, name, which) {
  const db = await openDb();
  const stmt = db.prepare('SELECT agent_json, progress_json FROM user_projects WHERE user_id = $u AND name = $n');
  stmt.bind({ $u: userId, $n: name });
  const exists = stmt.step();
  if (!exists) { stmt.free(); throw new Error('project not found'); }
  const r = stmt.getAsObject();
  stmt.free();
  const raw = which === 'agent' ? r.agent_json : r.progress_json;
  try {
    const obj = JSON.parse(raw || '{}');
    return String(obj.content || '');
  } catch {
    return String(raw || '');
  }
}

export async function writeDoc(userId, name, which, content) {
  const db = await openDb();
  const now = new Date().toISOString();
  const col = which === 'agent' ? 'agent_json' : 'progress_json';
  const json = JSON.stringify({ content: String(content ?? '') });
  // Require project to exist; do not auto-create on write
  const existsStmt = db.prepare('SELECT id FROM user_projects WHERE user_id = $u AND name = $n');
  existsStmt.bind({ $u: userId, $n: name });
  const found = existsStmt.step();
  existsStmt.free();
  if (!found) {
    throw new Error('project not found');
  }
  const stmt = db.prepare(`UPDATE user_projects SET ${col} = $val, updated_at = $now WHERE user_id = $u AND name = $n`);
  stmt.bind({ $val: json, $now: now, $u: userId, $n: name });
  stmt.step();
  stmt.free();
  await persistDb();
}

export const _internal = { openDb, persistDb };

// ---------------- Structured Tasks APIs ----------------

export async function listTasks(userId, projectName, { only } = {}) {
  const db = await openDb();
  const proj = await getProjectByName(userId, projectName);
  if (!proj) throw new Error('project not found');
  const rows = [];
  let query = 'SELECT task_id, task_info, parent_id, status, extra_note, created_at, updated_at FROM project_tasks WHERE user_id = $u AND project_id = $p';
  let bind = { $u: userId, $p: proj.id };
  if (Array.isArray(only) && only.length) {
    const placeholders = only.map((_, i) => `$s${i}`);
    query += ` AND status IN (${placeholders.join(',')})`;
    only.forEach((s, i) => { bind[`$s${i}`] = String(s); });
  } else {
    // Default exclude archived
    query += ' AND status != $archived';
    bind.$archived = 'archived';
  }
  query += ' ORDER BY created_at ASC';
  const stmt = db.prepare(query);
  stmt.bind(bind);
  while (stmt.step()) {
    const r = stmt.getAsObject();
    rows.push({
      task_id: r.task_id,
      task_info: r.task_info,
      parent_id: r.parent_id || null,
      status: r.status,
      extra_note: r.extra_note || null,
      created_at: r.created_at,
      updated_at: r.updated_at || null,
    });
  }
  stmt.free();
  return rows;
}

export async function addTasks(userId, projectName, tasks) {
  const db = await openDb();
  const proj = await getProjectByName(userId, projectName);
  if (!proj) throw new Error('project not found');
  const now = new Date().toISOString();
  const added = [];
  const exists = [];
  const check = db.prepare('SELECT 1 FROM project_tasks WHERE user_id = $u AND project_id = $p AND task_id = $tid LIMIT 1');
  for (const t of tasks) {
    // pre-check for duplicates
    check.bind({ $u: userId, $p: proj.id, $tid: t.task_id });
    const already = check.step();
    check.reset();
    if (already) { exists.push(t.task_id); continue; }
    const rowId = newUserId();
    const stmt = db.prepare(`
      INSERT INTO project_tasks (id, user_id, project_id, task_id, task_info, parent_id, status, extra_note, created_at)
      VALUES ($id, $u, $p, $tid, $info, $pid, $st, $note, $now)
    `);
    stmt.bind({
      $id: rowId,
      $u: userId,
      $p: proj.id,
      $tid: t.task_id,
      $info: t.task_info,
      $pid: t.parent_id || null,
      $st: t.status,
      $note: t.extra_note || null,
      $now: now,
    });
    stmt.step();
    stmt.free();
    added.push(t.task_id);
  }
  check.free();
  await persistDb();
  return { added, exists };
}

export async function replaceTasks(userId, projectName, tasks) {
  const db = await openDb();
  const proj = await getProjectByName(userId, projectName);
  if (!proj) throw new Error('project not found');
  // Delete existing tasks for this project
  const del = db.prepare('DELETE FROM project_tasks WHERE user_id = $u AND project_id = $p');
  del.bind({ $u: userId, $p: proj.id });
  del.step();
  del.free();
  await persistDb();
  // Add all new tasks
  return await addTasks(userId, projectName, tasks);
}

export async function setTasksState(userId, projectName, { matchIds = [], matchText = [], state, task_info, parent_id, extra_note }) {
  const db = await openDb();
  const proj = await getProjectByName(userId, projectName);
  if (!proj) throw new Error('project not found');
  const now = new Date().toISOString();
  const changedIds = new Set();
  const notMatched = [];
  const forbidden = [];

  // Update by IDs
  const selById = db.prepare('SELECT status FROM project_tasks WHERE user_id = $u AND project_id = $p AND task_id = $tid');
  for (const tid of matchIds) {
    selById.bind({ $u: userId, $p: proj.id, $tid: tid });
    const exists = selById.step();
    selById.reset();
    if (!exists) { notMatched.push(tid); continue; }
    const ok = applyUpdateForId(db, { userId, projectId: proj.id, tid, now, state, task_info, parent_id, extra_note });
    if (ok) changedIds.add(tid); else forbidden.push(tid);
  }

  // Update by text contains
  for (const term of matchText) {
    const q = db.prepare('SELECT task_id, task_info FROM project_tasks WHERE user_id = $u AND project_id = $p');
    q.bind({ $u: userId, $p: proj.id });
    let matchedAny = false;
    while (q.step()) {
      const r = q.getAsObject();
      if (String(r.task_info || '').toLowerCase().includes(String(term).toLowerCase())) {
        const ok = applyUpdateForId(db, { userId, projectId: proj.id, tid: r.task_id, now, state, task_info, parent_id, extra_note });
        if (ok) changedIds.add(r.task_id); else forbidden.push(r.task_id);
        matchedAny = true;
      }
    }
    q.free();
    if (!matchedAny) notMatched.push(term);
  }
  await persistDb();
  return { changedIds: Array.from(changedIds.values()), notMatched, forbidden };
}

function applyUpdateForId(db, { userId, projectId, tid, now, state, task_info, parent_id, extra_note }) {
  const { selfLocked, ancestorLocked, selfStatus } = getLockInfo(db, { userId, projectId, tid });
  const newState = state || null;
  const isUnlocking = (selfLocked && (newState === 'pending' || newState === 'in_progress'));
  // Forbid if any ancestor is locked (completed/archived)
  if (ancestorLocked) return false;
  // Forbid field updates when self is locked
  const wantsFieldUpdate = (typeof task_info !== 'undefined') || (typeof parent_id !== 'undefined') || (typeof extra_note !== 'undefined');
  if (wantsFieldUpdate && selfLocked) return false;
  // If self is locked and attempting a status change that is not unlocking, forbid
  if (selfLocked && newState && !isUnlocking) return false;

  const fields = [];
  const bind = { $u: userId, $p: projectId, $tid: tid, $now: now };
  if (typeof state !== 'undefined' && state) { fields.push('status = $st'); bind.$st = state; }
  if (typeof task_info !== 'undefined') { fields.push('task_info = $ti'); bind.$ti = String(task_info || ''); }
  if (typeof parent_id !== 'undefined') { fields.push('parent_id = $pid'); bind.$pid = parent_id || null; }
  if (typeof extra_note !== 'undefined') { fields.push('extra_note = $en'); bind.$en = extra_note || null; }
  fields.push('updated_at = $now');
  const sql = `UPDATE project_tasks SET ${fields.join(', ')} WHERE user_id = $u AND project_id = $p AND task_id = $tid`;
  const upd = db.prepare(sql);
  upd.bind(bind);
  upd.step();
  upd.free();
  // Cascade status to children when a new status is provided (any status)
  if (bind.$st) {
    cascadeSetStatus(db, { userId, projectId, rootId: tid, now, status: bind.$st });
  }
  return true;
}

function cascadeSetStatus(db, { userId, projectId, rootId, now, status }) {
  const seen = new Set();
  const queue = [rootId];
  while (queue.length) {
    const current = queue.shift();
    if (seen.has(current)) continue;
    seen.add(current);
    // children are tasks whose parent_id equals current
    const q = db.prepare('SELECT task_id FROM project_tasks WHERE user_id = $u AND project_id = $p AND parent_id = $pid');
    q.bind({ $u: userId, $p: projectId, $pid: current });
    const toArchive = [];
    while (q.step()) {
      const r = q.getAsObject();
      toArchive.push(r.task_id);
    }
    q.free();
    for (const tid of toArchive) {
      const upd = db.prepare('UPDATE project_tasks SET status = $st, updated_at = $now WHERE user_id = $u AND project_id = $p AND task_id = $tid');
      upd.bind({ $st: status, $now: now, $u: userId, $p: projectId, $tid: tid });
      upd.step();
      upd.free();
      queue.push(tid);
    }
  }
}

function getLockInfo(db, { userId, projectId, tid }) {
  const lockedStatuses = new Set(['completed', 'archived']);
  let selfLocked = false;
  let selfStatus = null;
  // Fetch self
  const selfStmt = db.prepare('SELECT parent_id, status FROM project_tasks WHERE user_id = $u AND project_id = $p AND task_id = $tid');
  selfStmt.bind({ $u: userId, $p: projectId, $tid: tid });
  const exists = selfStmt.step();
  if (!exists) { selfStmt.free(); return { selfLocked: false, ancestorLocked: false, selfStatus: null }; }
  let row = selfStmt.getAsObject();
  selfStmt.free();
  selfStatus = String(row.status || 'pending');
  if (lockedStatuses.has(selfStatus)) selfLocked = true;
  // Walk ancestors
  let parent = row.parent_id || null;
  const seen = new Set();
  while (parent) {
    if (seen.has(parent)) break; // avoid cycles
    seen.add(parent);
    const pStmt = db.prepare('SELECT parent_id, status FROM project_tasks WHERE user_id = $u AND project_id = $p AND task_id = $tid');
    pStmt.bind({ $u: userId, $p: projectId, $tid: parent });
    const ok = pStmt.step();
    if (!ok) { pStmt.free(); break; }
    const pr = pStmt.getAsObject();
    pStmt.free();
    const st = String(pr.status || 'pending');
    if (lockedStatuses.has(st)) return { selfLocked, ancestorLocked: true, selfStatus };
    parent = pr.parent_id || null;
  }
  return { selfLocked, ancestorLocked: false, selfStatus };
}

export async function deleteAllTasks(userId, projectName) {
  const db = await openDb();
  const proj = await getProjectByName(userId, projectName);
  if (!proj) throw new Error('project not found');
  const del = db.prepare('DELETE FROM project_tasks WHERE user_id = $u AND project_id = $p');
  del.bind({ $u: userId, $p: proj.id });
  del.step();
  del.free();
  await persistDb();
}
