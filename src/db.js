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
