import { ensureProjectVersionInitialized, createProjectBackup, listProjectLogs as dbListLogs, revertProjectToHash } from './db.js';

function defaultMessage(action) {
  const ts = new Date().toISOString();
  return `${ts} ${action}`;
}

export async function onInitProject(userId, name) {
  const hash = await ensureProjectVersionInitialized(userId, name);
  return hash;
}

export async function commitProject(userId, name, { comment, action } = {}) {
  const message = String(comment || '').trim() || defaultMessage(action || 'commit');
  const hash = await createProjectBackup(userId, name, message);
  return hash;
}

export async function listProjectLogs(userId, name) {
  return await dbListLogs(userId, name);
}

export async function revertProject(userId, name, hash) {
  return await revertProjectToHash(userId, name, hash);
}

