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
      hash TEXT,
      hash_history TEXT,
      ro_users_json TEXT, -- JSON array of user IDs with read-only access
      rw_users_json TEXT, -- JSON array of user IDs with read-write access
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
    -- Scratchpads: ephemeral per-session task sets (max 6 tasks per scratchpad)
    CREATE TABLE IF NOT EXISTS scratchpads (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      scratchpad_id TEXT NOT NULL,
      tasks_json TEXT NOT NULL, -- JSON array of up to 6 task objects
      common_memory TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT,
      UNIQUE(user_id, project_id, scratchpad_id),
      FOREIGN KEY (project_id) REFERENCES user_projects(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_scratchpads_user_project ON scratchpads(user_id, project_id);
    -- Backups table for versioning
    CREATE TABLE IF NOT EXISTS backups (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      hash TEXT NOT NULL,
      message TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      modified_by TEXT, -- user_id of the person who made this change
      created_at TEXT NOT NULL,
      UNIQUE(user_id, project_id, hash),
      FOREIGN KEY (project_id) REFERENCES user_projects(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_backups_user_project ON backups(user_id, project_id);
    -- Subagent run statuses
    CREATE TABLE IF NOT EXISTS subagent_runs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      status TEXT NOT NULL, -- pending | in_progress | success | failure
      created_at TEXT NOT NULL,
      updated_at TEXT,
      UNIQUE(user_id, project_id, run_id),
      FOREIGN KEY (project_id) REFERENCES user_projects(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_runs_user_project ON subagent_runs(user_id, project_id);
  `);
  // Enable foreign key constraints in SQLite (helps catch bad user_id early)
  try { db.exec('PRAGMA foreign_keys = ON;'); } catch {}
  // Lightweight migrations for existing DBs: add columns hash/hash_history if missing
  try {
    const rs = db.exec("PRAGMA table_info('user_projects')");
    const cols = new Set((rs && rs[0] && rs[0].values ? rs[0].values : []).map(r => String(r[1])));
    if (!cols.has('hash')) {
      try {
        db.exec("ALTER TABLE user_projects ADD COLUMN hash TEXT");
      } catch (err) {
        console.error("Failed to add 'hash' column to user_projects:", err);
      }
      // Verify column was added
      const rs2 = db.exec("PRAGMA table_info('user_projects')");
      const cols2 = new Set((rs2 && rs2[0] && rs2[0].values ? rs2[0].values : []).map(r => String(r[1])));
      if (!cols2.has('hash')) {
        console.error("Migration failed: 'hash' column still missing from user_projects after ALTER TABLE.");
      }
    }
    if (!cols.has('hash_history')) {
      try {
        db.exec("ALTER TABLE user_projects ADD COLUMN hash_history TEXT");
      } catch (err) {
        console.error("Failed to add 'hash_history' column to user_projects:", err);
      }
      // Verify column was added
      const rs3 = db.exec("PRAGMA table_info('user_projects')");
      const cols3 = new Set((rs3 && rs3[0] && rs3[0].values ? rs3[0].values : []).map(r => String(r[1])));
      if (!cols3.has('hash_history')) {
        console.error("Migration failed: 'hash_history' column still missing from user_projects after ALTER TABLE.");
      }
    }
    // Add share columns if missing
    if (!cols.has('ro_users_json')) {
      try {
        db.exec("ALTER TABLE user_projects ADD COLUMN ro_users_json TEXT");
      } catch (err) {
        console.error("Failed to add 'ro_users_json' column to user_projects:", err);
      }
    }
    if (!cols.has('rw_users_json')) {
      try {
        db.exec("ALTER TABLE user_projects ADD COLUMN rw_users_json TEXT");
      } catch (err) {
        console.error("Failed to add 'rw_users_json' column to user_projects:", err);
      }
    }
  } catch {}
  // Add modified_by column to backups table if missing
  try {
    const backupsRs = db.exec("PRAGMA table_info('backups')");
    const backupsCols = new Set((backupsRs && backupsRs[0] && backupsRs[0].values ? backupsRs[0].values : []).map(r => String(r[1])));
    if (!backupsCols.has('modified_by')) {
      try {
        db.exec("ALTER TABLE backups ADD COLUMN modified_by TEXT");
      } catch (err) {
        console.error("Failed to add 'modified_by' column to backups:", err);
      }
    }
  } catch {}
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
  // Legacy helper (not used by MCP tools). Prefer listProjectsForUserWithShares.
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

// ---------------- Sharing & Project Listing (with shares) ----------------

function parseJsonArrayOfStrings(s) {
  try {
    const v = JSON.parse(String(s || '[]'));
    if (Array.isArray(v)) return v.map(x => String(x)).filter(Boolean);
  } catch {}
  return [];
}

function uniqueStrings(list) {
  const seen = new Set();
  const out = [];
  for (const v of list) {
    if (!seen.has(v)) { seen.add(v); out.push(v); }
  }
  return out;
}

export async function getProjectById(projectId) {
  const db = await openDb();
  const stmt = db.prepare('SELECT id, user_id, name, ro_users_json, rw_users_json, created_at, updated_at FROM user_projects WHERE id = $id');
  stmt.bind({ $id: String(projectId) });
  const ok = stmt.step();
  if (!ok) { stmt.free(); return null; }
  const r = stmt.getAsObject();
  stmt.free();
  return {
    id: r.id,
    name: r.name,
    owner_id: r.user_id,
    ro_users: parseJsonArrayOfStrings(r.ro_users_json),
    rw_users: parseJsonArrayOfStrings(r.rw_users_json),
    created_at: r.created_at,
    updated_at: r.updated_at || null,
  };
}

export async function listAllProjectsAdmin() {
  const db = await openDb();
  const sql = `SELECT up.id, up.name, up.user_id, u.name AS owner_name
               FROM user_projects up LEFT JOIN users u ON up.user_id = u.id
               ORDER BY COALESCE(u.name, ''), up.name`;
  const stmt = db.prepare(sql);
  const rows = [];
  while (stmt.step()) {
    const r = stmt.getAsObject();
    rows.push({ id: r.id, name: r.name, owner_id: r.user_id, owner_name: r.owner_name || null });
  }
  stmt.free();
  return rows;
}

export async function listProjectsForUserWithShares(userId) {
  const db = await openDb();
  // Pre-select candidates by LIKE to reduce scan; we'll filter precisely after parsing JSON
  const like = `%${userId}%`;
  const stmt = db.prepare(`SELECT id, name, user_id, ro_users_json, rw_users_json FROM user_projects
                           WHERE user_id = $u OR ro_users_json LIKE $l OR rw_users_json LIKE $l`);
  stmt.bind({ $u: userId, $l: like });
  const list = [];
  while (stmt.step()) {
    const r = stmt.getAsObject();
    const ro = parseJsonArrayOfStrings(r.ro_users_json);
    const rw = parseJsonArrayOfStrings(r.rw_users_json);
    let permission = null;
    if (r.user_id === userId) permission = 'owner';
    else if (rw.includes(userId)) permission = 'rw';
    else if (ro.includes(userId)) permission = 'ro';
    if (permission) list.push({ id: r.id, name: r.name, owner_id: r.user_id, permission });
  }
  stmt.free();
  // Return owned + shared with dedupe
  return list;
}

// Resolve effective access for a user to a project by ID.
// Returns { owner_id, project_id, permission } or null.
export async function resolveProjectAccess(userId, projectId) {
  const proj = await getProjectById(projectId);
  if (!proj) return null;
  let permission = null;
  if (proj.owner_id === userId) permission = 'owner';
  else if (proj.rw_users.includes(userId)) permission = 'rw';
  else if (proj.ro_users.includes(userId)) permission = 'ro';
  if (!permission) return null;
  return { owner_id: proj.owner_id, project_id: proj.id, permission };
}

export async function setProjectShare(ownerId, projectId, targetUserId, permission) {
  const db = await openDb();
  const proj = await getProjectById(projectId);
  if (!proj) throw new Error('project not found');
  if (proj.owner_id !== ownerId) throw new Error('forbidden');
  const ro = new Set(proj.ro_users);
  const rw = new Set(proj.rw_users);
  // Clean up from both first
  ro.delete(targetUserId);
  rw.delete(targetUserId);
  if (permission === 'ro') ro.add(targetUserId);
  if (permission === 'rw') rw.add(targetUserId);
  const now = new Date().toISOString();
  const upd = db.prepare('UPDATE user_projects SET ro_users_json = $ro, rw_users_json = $rw, updated_at = $now WHERE id = $id');
  upd.bind({ $ro: JSON.stringify(Array.from(ro.values())), $rw: JSON.stringify(Array.from(rw.values())), $now: now, $id: proj.id });
  upd.step();
  upd.free();
  await persistDb();
  return { project_id: proj.id, owner_id: proj.owner_id, ro_users: Array.from(ro.values()), rw_users: Array.from(rw.values()) };
}

export async function revokeProjectShare(ownerId, projectId, targetUserId) {
  const db = await openDb();
  const proj = await getProjectById(projectId);
  if (!proj) throw new Error('project not found');
  if (proj.owner_id !== ownerId) throw new Error('forbidden');
  const ro = new Set(proj.ro_users);
  const rw = new Set(proj.rw_users);
  ro.delete(targetUserId);
  rw.delete(targetUserId);
  const now = new Date().toISOString();
  const upd = db.prepare('UPDATE user_projects SET ro_users_json = $ro, rw_users_json = $rw, updated_at = $now WHERE id = $id');
  upd.bind({ $ro: JSON.stringify(Array.from(ro.values())), $rw: JSON.stringify(Array.from(rw.values())), $now: now, $id: proj.id });
  upd.step();
  upd.free();
  await persistDb();
  return { project_id: proj.id, owner_id: proj.owner_id, ro_users: Array.from(ro.values()), rw_users: Array.from(rw.values()) };
}

export async function getProjectShareInfo(projectId) {
  const proj = await getProjectById(projectId);
  if (!proj) throw new Error('project not found');
  return proj;
}

export async function getProjectFullById(ownerId, projectId) {
  const db = await openDb();
  const stmt = db.prepare('SELECT id, name, user_id, agent_json, progress_json, hash, hash_history, created_at, updated_at FROM user_projects WHERE id = $pid AND user_id = $u');
  stmt.bind({ $pid: String(projectId), $u: ownerId });
  const ok = stmt.step();
  if (!ok) { stmt.free(); return null; }
  const r = stmt.getAsObject();
  stmt.free();
  return {
    id: r.id,
    name: r.name,
    owner_id: r.user_id,
    agent_json: r.agent_json || JSON.stringify({ content: '' }),
    progress_json: r.progress_json || JSON.stringify({ content: '' }),
    hash: r.hash || null,
    hash_history: r.hash_history || null,
    created_at: r.created_at,
    updated_at: r.updated_at || null,
  };
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
  const id = newUserId();
  const upsert = db.prepare(`
    INSERT INTO user_projects (id, user_id, name, agent_json, progress_json, created_at, updated_at)
    VALUES ($id, $u, $n, $a, $p, $c, $uAt)
    ON CONFLICT(user_id, name) DO UPDATE SET
      agent_json = excluded.agent_json,
      progress_json = excluded.progress_json,
      updated_at = excluded.updated_at
  `);
  upsert.bind({ $id: id, $u: userId, $n: name, $a: agentJson, $p: progressJson, $c: now, $uAt: now });
  upsert.step();
  upsert.free();
  // Read back the project id (handles the update-on-conflict case)
  const sel = db.prepare('SELECT id FROM user_projects WHERE user_id = $u AND name = $n');
  sel.bind({ $u: userId, $n: name });
  let pid = id;
  if (sel.step()) {
    pid = String(sel.getAsObject().id);
  }
  sel.free();
  await persistDb();
  return { id: pid, name };
}

export async function deleteProject(userId, projectId) {
  const db = await openDb();
  const stmt = db.prepare('DELETE FROM user_projects WHERE user_id = $u AND id = $pid');
  stmt.bind({ $u: userId, $pid: String(projectId) });
  stmt.step();
  stmt.free();
  await persistDb();
}

export async function renameProject(userId, projectId, newName) {
  const db = await openDb();
  const now = new Date().toISOString();
  const stmt = db.prepare('UPDATE user_projects SET name = $new, updated_at = $now WHERE user_id = $u AND id = $pid');
  stmt.bind({ $new: newName, $now: now, $u: userId, $pid: String(projectId) });
  stmt.step();
  stmt.free();
  await persistDb();
  return { name: newName };
}

export async function readDoc(userId, projectId, which) {
  const db = await openDb();
  const stmt = db.prepare('SELECT agent_json, progress_json FROM user_projects WHERE user_id = $u AND id = $pid');
  stmt.bind({ $u: userId, $pid: String(projectId) });
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

export async function writeDoc(userId, projectId, which, content) {
  const db = await openDb();
  const now = new Date().toISOString();
  const col = which === 'agent' ? 'agent_json' : 'progress_json';
  const json = JSON.stringify({ content: String(content ?? '') });
  // Require project to exist; do not auto-create on write
  const existsStmt = db.prepare('SELECT id FROM user_projects WHERE user_id = $u AND id = $pid');
  existsStmt.bind({ $u: userId, $pid: String(projectId) });
  const found = existsStmt.step();
  existsStmt.free();
  if (!found) {
    throw new Error('project not found');
  }
  const stmt = db.prepare(`UPDATE user_projects SET ${col} = $val, updated_at = $now WHERE user_id = $u AND id = $pid`);
  stmt.bind({ $val: json, $now: now, $u: userId, $pid: String(projectId) });
  stmt.step();
  stmt.free();
  await persistDb();
}

export const _internal = { openDb, persistDb };

// ---------------- Versioning APIs ----------------

function safeParseJson(s, fallback) {
  try { return JSON.parse(String(s || '')); } catch { return fallback; }
}

function canonicalize(obj) {
  const seen = new WeakSet();
  function sortValue(v) {
    if (v && typeof v === 'object') {
      if (seen.has(v)) return null;
      seen.add(v);
      if (Array.isArray(v)) return v.map(sortValue);
      const out = {};
      Object.keys(v).sort().forEach(k => { out[k] = sortValue(v[k]); });
      return out;
    }
    return v;
  }
  return JSON.stringify(sortValue(obj));
}

function computeHashForSnapshot(snapshotObj) {
  const json = canonicalize(snapshotObj);
  return crypto.createHash('sha256').update(json).digest('hex').slice(0, 40);
}

async function buildProjectSnapshot(db, { userId, projectRow }) {
  const projId = projectRow.id;
  const tasks = [];
  const q = db.prepare('SELECT task_id, task_info, parent_id, status, extra_note, created_at, updated_at FROM project_tasks WHERE user_id = $u AND project_id = $p ORDER BY created_at ASC');
  q.bind({ $u: userId, $p: projId });
  while (q.step()) {
    const r = q.getAsObject();
    tasks.push({
      task_id: String(r.task_id),
      task_info: String(r.task_info || ''),
      parent_id: r.parent_id || null,
      status: String(r.status || 'pending'),
      extra_note: r.extra_note || null,
      created_at: r.created_at,
      updated_at: r.updated_at || null,
    });
  }
  q.free();
  const agent = safeParseJson(projectRow.agent_json || '{}', {});
  const progress = safeParseJson(projectRow.progress_json || '{}', {});
  const snapshot = {
    user_id: userId,
    project_id: projId,
    name: projectRow.name,
    agent,
    progress,
    tasks,
    meta: {
      created_at: projectRow.created_at,
      updated_at: projectRow.updated_at || null,
    },
  };
  return snapshot;
}

export async function ensureProjectVersionInitialized(userId, projectId) {
  const db = await openDb();
  const proj = await getProjectFullById(userId, projectId);
  if (!proj) throw new Error('project not found');
  if (proj.hash && proj.hash.trim()) return proj.hash;
  const now = new Date().toISOString();
  const snapshot = await buildProjectSnapshot(db, { userId, projectRow: proj });
  const hash = computeHashForSnapshot(snapshot);
  const ins = db.prepare('INSERT INTO backups (id, user_id, project_id, hash, message, snapshot_json, modified_by, created_at) VALUES ($id, $u, $p, $h, $m, $s, $mb, $c)');
  ins.bind({ $id: newUserId(), $u: userId, $p: proj.id, $h: hash, $m: 'init', $s: JSON.stringify(snapshot), $mb: userId, $c: now });
  ins.step();
  ins.free();
  const history = [hash];
  const upd = db.prepare('UPDATE user_projects SET hash = $h, hash_history = $hh, updated_at = $now WHERE id = $pid');
  upd.bind({ $h: hash, $hh: JSON.stringify(history), $now: now, $pid: proj.id });
  upd.step();
  upd.free();
  await persistDb();
  return hash;
}

export async function createProjectBackup(userId, projectId, message, modifiedBy) {
  const db = await openDb();
  // Ensure exists and initialized
  const proj0 = await getProjectFullById(userId, projectId);
  if (!proj0) throw new Error('project not found');
  if (!proj0.hash) await ensureProjectVersionInitialized(userId, projectId);
  const proj = await getProjectFullById(userId, projectId);
  const now = new Date().toISOString();
  const snapshot = await buildProjectSnapshot(db, { userId, projectRow: proj });
  const hash = computeHashForSnapshot(snapshot);
  const ins = db.prepare('INSERT INTO backups (id, user_id, project_id, hash, message, snapshot_json, modified_by, created_at) VALUES ($id, $u, $p, $h, $m, $s, $mb, $c)');
  ins.bind({ $id: newUserId(), $u: userId, $p: proj.id, $h: hash, $m: (String(message || '').trim() || `${new Date().toISOString()} auto`), $s: JSON.stringify(snapshot), $mb: modifiedBy || userId, $c: now });
  ins.step();
  ins.free();
  let history = [];
  try { history = JSON.parse(proj.hash_history || '[]'); if (!Array.isArray(history)) history = []; } catch { history = []; }
  history.push(hash);
  const upd = db.prepare('UPDATE user_projects SET hash = $h, hash_history = $hh, updated_at = $now WHERE id = $pid');
  upd.bind({ $h: hash, $hh: JSON.stringify(history), $now: now, $pid: proj.id });
  upd.step();
  upd.free();
  await persistDb();
  return hash;
}

export async function listProjectLogs(userId, projectId) {
  const db = await openDb();
  const proj = await getProjectFullById(userId, projectId);
  if (!proj) throw new Error('project not found');
  if (!proj.hash) await ensureProjectVersionInitialized(userId, projectId);
  const cur = await getProjectFullById(userId, projectId);
  let history = [];
  try { history = JSON.parse(cur.hash_history || '[]'); if (!Array.isArray(history)) history = []; } catch { history = []; }
  
  // Get all backups with their modified_by user IDs
  const all = new Map();
  const sel = db.prepare('SELECT hash, message, modified_by, created_at FROM backups WHERE user_id = $u AND project_id = $p');
  sel.bind({ $u: userId, $p: cur.id });
  while (sel.step()) {
    const r = sel.getAsObject();
    all.set(String(r.hash), { hash: String(r.hash), message: String(r.message || ''), modified_by_id: r.modified_by || null, created_at: r.created_at });
  }
  sel.free();
  
  // Get all unique user IDs that modified this project
  const userIds = new Set();
  for (const [, backup] of all) {
    if (backup.modified_by_id) userIds.add(backup.modified_by_id);
  }
  
  // Get usernames for all these user IDs
  const userNames = new Map();
  if (userIds.size > 0) {
    const userSel = db.prepare(`SELECT id, name FROM users WHERE id IN (${Array.from(userIds).map(() => '?').join(',')})`);
    userSel.bind(Array.from(userIds));
    while (userSel.step()) {
      const u = userSel.getAsObject();
      userNames.set(u.id, u.name || u.id);
    }
    userSel.free();
  }
  
  // Map the logs with usernames
  const logs = history.map(h => {
    const backup = all.get(String(h));
    if (!backup) return null;
    return {
      hash: backup.hash,
      message: backup.message,
      modified_by: backup.modified_by_id ? (userNames.get(backup.modified_by_id) || backup.modified_by_id) : null,
      created_at: backup.created_at
    };
  }).filter(Boolean);
  
  return logs;
}

export async function revertProjectToHash(userId, projectId, targetHash, currentUserId) {
  const db = await openDb();
  const proj = await getProjectFullById(userId, projectId);
  if (!proj) throw new Error('project not found');
  
  // Get the project's commit history in order
  let history = [];
  try { history = JSON.parse(proj.hash_history || '[]'); if (!Array.isArray(history)) history = []; } catch { history = []; }
  
  // Find the target hash position in history
  const targetIndex = history.indexOf(targetHash);
  if (targetIndex === -1) throw new Error('hash_not_found');
  
  // If user is the owner, they can revert to any commit
  if (currentUserId && userId === currentUserId) {
    // Owner can revert to any commit, proceed with revert
  } else if (currentUserId && userId !== currentUserId) {
    // For non-owners, check if they can revert to this hash
    // They can only revert to commits that are part of their most recent consecutive sequence
    
    // Get all backup info for this project to check modified_by
    const allBackups = new Map();
    const backupSel = db.prepare('SELECT hash, modified_by FROM backups WHERE user_id = $u AND project_id = $p');
    backupSel.bind({ $u: userId, $p: proj.id });
    while (backupSel.step()) {
      const r = backupSel.getAsObject();
      allBackups.set(String(r.hash), r.modified_by || userId);
    }
    backupSel.free();
    
    // Find the most recent consecutive sequence of commits by currentUserId from the end
    // Users can only revert to commits in their most recent consecutive sequence
    // because reverting discards all commits after the target commit
    let earliestAllowedIndex = history.length; // Default: no commits allowed
    for (let i = history.length - 1; i >= 0; i--) {
      const hash = history[i];
      const modifiedBy = allBackups.get(hash) || userId;
      if (modifiedBy === currentUserId) {
        // This is the user's commit, update the earliest allowed index
        earliestAllowedIndex = i;
      } else {
        // Found a commit by someone else, stop here
        // User cannot revert past this point as it would discard others' work
        break;
      }
    }
    
    // Check if target hash is within the allowed range
    if (targetIndex < earliestAllowedIndex) {
      throw new Error('You can only revert to your most recent consecutive commits');
    }
  }
  
  // Get the snapshot for the target hash
  const snapSel = db.prepare('SELECT snapshot_json FROM backups WHERE user_id = $u AND project_id = $p AND hash = $h');
  snapSel.bind({ $u: userId, $p: proj.id, $h: targetHash });
  const ok = snapSel.step();
  if (!ok) { snapSel.free(); throw new Error('hash_not_found'); }
  const row = snapSel.getAsObject();
  snapSel.free();
  let snapshot;
  try { snapshot = JSON.parse(row.snapshot_json || '{}'); } catch { throw new Error('invalid_snapshot'); }
  const now = new Date().toISOString();
  // Update project agent/progress to snapshot versions
  const updProj = db.prepare('UPDATE user_projects SET agent_json = $a, progress_json = $p, hash = $h, updated_at = $now WHERE id = $pid');
  updProj.bind({ $a: JSON.stringify(snapshot.agent || {}), $p: JSON.stringify(snapshot.progress || {}), $h: targetHash, $now: now, $pid: proj.id });
  updProj.step();
  updProj.free();
  // Replace tasks with snapshot tasks
  const del = db.prepare('DELETE FROM project_tasks WHERE user_id = $u AND project_id = $p');
  del.bind({ $u: userId, $p: proj.id });
  del.step();
  del.free();
  const ins = db.prepare('INSERT INTO project_tasks (id, user_id, project_id, task_id, task_info, parent_id, status, extra_note, created_at, updated_at) VALUES ($id, $u, $p, $tid, $ti, $pid, $st, $en, $c, $uAt)');
  const tasks = Array.isArray(snapshot.tasks) ? snapshot.tasks : [];
  for (const t of tasks) {
    ins.bind({
      $id: newUserId(),
      $u: userId,
      $p: proj.id,
      $tid: String(t.task_id),
      $ti: String(t.task_info || ''),
      $pid: t.parent_id || null,
      $st: String(t.status || 'pending'),
      $en: t.extra_note || null,
      $c: t.created_at || now,
      $uAt: t.updated_at || null,
    });
    ins.step();
    ins.reset();
  }
  ins.free();
  // Trim hash_history to target
  let newHistory = [];
  try { newHistory = JSON.parse(proj.hash_history || '[]'); if (!Array.isArray(newHistory)) newHistory = []; } catch { newHistory = []; }
  const idx = newHistory.indexOf(targetHash);
  const newHist = idx >= 0 ? newHistory.slice(0, idx + 1) : [targetHash];
  const updHist = db.prepare('UPDATE user_projects SET hash_history = $hh, updated_at = $now WHERE id = $pid');
  updHist.bind({ $hh: JSON.stringify(newHist), $now: now, $pid: proj.id });
  updHist.step();
  updHist.free();
  await persistDb();
  return { hash: targetHash };
}

// ---------------- Structured Tasks APIs ----------------

export async function listTasks(userId, projectId, { only } = {}) {
  const db = await openDb();
  const proj = await getProjectFullById(userId, projectId);
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

export async function addTasks(userId, projectId, tasks) {
  const db = await openDb();
  const proj = await getProjectFullById(userId, projectId);
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

export async function replaceTasks(userId, projectId, tasks) {
  const db = await openDb();
  const proj = await getProjectFullById(userId, projectId);
  if (!proj) throw new Error('project not found');
  // Delete existing tasks for this project
  const del = db.prepare('DELETE FROM project_tasks WHERE user_id = $u AND project_id = $p');
  del.bind({ $u: userId, $p: proj.id });
  del.step();
  del.free();
  await persistDb();
  // Add all new tasks
  return await addTasks(userId, projectId, tasks);
}

export async function setTasksState(userId, projectId, { matchIds = [], matchText = [], state, task_info, parent_id, extra_note }) {
  const db = await openDb();
  const proj = await getProjectFullById(userId, projectId);
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

export async function deleteAllTasks(userId, projectId) {
  const db = await openDb();
  const proj = await getProjectFullById(userId, projectId);
  if (!proj) throw new Error('project not found');
  const del = db.prepare('DELETE FROM project_tasks WHERE user_id = $u AND project_id = $p');
  del.bind({ $u: userId, $p: proj.id });
  del.step();
  del.free();
  await persistDb();
}

// ---------------- Scratchpad APIs ----------------

function normalizeScratchpadStatus(s) {
  const v = String(s || '').toLowerCase().trim();
  return v === 'complete' || v === 'completed' || v === 'done' ? 'complete' : 'open';
}

function coerceString(val) {
  return typeof val === 'string' ? val : (val == null ? '' : String(val));
}

function validateScratchpadId(id) {
  if (typeof id !== 'string') return false;
  const s = id.trim();
  // Allow typical safe identifier chars; keep it simple
  return s.length > 0 && s.length <= 100 && /^[A-Za-z0-9._\-]+$/.test(s);
}

function normalizeScratchpadTasks(incoming, projectId) {
  const arr = Array.isArray(incoming) ? incoming.slice(0, 6) : [];
  const tasks = [];
  const invalid = [];
  for (const t of arr) {
    if (!t || typeof t !== 'object') { invalid.push({ item: t, reason: 'not_an_object' }); continue; }
    const task_id = coerceString(t.task_id).trim();
    const task_info = coerceString(t.task_info).trim();
    const scratchpad = coerceString(t.scratchpad);
    const comments = coerceString(t.comments);
    const status = normalizeScratchpadStatus(t.status || 'open');
    if (!task_id) { invalid.push({ item: t, reason: 'missing_task_id' }); continue; }
    if (!task_info) { invalid.push({ item: t, reason: 'missing_task_info' }); continue; }
    tasks.push({ task_id, project_id: projectId, status, task_info, scratchpad, comments });
  }
  return { tasks, invalid };
}

export async function initScratchpad(userId, projectId, scratchpadId, tasksInput) {
  const db = await openDb();
  const proj = await getProjectFullById(userId, projectId);
  if (!proj) throw new Error('project not found');
  // Generate an ID when not provided; otherwise validate the given one
  let sid = scratchpadId && typeof scratchpadId === 'string' ? scratchpadId.trim() : '';
  if (!sid) {
    // Generate a unique short id under this user+project
    const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
    function rand(n) { let s = ''; for (let i = 0; i < n; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)]; return s; }
    let attempts = 0;
    while (!sid && attempts < 1000) {
      attempts++;
      const candidate = `sp-${rand(8)}`;
      const chk = db.prepare('SELECT 1 FROM scratchpads WHERE user_id = $u AND project_id = $p AND scratchpad_id = $sid LIMIT 1');
      chk.bind({ $u: userId, $p: proj.id, $sid: candidate });
      const exists = chk.step();
      chk.free();
      if (!exists) sid = candidate;
    }
    if (!sid) throw new Error('failed_to_generate_scratchpad_id');
  }
  if (!validateScratchpadId(sid)) throw new Error('invalid scratchpad_id');
  const now = new Date().toISOString();
  const { tasks, invalid } = normalizeScratchpadTasks(tasksInput, proj.id);
  if (tasks.length > 6) tasks.length = 6;
  // Upsert scratchpad row
  const sel = db.prepare('SELECT id FROM scratchpads WHERE user_id = $u AND project_id = $p AND scratchpad_id = $sid');
  sel.bind({ $u: userId, $p: proj.id, $sid: sid });
  const exists = sel.step();
  sel.free();
  if (exists) throw new Error('scratchpad already exists');
  const ins = db.prepare(`
    INSERT INTO scratchpads (id, user_id, project_id, scratchpad_id, tasks_json, common_memory, created_at)
    VALUES ($id, $u, $p, $sid, $t, $cm, $now)
  `);
  ins.bind({ $id: newUserId(), $u: userId, $p: proj.id, $sid: sid, $t: JSON.stringify(tasks), $cm: '', $now: now });
  ins.step();
  ins.free();
  await persistDb();
  return await getScratchpad(userId, projectId, sid, { includeInvalid: invalid });
}

export async function getScratchpad(userId, projectId, scratchpadId, { includeInvalid } = {}) {
  const db = await openDb();
  const proj = await getProjectFullById(userId, projectId);
  if (!proj) throw new Error('project not found');
  const sel = db.prepare('SELECT id, scratchpad_id, tasks_json, common_memory, created_at, updated_at FROM scratchpads WHERE user_id = $u AND project_id = $p AND scratchpad_id = $sid');
  sel.bind({ $u: userId, $p: proj.id, $sid: scratchpadId });
  const ok = sel.step();
  if (!ok) { sel.free(); throw new Error('scratchpad not found'); }
  const r = sel.getAsObject();
  sel.free();
  let tasks = [];
  try {
    const parsed = JSON.parse(r.tasks_json || '[]');
    if (Array.isArray(parsed)) tasks = parsed;
  } catch {}
  const out = {
    scratchpad_id: r.scratchpad_id,
    project_id: proj.id,
    tasks,
    common_memory: r.common_memory || '',
    created_at: r.created_at,
    updated_at: r.updated_at || null,
  };
  if (includeInvalid && includeInvalid.length) out.invalid = includeInvalid;
  return out;
}

export async function updateScratchpadTasks(userId, projectId, scratchpadId, updates) {
  const db = await openDb();
  const proj = await getProjectFullById(userId, projectId);
  if (!proj) throw new Error('project not found');
  const sel = db.prepare('SELECT id, tasks_json FROM scratchpads WHERE user_id = $u AND project_id = $p AND scratchpad_id = $sid');
  sel.bind({ $u: userId, $p: proj.id, $sid: scratchpadId });
  const ok = sel.step();
  if (!ok) { sel.free(); throw new Error('scratchpad not found'); }
  const row = sel.getAsObject();
  sel.free();
  let tasks = [];
  try {
    const parsed = JSON.parse(row.tasks_json || '[]');
    if (Array.isArray(parsed)) tasks = parsed;
  } catch {}
  const byId = new Map(tasks.map((t, i) => [String(t.task_id), { idx: i, t }]));
  const list = Array.isArray(updates) ? updates : [];
  const updated = [];
  const notFound = [];
  for (const u of list) {
    if (!u || typeof u !== 'object') continue;
    const tid = coerceString(u.task_id).trim();
    if (!tid) continue;
    const hit = byId.get(tid);
    if (!hit) { notFound.push(tid); continue; }
    const cur = tasks[hit.idx];
    if (typeof u.status !== 'undefined') cur.status = normalizeScratchpadStatus(u.status);
    if (typeof u.task_info !== 'undefined') cur.task_info = coerceString(u.task_info);
    if (typeof u.scratchpad !== 'undefined') cur.scratchpad = coerceString(u.scratchpad);
    if (typeof u.comments !== 'undefined') cur.comments = coerceString(u.comments);
    // project_id remains the same; ignore any incoming project_id
    updated.push(tid);
  }
  const now = new Date().toISOString();
  const upd = db.prepare('UPDATE scratchpads SET tasks_json = $t, updated_at = $now WHERE id = $id');
  upd.bind({ $t: JSON.stringify(tasks), $now: now, $id: row.id });
  upd.step();
  upd.free();
  await persistDb();
  return { updated, notFound, scratchpad: await getScratchpad(userId, projectId, scratchpadId) };
}

export async function appendScratchpadCommonMemory(userId, projectId, scratchpadId, toAppend) {
  const db = await openDb();
  const proj = await getProjectFullById(userId, projectId);
  if (!proj) throw new Error('project not found');
  const sel = db.prepare('SELECT id, common_memory FROM scratchpads WHERE user_id = $u AND project_id = $p AND scratchpad_id = $sid');
  sel.bind({ $u: userId, $p: proj.id, $sid: scratchpadId });
  const ok = sel.step();
  if (!ok) { sel.free(); throw new Error('scratchpad not found'); }
  const row = sel.getAsObject();
  sel.free();
  const appendList = Array.isArray(toAppend) ? toAppend : [toAppend];
  const normalized = appendList
    .map(v => coerceString(v).trim())
    .filter(s => s.length > 0);
  if (!normalized.length) {
    return await getScratchpad(userId, projectId, scratchpadId);
  }
  const sep = row.common_memory && !row.common_memory.endsWith('\n') ? '\n' : '';
  const add = normalized.join('\n');
  const updatedMemory = (row.common_memory || '') + sep + add;
  const now = new Date().toISOString();
  const upd = db.prepare('UPDATE scratchpads SET common_memory = $cm, updated_at = $now WHERE id = $id');
  upd.bind({ $cm: updatedMemory, $now: now, $id: row.id });
  upd.step();
  upd.free();
  await persistDb();
  return await getScratchpad(userId, projectId, scratchpadId);
}

// ---------------- Subagent Runs APIs ----------------

function normalizeRunStatus(s) {
  const v = String(s || '').toLowerCase().trim();
  if (['pending','in_progress','success','failure'].includes(v)) return v;
  return 'pending';
}

export async function createSubagentRun(userId, projectId, runId, status = 'pending') {
  const db = await openDb();
  const proj = await getProjectFullById(userId, projectId);
  if (!proj) throw new Error('project not found');
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO subagent_runs (id, user_id, project_id, run_id, status, created_at)
    VALUES ($id, $u, $p, $rid, $st, $now)
  `);
  stmt.bind({ $id: newUserId(), $u: userId, $p: proj.id, $rid: String(runId), $st: normalizeRunStatus(status), $now: now });
  stmt.step();
  stmt.free();
  await persistDb();
  return { run_id: String(runId), status: normalizeRunStatus(status) };
}

export async function setSubagentRunStatus(userId, projectId, runId, status) {
  const db = await openDb();
  const proj = await getProjectFullById(userId, projectId);
  if (!proj) throw new Error('project not found');
  const now = new Date().toISOString();
  const stmt = db.prepare('UPDATE subagent_runs SET status = $st, updated_at = $now WHERE user_id = $u AND project_id = $p AND run_id = $rid');
  stmt.bind({ $st: normalizeRunStatus(status), $now: now, $u: userId, $p: proj.id, $rid: String(runId) });
  stmt.step();
  stmt.free();
  await persistDb();
  return await getSubagentRun(userId, projectId, runId);
}

export async function getSubagentRun(userId, projectId, runId) {
  const db = await openDb();
  const proj = await getProjectFullById(userId, projectId);
  if (!proj) throw new Error('project not found');
  const sel = db.prepare('SELECT run_id, status, created_at, updated_at FROM subagent_runs WHERE user_id = $u AND project_id = $p AND run_id = $rid');
  sel.bind({ $u: userId, $p: proj.id, $rid: String(runId) });
  const ok = sel.step();
  if (!ok) { sel.free(); return null; }
  const r = sel.getAsObject();
  sel.free();
  return { run_id: r.run_id, status: r.status, created_at: r.created_at, updated_at: r.updated_at || null };
}
