import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs/promises';
import crypto from 'crypto';
import { fileTypeFromBuffer } from 'file-type';
import { summarizeFile as extSummarizeFile } from './ext_ai/ext_ai.js';
import { parseBoolean } from './env.js';
import { processPdfForProjectFile, processAllProjectPdfs } from './ext_ai/pdfProcessor.js';

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
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB max to prevent large uploads
});

const ALLOWED_EXTENSIONS = new Set(['.pdf', '.md', '.txt']);

function validateFileExtension(filename) {
  const ext = path.extname(filename || '').toLowerCase();
  return { ok: ALLOWED_EXTENSIONS.has(ext), ext };
}

function isLikelyUtf8Text(buf) {
  if (!buf || buf.length === 0) return false;
  // hard fail on NUL bytes
  for (let i = 0; i < buf.length; i++) { if (buf[i] === 0x00) return false; }
  const sample = buf.length > 65536 ? buf.subarray(0, 65536) : buf;
  let nonPrintable = 0;
  for (let i = 0; i < sample.length; i++) {
    const b = sample[i];
    if (b === 0x09 || b === 0x0a || b === 0x0d) continue; // tab, LF, CR
    if (b < 0x20 || b > 0x7e) nonPrintable++;
  }
  const ratio = nonPrintable / sample.length;
  return ratio < 0.30; // tolerant of UTF-8 multibyte bytes
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

function queuePdfProcessing(projectId, fileId, { force = false, source = 'upload' } = {}) {
  setImmediate(() => {
    processPdfForProjectFile(projectId, fileId, { force })
      .then((result) => {
        if (!result || result.status === 'disabled') return;
        if (result.status !== 'ok' && result.status !== 'skipped') {
          console.warn(`PDF processing (${source}) status=${result.status} for ${projectId}/${fileId}:`, result.reason || result.error || 'unknown');
        }
      })
      .catch((err) => {
        console.error(`PDF processing (${source}) failed for ${projectId}/${fileId}:`, err?.message || err);
      });
  });
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
      const projectDir = path.join(getDataDir(), access.project_id);
      const files = await Promise.all(rows.map(async (r) => {
        const base = mapFileRow(r);
        let has_ocr = false;
        if (String(base.file_type || '').toLowerCase() === 'application/pdf') {
          const sidecar = path.join(projectDir, `${base.file_id}.ocr.json`);
          try { await fs.access(sidecar); has_ocr = true; } catch {}
        }
        return { ...base, has_ocr };
      }));
      return res.json({
        project_id: access.project_id,
        permission: access.permission,
        files,
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

      // Detect type from content, not client-provided MIME
      if (!file.buffer || file.buffer.length === 0) {
        return res.status(400).json({ error: 'empty_file' });
      }
      let canonicalMime = null;
      try {
        const ft = await fileTypeFromBuffer(file.buffer);
        if (ft && ft.mime === 'application/pdf') {
          canonicalMime = 'application/pdf';
        }
      } catch {}
      if (!canonicalMime) {
        // Accept only if it looks like text; choose markdown vs plain by extension
        if (!isLikelyUtf8Text(file.buffer)) {
          return res.status(400).json({ error: 'unsupported_file_type', message: 'Only PDF or UTF-8 text/markdown files are allowed' });
        }
        const { ext } = validateFileExtension(file.originalname || '');
        const isMd = ext === '.md' || String(file.originalname || '').toLowerCase().endsWith('.markdown');
        canonicalMime = isMd ? 'text/markdown' : 'text/plain';
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
          fileType: canonicalMime,
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
        const oldSidecar = `${oldPath}.ocr.json`;
        await fs.unlink(oldSidecar).catch(() => {});
      }

      if (canonicalMime === 'application/pdf') {
        queuePdfProcessing(access.project_id, fileId, { source: 'upload' });
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
      await fs.unlink(`${targetPath}.ocr.json`).catch(() => {});

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

  router.post('/files/:fileId/process', async (req, res) => {
    try {
      const projectId = String(req.query.project_id || req.body?.project_id || '').trim();
      if (!projectId) return res.status(400).json({ error: 'project_id_required' });
      const user = await resolveUserFromRequest(req);
      if (!user) return res.status(401).json({ error: 'apiKey required' });
      const access = await resolveProjectAccess(user.id, projectId);
      if (!access) return res.status(404).json({ error: 'project_not_found' });
      if (access.permission === 'ro') return res.status(403).json({ error: 'read_only_project' });
      const fileId = String(req.params.fileId || '').trim();
      if (!fileId) return res.status(400).json({ error: 'file_id_required' });

      const files = await dbListProjectFiles(access.owner_id, access.project_id);
      const meta = files.find((f) => String(f.file_id) === fileId);
      if (!meta) return res.status(404).json({ error: 'file_not_found' });
      if (String(meta.file_type || '').toLowerCase() !== 'application/pdf') {
        return res.status(400).json({ error: 'not_pdf' });
      }

      const force = parseBoolean(req.body?.force ?? req.query?.force, false);
      const result = await processPdfForProjectFile(access.project_id, fileId, { force });
      if (result?.status === 'ok') {
        return res.json({ project_id: access.project_id, file_id: fileId, ...result });
      }
      if (result?.status === 'disabled') {
        return res.status(400).json({ error: 'processing_disabled', details: result });
      }
      // Skipped or other statuses are still informative but not fatal
      return res.json({ project_id: access.project_id, file_id: fileId, ...result });
    } catch (e) {
      console.error('files:process error', e);
      return res.status(500).json({ error: 'files_process_failed', message: e?.message || 'Processing failed' });
    }
  });

  router.post('/files/process-all', async (req, res) => {
    try {
      const projectId = String(req.query.project_id || req.body?.project_id || '').trim();
      if (!projectId) return res.status(400).json({ error: 'project_id_required' });
      const user = await resolveUserFromRequest(req);
      if (!user) return res.status(401).json({ error: 'apiKey required' });
      const access = await resolveProjectAccess(user.id, projectId);
      if (!access) return res.status(404).json({ error: 'project_not_found' });
      if (access.permission === 'ro') return res.status(403).json({ error: 'read_only_project' });

      const force = parseBoolean(req.body?.force ?? req.query?.force, false);
      const result = await processAllProjectPdfs(access.project_id, { force });
      if (result?.status === 'ok') {
        return res.json({ project_id: access.project_id, ...result });
      }
      if (result?.status === 'disabled') {
        return res.status(400).json({ error: 'processing_disabled', details: result });
      }
      return res.json({ project_id: access.project_id, ...result });
    } catch (e) {
      console.error('files:processAll error', e);
      return res.status(500).json({ error: 'files_process_all_failed', message: e?.message || 'Processing failed' });
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
