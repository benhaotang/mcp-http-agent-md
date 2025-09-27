import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs/promises';
import crypto from 'crypto';
import { summarizeFile as extSummarizeFile } from './ext_ai/ext_ai.js';

import {
  getUserByApiKey,
  resolveProjectAccess,
  listProjectFiles as dbListProjectFiles,
  replaceProjectFile as dbReplaceProjectFile,
  deleteProjectFile as dbDeleteProjectFile,
  updateProjectFileDescription as dbUpdateProjectFileDescription,
  getDataDir,
} from './db.js';

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

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB max to prevent large uploads for now
});

const ALLOWED_EXTENSIONS = new Set(['.pdf', '.md', '.txt']);

function validateFileExtension(filename) {
  const ext = path.extname(filename || '').toLowerCase();
  return { ok: ALLOWED_EXTENSIONS.has(ext), ext };
}

function generateFileId() {
  return crypto.randomBytes(8).toString('hex');
}

function mapFileRow(row) {
  return {
    file_id: row.file_id,
    original_name: row.original_name,
    file_type: row.file_type,
    uploaded_by: row.user_id ? { id: row.user_id, name: row.user_name || null } : null,
    description: row.description || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function sanitizeDescription(input) {
  if (typeof input === 'undefined' || input === null) return null;
  const str = String(input).trim();
  if (!str) return null;
  const limit = 4000;
  return str.length > limit ? str.slice(0, limit) : str;
}

export function buildProjectFilesRouter() {
  const router = express.Router();
  router.use(express.json({ limit: '1mb' }));

  router.get('/files', async (req, res) => {
    try {
      const projectId = String(req.query.project_id || '').trim();
      if (!projectId) {
        return res.status(400).json({ error: 'project_id_required' });
      }
      const user = await resolveUserFromRequest(req);
      if (!user) return res.status(401).json({ error: 'apiKey required' });
      const access = await resolveProjectAccess(user.id, projectId);
      if (!access) return res.status(404).json({ error: 'project_not_found' });
      const rows = await dbListProjectFiles(access.owner_id, access.project_id);
      return res.json({
        project_id: access.project_id,
        permission: access.permission,
        files: rows.map(mapFileRow),
      });
    } catch (e) {
      console.error('files:list error', e);
      return res.status(500).json({ error: 'files_list_failed', message: e?.message || 'Failed to list files' });
    }
  });

  router.post('/files', (req, res, next) => {
    upload.single('file')(req, res, (err) => {
      if (err) {
        if (err instanceof multer.MulterError) {
          return res.status(400).json({ error: 'upload_failed', message: err.message });
        }
        return res.status(500).json({ error: 'upload_failed', message: err?.message || 'Upload failed' });
      }
      next();
    });
  }, async (req, res) => {
    try {
      const projectId = String(req.body?.project_id || '').trim();
      if (!projectId) return res.status(400).json({ error: 'project_id_required' });
      const user = await resolveUserFromRequest(req);
      if (!user) return res.status(401).json({ error: 'apiKey required' });
      const access = await resolveProjectAccess(user.id, projectId);
      if (!access) return res.status(404).json({ error: 'project_not_found' });
      if (access.permission === 'ro') return res.status(403).json({ error: 'read_only_project' });
      const file = req.file;
      if (!file) return res.status(400).json({ error: 'file_required' });
      let description;
      if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'description')) {
        description = sanitizeDescription(req.body.description);
      }

      const { ok, ext } = validateFileExtension(file.originalname || '');
      if (!ok) {
        return res.status(400).json({ error: 'unsupported_file_type', message: 'Only pdf, md, and txt uploads are allowed' });
      }
      const mime = String(file.mimetype || '').toLowerCase();
      if (ext === '.pdf' && !mime.includes('pdf')) {
        return res.status(400).json({ error: 'unsupported_file_type', message: 'PDF uploads must be application/pdf' });
      }
      if ((ext === '.md' || ext === '.txt') && !(mime.includes('text') || mime === 'application/octet-stream')) {
        return res.status(400).json({ error: 'unsupported_file_type', message: 'Markdown/Text uploads must be text based' });
      }

      const fileId = generateFileId();
      const projectDir = path.join(getDataDir(), access.project_id);
      await fs.mkdir(projectDir, { recursive: true });
      const targetPath = path.join(projectDir, fileId);

      await fs.writeFile(targetPath, file.buffer);
      let meta;
      let replacedFileId = null;
      try {
        const result = await dbReplaceProjectFile(access.owner_id, access.project_id, {
          originalName: file.originalname,
          fileId,
          fileType: file.mimetype || 'application/octet-stream',
          userId: user.id,
          description,
        });
        meta = result.file;
        replacedFileId = result.replacedFileId;
      } catch (err) {
        await fs.unlink(targetPath).catch(() => {});
        throw err;
      }

      if (replacedFileId && replacedFileId !== fileId) {
        const oldPath = path.join(projectDir, replacedFileId);
        await fs.unlink(oldPath).catch(() => {});
      }

      return res.json({
        file: {
          file_id: meta.file_id,
          original_name: meta.original_name,
          file_type: meta.file_type,
          description: meta.description || null,
          created_at: meta.created_at,
          updated_at: meta.updated_at,
          uploaded_by: { id: user.id, name: user.name || null },
        }
      });
    } catch (e) {
      console.error('files:upload error', e);
      const code = e?.message === 'original_name required' ? 400 : 500;
      return res.status(code).json({ error: 'files_upload_failed', message: e?.message || 'Upload failed' });
    }
  });

  router.delete('/files/:fileId', async (req, res) => {
    try {
      const projectId = String(req.query.project_id || '').trim();
      if (!projectId) return res.status(400).json({ error: 'project_id_required' });
      const user = await resolveUserFromRequest(req);
      if (!user) return res.status(401).json({ error: 'apiKey required' });
      const access = await resolveProjectAccess(user.id, projectId);
      if (!access) return res.status(404).json({ error: 'project_not_found' });
      if (access.permission === 'ro') return res.status(403).json({ error: 'read_only_project' });
      const fileId = String(req.params.fileId || '').trim();
      if (!fileId) return res.status(400).json({ error: 'file_id_required' });

      const deleted = await dbDeleteProjectFile(access.owner_id, access.project_id, fileId);
      if (!deleted) return res.status(404).json({ error: 'file_not_found' });

      const projectDir = path.join(getDataDir(), access.project_id);
      const targetPath = path.join(projectDir, deleted.file_id);
      await fs.unlink(targetPath).catch(() => {});

      return res.json({ ok: true, file_id: deleted.file_id });
    } catch (e) {
      console.error('files:delete error', e);
      return res.status(500).json({ error: 'files_delete_failed', message: e?.message || 'Delete failed' });
    }
  });

  router.patch('/files/:fileId', async (req, res) => {
    try {
      const projectId = String(req.query.project_id || '').trim();
      if (!projectId) return res.status(400).json({ error: 'project_id_required' });
      const user = await resolveUserFromRequest(req);
      if (!user) return res.status(401).json({ error: 'apiKey required' });
      const access = await resolveProjectAccess(user.id, projectId);
      if (!access) return res.status(404).json({ error: 'project_not_found' });
      if (access.permission === 'ro') return res.status(403).json({ error: 'read_only_project' });
      const fileId = String(req.params.fileId || '').trim();
      if (!fileId) return res.status(400).json({ error: 'file_id_required' });
      const description = (req.body && Object.prototype.hasOwnProperty.call(req.body, 'description'))
        ? sanitizeDescription(req.body.description)
        : null;
      const result = await dbUpdateProjectFileDescription(access.owner_id, access.project_id, fileId, description);
      return res.json(result);
    } catch (e) {
      const msg = e?.message || 'update_failed';
      const code = /project not found/i.test(msg) ? 404 : (/file_not_found/i.test(msg) ? 404 : 500);
      return res.status(code).json({ error: 'files_update_failed', message: msg });
    }
  });

  // Direct file summarization (uses external AI directly; optional save to description)
  router.post('/files/:fileId/summarize', async (req, res) => {
    try {
      const projectId = String(req.query.project_id || req.body?.project_id || '').trim();
      if (!projectId) return res.status(400).json({ error: 'project_id_required' });
      const user = await resolveUserFromRequest(req);
      if (!user) return res.status(401).json({ error: 'apiKey required' });
      const access = await resolveProjectAccess(user.id, projectId);
      if (!access) return res.status(404).json({ error: 'project_not_found' });
      if (String(process.env.USE_EXTERNAL_AI || '').toLowerCase() === 'false') {
        return res.status(400).json({ error: 'external_ai_disabled' });
      }
      const fileId = String(req.params.fileId || '').trim();
      if (!fileId) return res.status(400).json({ error: 'file_id_required' });
      const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt : undefined;
      const save = !!req.body?.save;

      const out = await extSummarizeFile(user.id, { project_id: access.project_id, file_id: fileId, prompt });
      if (!out || out.error) {
        const msg = out?.error || 'summarize_failed';
        const code = /missing_api_key/i.test(msg) ? 400 : 500;
        return res.status(code).json({ error: msg });
      }
      const summary = String(out.text || '').trim();
      let saved = false;
      if (save && summary) {
        await dbUpdateProjectFileDescription(access.owner_id, access.project_id, fileId, summary);
        saved = true;
      }
      return res.json({ summary, saved });
    } catch (e) {
      console.error('files:summarize error', e);
      return res.status(500).json({ error: 'summarize_failed', message: e?.message || 'Summarize failed' });
    }
  });

  return router;
}

export default {
  buildProjectFilesRouter,
};
