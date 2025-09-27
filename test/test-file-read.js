// test-file-read.js
// Simple loader smoke test for external AI attachments.

import path from 'path';
import { fileURLToPath } from 'url';
import { loadFilePayload, buildFileContextBlock } from '../src/ext_ai/fileUtils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function run() {
  const filePath = path.join(__dirname, 'example.pdf');
  console.log('Reading attachment at:', filePath);

  try {
    const payload = await loadFilePayload(filePath);
    if (!payload) {
      console.error('loadFilePayload returned null/undefined payload');
      process.exit(1);
    }

    console.log('Attachment kind:', payload.kind);
    console.log('Detected mime type:', payload.mimeType);
    console.log('Extracted text length:', payload.text ? payload.text.length : 0);

    const contextBlock = buildFileContextBlock(payload);
    console.log('Context block preview:\n', contextBlock.slice(0, 250));

    if (payload.base64) {
      console.log('Base64 size:', payload.base64.length);
    }

    console.log('Attachment loader test complete.');
  } catch (err) {
    console.error('Failed to load attachment:', err);
    process.exit(1);
  }
}

run();
