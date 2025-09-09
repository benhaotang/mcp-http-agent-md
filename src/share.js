import express from 'express';
import {
  listAllProjectsAdmin,
  listProjectsForUserWithShares,
  getUserByApiKey,
  getUserById,
  getProjectById,
  setProjectShare,
  revokeProjectShare,
  getProjectShareInfo,
} from './db.js';

function isAdminRequest(req) {
  const header = req.headers['authorization'] || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : null;
  const main = process.env.MAIN_API_KEY;
  return Boolean(main && bearer && bearer === main);
}

async function resolveUserFromRequest(req) {
  // Prefer Bearer first (user apiKey), fallback to query ?apiKey=
  const header = req.headers['authorization'] || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : null;
  const apiKey = (req.query.apiKey && String(req.query.apiKey)) || bearer || null;
  if (!apiKey) return null;
  const user = await getUserByApiKey(apiKey);
  if (!user) return null;
  return { id: user.id, name: user.name || null };
}

export function buildProjectsRouter() {
  const router = express.Router();
  router.use(express.json({ limit: '1mb' }));

  // GET /list
  // - If MAIN_API_KEY (admin): list all projects (id, name, owner_id, owner_name)
  // - If user apiKey: list owned + shared (id, name; append " (Read-Only)" when shared RO)
  router.get('/list', async (req, res) => {
    try {
      if (isAdminRequest(req)) {
        const rows = await listAllProjectsAdmin();
        return res.json({
          scope: 'admin',
          projects: rows.map(r => ({ id: r.id, name: r.name, owner_id: r.owner_id, owner_name: r.owner_name }))
        });
      }
      const user = await resolveUserFromRequest(req);
      if (!user) return res.status(401).json({ error: 'apiKey required' });
      const rows = await listProjectsForUserWithShares(user.id);
      const mapped = rows.map(r => ({
        id: r.id,
        name: r.name + (r.permission === 'ro' && r.owner_id !== user.id ? ' (Read-Only)' : ''),
        read_only: r.permission === 'ro' && r.owner_id !== user.id,
      }));
      return res.json({ scope: 'user', projects: mapped });
    } catch (e) {
      return res.status(500).json({ error: 'list_failed', message: e?.message || 'Failed to list projects' });
    }
  });

  // POST /share
  // Body: { project_id, target_user_id, permission: 'ro'|'rw', revoke?: boolean }
  // Only owner can share/revoke; admin (MAIN_API_KEY) may share/revoke any project
  router.post('/share', async (req, res) => {
    try {
      const { project_id, target_user_id } = req.body || {};
      let { permission, revoke } = req.body || {};
      const proj = await getProjectById(String(project_id || ''));
      if (!proj) return res.status(404).json({ error: 'project_not_found' });
      const isAdmin = isAdminRequest(req);
      const user = isAdmin ? null : (await resolveUserFromRequest(req));
      if (!isAdmin && !user) return res.status(401).json({ error: 'apiKey required' });
      // Authorization: owner or admin
      if (!isAdmin && user.id !== proj.owner_id) return res.status(403).json({ error: 'forbidden' });

      const target = await getUserById(String(target_user_id || ''));
      if (!target) return res.status(404).json({ error: 'target_user_not_found' });
      if (target.id === proj.owner_id) return res.status(400).json({ error: 'cannot_share_with_owner' });

      revoke = Boolean(revoke);
      permission = String(permission || '').toLowerCase().trim();
      if (!revoke && permission !== 'ro' && permission !== 'rw') {
        return res.status(400).json({ error: 'invalid_permission', message: "permission must be 'ro' or 'rw'" });
      }

      // Execute
      const ownerId = proj.owner_id; // for DB guard; admin passes through here too
      let result;
      if (revoke) {
        result = await revokeProjectShare(ownerId, proj.id, target.id);
      } else {
        result = await setProjectShare(ownerId, proj.id, target.id, permission);
      }
      const perm = result.rw_users.includes(target.id) ? 'rw' : (result.ro_users.includes(target.id) ? 'ro' : 'none');
      return res.json({ ok: true, project_id: result.project_id, owner_id: result.owner_id, target_user_id: target.id, permission: perm });
    } catch (e) {
      const msg = String(e?.message || 'share_failed');
      const code = /project not found|project_not_found/i.test(msg) ? 'project_not_found' : (/forbidden/i.test(msg) ? 'forbidden' : 'share_failed');
      return res.status(code === 'project_not_found' ? 404 : (code === 'forbidden' ? 403 : 500)).json({ error: code, message: msg });
    }
  });

  // GET /status?project_id=...
  router.get('/status', async (req, res) => {
    try {
      const projectId = String(req.query.project_id || '');
      const proj = await getProjectShareInfo(projectId);
      if (!proj) return res.status(404).json({ error: 'project_not_found' });
      const isAdmin = isAdminRequest(req);
      const user = isAdmin ? null : (await resolveUserFromRequest(req));
      if (!isAdmin && !user) return res.status(401).json({ error: 'apiKey required' });

      const owner = await getUserById(proj.owner_id);
      const ownerInfo = { id: owner?.id || proj.owner_id, name: owner?.name || null };

      // Determine viewer permission
      let viewerPerm = 'none';
      if (isAdmin) viewerPerm = 'admin';
      else if (user.id === proj.owner_id) viewerPerm = 'owner';
      else if (proj.rw_users.includes(user.id)) viewerPerm = 'rw';
      else if (proj.ro_users.includes(user.id)) viewerPerm = 'ro';

      if (viewerPerm === 'none') return res.status(404).json({ error: 'project_not_found' });

      if (viewerPerm === 'admin' || viewerPerm === 'owner') {
        // Full visibility
        // Expand user info for participants
        const roUsers = [];
        for (const uid of proj.ro_users) {
          const u = await getUserById(uid);
          roUsers.push({ id: uid, name: u?.name || null });
        }
        const rwUsers = [];
        for (const uid of proj.rw_users) {
          const u = await getUserById(uid);
          rwUsers.push({ id: uid, name: u?.name || null });
        }
        return res.json({
          owner: ownerInfo,
          project: { id: proj.id, name: proj.name },
          shared_read: roUsers,
          shared_read_write: rwUsers,
        });
      }

      // Shared participant: limited visibility
      return res.json({
        owner: ownerInfo,
        project: { id: proj.id, name: proj.name },
        your_permission: viewerPerm,
      });
    } catch (e) {
      return res.status(500).json({ error: 'status_failed', message: e?.message || 'Failed to get project status' });
    }
  });

  return router;
}

export default {
  buildProjectsRouter,
};
