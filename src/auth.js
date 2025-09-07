import express from 'express';
import {
  createUser,
  listUsers,
  getUserById,
  getUserByApiKey,
  deleteUser,
  regenerateApiKey,
} from './db.js';

function maskKey(key) {
  if (!key) return '';
  if (key.length <= 6) return '*'.repeat(key.length);
  return `${key.slice(0,3)}***${key.slice(-3)}`;
}

// Middleware: protect /auth endpoints with MAIN_API_KEY via Bearer
export function authAdminMiddleware(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const expected = process.env.MAIN_API_KEY;
  if (!expected) {
    return res.status(500).json({ error: 'Server misconfigured: MAIN_API_KEY not set' });
  }
  if (!token || token !== expected) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// Middleware: authenticate by apiKey from query or Authorization header
export async function apiKeyQueryMiddleware(req, res, next) {
  const header = req.headers['authorization'] || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : null;
  const apiKey = (req.query.apiKey && String(req.query.apiKey)) || bearer || null;
  if (!apiKey) return res.status(401).json({ error: 'apiKey required' });
  const user = await getUserByApiKey(apiKey);
  if (!user) return res.status(401).json({ error: 'Invalid apiKey' });
  req.user = { id: user.id, name: user.name || null };
  next();
}

// Express router under /auth
export function buildAuthRouter() {
  const router = express.Router();
  router.use(express.json({ limit: '1mb' }));
  router.use(authAdminMiddleware);

  // Create user
  router.post('/users', async (req, res) => {
    try {
      const { name } = req.body || {};
      const user = await createUser({ name });
      res.status(201).json(user);
    } catch (e) {
      res.status(500).json({ error: e?.message || 'Failed to create user' });
    }
  });

  // List users (mask keys by default)
  router.get('/users', async (req, res) => {
    const reveal = String(req.query.reveal || '').toLowerCase() === 'true';
    const users = await listUsers();
    const mapped = users.map(u => ({
      id: u.id,
      name: u.name || null,
      createdAt: u.createdAt,
      updatedAt: u.updatedAt || null,
      apiKey: reveal ? u.apiKey : maskKey(u.apiKey),
    }));
    res.json({ users: mapped });
  });

  // Get single user
  router.get('/users/:id', async (req, res) => {
    const u = await getUserById(req.params.id);
    if (!u) return res.status(404).json({ error: 'Not found' });
    res.json(u);
  });

  // Regenerate API key
  router.post('/users/:id/regenerate', async (req, res) => {
    const u = await regenerateApiKey(req.params.id);
    if (!u) return res.status(404).json({ error: 'Not found' });
    res.json(u);
  });

  // Delete user
  router.delete('/users/:id', async (req, res) => {
    const ok = await deleteUser(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Not found' });
    res.json({ deleted: true });
  });

  return router;
}

export default {
  buildAuthRouter,
  apiKeyQueryMiddleware,
  authAdminMiddleware,
  createUser,
  listUsers,
  getUserByApiKey,
  getUserById,
  regenerateApiKey,
  deleteUser,
};
