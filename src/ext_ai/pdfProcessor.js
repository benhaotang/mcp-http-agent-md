import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Mistral } from '@mistralai/mistralai';
import { getDataDir } from '../db.js';

const pexecFile = promisify(execFile);

function boolFromEnv(val, defaultBool = false) {
  if (val == null) return defaultBool;
  const s = String(val).toLowerCase().trim();
  if (["1","true","yes","on"].includes(s)) return true;
  if (["0","false","no","off"].includes(s)) return false;
  return defaultBool;
}

function getSidecarPath(projectId, fileId) {
  const projectDir = path.join(getDataDir(), String(projectId));
  return path.join(projectDir, `${String(fileId)}.ocr.json`);
}

async function fileExists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

async function readFileBase64(p) {
  const buf = await fs.readFile(p);
  return buf.toString('base64');
}

async function saveJsonPretty(p, obj) {
  const json = JSON.stringify(obj, null, 2);
  await fs.writeFile(p, json, 'utf-8');
}

function normalizeLocalOcrResponse(pagesMarkdown) {
  // Convert array of { index, markdown } into { pages: [...] } to match Mistral-like shape
  // Caller ensures `pagesMarkdown` is ordered by index starting at 1
  return { pages: pagesMarkdown.map(p => ({ index: p.index, markdown: String(p.markdown || '') })) };
}

async function convertPdfToPngWithPdftoppm(pdfPath) {
  // Requires poppler-utils (pdftoppm) installed on the system.
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-pdf-'));
  const outPrefix = path.join(tmpDir, 'page');
  try {
    await pexecFile('pdftoppm', ['-png', '-r', '144', pdfPath, outPrefix]);
  } catch (err) {
    // Clean up tempdir on failure
    try { await fs.rm(tmpDir, { recursive: true, force: true }); } catch {}
    const msg = (err && err.stderr) ? String(err.stderr) : String(err?.message || err);
    throw new Error(`pdftoppm_failed: ${msg}`);
  }

  // Collect generated PNGs
  const files = await fs.readdir(tmpDir);
  const pageFiles = files
    .filter(f => /page-\d+\.png$/i.test(f))
    .map(f => ({ file: f, index: Number((f.match(/page-(\d+)\.png/i) || [])[1] || '0') }))
    .filter(x => Number.isFinite(x.index) && x.index > 0)
    .sort((a, b) => a.index - b.index);

  const out = [];
  for (const pf of pageFiles) {
    const full = path.join(tmpDir, pf.file);
    const buf = await fs.readFile(full);
    out.push({ index: pf.index, mime: 'image/png', buffer: buf });
  }

  // Remove tmp dir
  try { await fs.rm(tmpDir, { recursive: true, force: true }); } catch {}
  return out;
}

async function localOcrSingleImage({ imageBuffer, mime = 'image/png' }) {
  const endpointBase = String(process.env.LOCAL_OCR_MODEL_ENDPOINT || 'http://localhost:11434').replace(/\/$/, '');
  const endpoint = `${endpointBase}/v1/chat/completions`;
  const model = String(process.env.LOCAL_OCR_MODEL || 'Nanonets-OCR-s');
  const apiKey = String(process.env.LOCAL_OCR_API_KEY || '').trim();

  const base64 = imageBuffer.toString('base64');
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const body = {
    model,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: '' },
          { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } },
        ],
      },
    ],
  };

  const resp = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!resp.ok) {
    let msg;
    try { const j = await resp.json(); msg = JSON.stringify(j); } catch { msg = await resp.text(); }
    throw new Error(`local_ocr_http_${resp.status}: ${msg}`);
  }
  const data = await resp.json();
  const choice = Array.isArray(data?.choices) ? data.choices[0] : null;
  let content = choice?.message?.content;
  if (Array.isArray(content)) {
    // OpenAI-compatible sometimes returns array of content parts
    content = content.map(part => part?.text || part?.content || '').join('\n');
  }
  return String(content || '').trim();
}

async function runMistralOcr(pdfPath) {
  const apiKey = String(process.env.MISTRAL_AI_API || process.env.MISTRAL_API_KEY || '').trim();
  if (!apiKey) throw new Error('mistral_api_key_missing');
  const client = new Mistral({ apiKey });
  const base64Pdf = await readFileBase64(pdfPath);
  const result = await client.ocr.process({
    model: 'mistral-ocr-latest',
    document: { type: 'document_url', documentUrl: `data:application/pdf;base64,${base64Pdf}` },
    includeImageBase64: true,
  });
  return result;
}

export async function processPdfForProjectFile(projectId, fileId, { force = false } = {}) {
  const projectDir = path.join(getDataDir(), String(projectId));
  const filePath = path.join(projectDir, String(fileId));
  try { await fs.access(filePath); } catch { throw new Error('file_missing_on_disk'); }

  const sidecar = getSidecarPath(projectId, fileId);
  if (!force && await fileExists(sidecar)) {
    return { status: 'skipped', reason: 'exists', sidecar };
  }

  const useLocal = boolFromEnv(process.env.USE_LOCAL_AI_FOR_DOC_UNDERSTANDING, false);
  const hasMistral = !!String(process.env.MISTRAL_AI_API || process.env.MISTRAL_API_KEY || '').trim();

  if (useLocal) {
    // Extract pages to images then OCR each page
    const pages = await convertPdfToPngWithPdftoppm(filePath);
    const pagesOut = [];
    let idx = 0;
    for (const page of pages) {
      idx++;
      try {
        const md = await localOcrSingleImage({ imageBuffer: page.buffer, mime: page.mime });
        pagesOut.push({ index: idx, markdown: md });
      } catch (err) {
        pagesOut.push({ index: idx, markdown: `<!-- local OCR failed: ${String(err?.message || err)} -->` });
      }
    }
    const json = normalizeLocalOcrResponse(pagesOut);
    await saveJsonPretty(sidecar, json);
    return { status: 'ok', provider: 'local', pages: pagesOut.length, sidecar };
  }

  if (hasMistral) {
    const result = await runMistralOcr(filePath);
    // Save exactly as returned (may include base64 images per page)
    await saveJsonPretty(sidecar, result);
    return { status: 'ok', provider: 'mistral', pages: Array.isArray(result?.pages) ? result.pages.length : undefined, sidecar };
  }

  return { status: 'disabled', reason: 'no_provider_configured' };
}

export async function processAllProjectPdfs(projectId, { force = false } = {}) {
  // Iterate files in the project directory and process PDFs that lack sidecar payloads.

  const projectDir = path.join(getDataDir(), String(projectId));
  try { await fs.access(projectDir); } catch { return { status: 'ok', processed: 0, skipped: 0 }; }

  // Scan disk for potential file ids (16-char hex)
  const entries = await fs.readdir(projectDir);
  const fileIds = entries.filter(f => /^[a-f0-9]{16}$/i.test(f));

  let processed = 0;
  let skipped = 0;
  const results = [];
  for (const fid of fileIds) {
    const sidecar = getSidecarPath(projectId, fid);
    if (!force && await fileExists(sidecar)) { skipped++; continue; }
    // Attempt a magic check: read first bytes to guess PDF header
    try {
      const fd = await fs.open(path.join(projectDir, fid), 'r');
      const buf = Buffer.alloc(5);
      await fd.read(buf, 0, 5, 0);
      await fd.close();
      const isPdf = buf.toString('ascii') === '%PDF-';
      if (!isPdf) { skipped++; continue; }
    } catch { skipped++; continue; }

    try {
      const r = await processPdfForProjectFile(projectId, fid, { force });
      results.push({ file_id: fid, ...r });
      if (r.status === 'ok') processed++; else skipped++;
    } catch (err) {
      results.push({ file_id: fid, status: 'error', error: String(err?.message || err) });
    }
  }
  return { status: 'ok', processed, skipped, results };
}

export default {
  processPdfForProjectFile,
  processAllProjectPdfs,
};
