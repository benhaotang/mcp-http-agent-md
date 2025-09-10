import { ensureProjectVersionInitialized, createProjectBackup, listProjectLogs as dbListLogs, revertProjectToHash } from './db.js';

function defaultMessage(action) {
  const ts = new Date().toISOString();
  return `${ts} ${action}`;
}

export async function onInitProject(userId, projectId) {
  const hash = await ensureProjectVersionInitialized(userId, projectId);
  return hash;
}

export async function commitProject(userId, projectId, { comment, action, modifiedBy } = {}) {
  let message = String(comment || '').trim() || defaultMessage(action || 'commit');
  const hash = await createProjectBackup(userId, projectId, message, modifiedBy);
  return hash;
}

export async function listProjectLogs(userId, projectId) {
  return await dbListLogs(userId, projectId);
}

export async function revertProject(userId, projectId, hash, currentUserId) {
  return await revertProjectToHash(userId, projectId, hash, currentUserId);
}
