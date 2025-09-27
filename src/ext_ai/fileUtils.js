import fs from 'fs/promises';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const pdfParseModule = require('pdf-parse');
const pdfParse = typeof pdfParseModule === 'function' ? pdfParseModule : pdfParseModule?.default;

if (typeof pdfParse !== 'function') {
  throw new Error('pdf-parse module did not export a function');
}

const SUPPORTED_EXTS = new Set(['.pdf', '.md', '.txt']);
const MIME_BY_EXT = {
  '.pdf': 'application/pdf',
  '.md': 'text/markdown',
  '.txt': 'text/plain',
};
const DEFAULT_TEXT_LIMIT = 120_000;

function resolveAttachmentLimit() {
  const raw = process.env.AI_ATTACHMENT_TEXT_LIMIT;
  if (raw == null || String(raw).trim() === '') return DEFAULT_TEXT_LIMIT;
  const num = Number(String(raw).trim());
  if (!Number.isFinite(num)) return DEFAULT_TEXT_LIMIT;
  if (num < 0) return -1;
  return Math.floor(num);
}

const TEXT_LIMIT = resolveAttachmentLimit();

function truncateText(text) {
  if (typeof text !== 'string') return '';
  if (TEXT_LIMIT < 0) return text;
  if (text.length <= TEXT_LIMIT) return text;
  const truncated = text.slice(0, TEXT_LIMIT);
  return `${truncated}\n\n[Truncated to ${TEXT_LIMIT} characters]`;
}

// opts: { mimeType?: string, originalName?: string, extOverride?: string }
export async function loadFilePayload(filePath, opts = {}) {
  if (!filePath) return null;
  const resolved = path.resolve(filePath);
  const metaMime = String(opts?.mimeType || '').toLowerCase();
  let ext = String(opts?.extOverride || '').toLowerCase();
  if (!ext) {
    if (metaMime.includes('pdf')) ext = '.pdf';
    else if (metaMime.includes('markdown')) ext = '.md';
    else if (metaMime.includes('text')) ext = '.txt';
    else ext = path.extname(resolved).toLowerCase();
  }
  const usePdf = metaMime.includes('pdf') || ext === '.pdf';

  const fileName = String(opts?.originalName || path.basename(resolved));
  const mimeType = metaMime || MIME_BY_EXT[ext] || 'application/octet-stream';

  if (usePdf) {
    const buffer = await fs.readFile(resolved);
    const base64 = buffer.toString('base64');
    let text = '';
    try {
      const parsed = await pdfParse(buffer);
      text = truncateText(parsed?.text || '');
    } catch (err) {
      text = '';
      console.warn(`[ext_ai] Failed to extract text from PDF '${fileName}':`, err?.message || err);
    }
    return { kind: 'pdf', ext: '.pdf', fileName, filePath: resolved, mimeType, base64, text };
  }

  // Default: treat as UTF-8 text (Markdown/Text)
  const text = truncateText(await fs.readFile(resolved, 'utf-8'));
  return { kind: 'text', ext: ext || '.txt', fileName, filePath: resolved, mimeType, text };
}

export function buildFileContextBlock(payload) {
  if (!payload) return '';
  if (!payload.text) return '';
  return `Attached file: ${payload.fileName}\n\n${payload.text}`.trim();
}
