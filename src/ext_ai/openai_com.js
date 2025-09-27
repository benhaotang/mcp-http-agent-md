// OpenAI-compatible endpoint provider using official SDK (Chat Completions)
import OpenAI from 'openai';
import { loadFilePayload, buildFileContextBlock } from './fileUtils.js';

export async function infer({ apiKey, model, baseUrl, systemPrompt, userPrompt, tools = [], timeoutSec = 120, filePath, fileMeta }) {
  const client = new OpenAI({ apiKey, baseURL: String(baseUrl || '').trim() || undefined });
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const hardTimer = setTimeout(() => { try { controller?.abort(); } catch {} }, Math.max(1000, Number(timeoutSec || 0) * 1000));

  const messages = [];
  if (systemPrompt && String(systemPrompt).trim()) messages.push({ role: 'system', content: String(systemPrompt) });
  let promptText = String(userPrompt ?? '');
  if (!promptText.trim()) {
    promptText = 'Prompt missing?';
  }
  if (filePath) {
    const attachment = await loadFilePayload(filePath, fileMeta || {});
    const contextBlock = buildFileContextBlock(attachment);
    if (contextBlock) {
      promptText = `${promptText}\n\n<attached_file>\n\nFile attachment content:\n\n${contextBlock}\n\n</attached_file>`.trim();
    }
  }

  messages.push({ role: 'user', content: promptText });

  try {
    const completion = await client.chat.completions.create({ model, messages, temperature: 1, stream: false, signal: controller?.signal });
    clearTimeout(hardTimer);
    const choice = (Array.isArray(completion?.choices) ? completion.choices : [])[0];
    const text = String(choice?.message?.content || '');
    return { text, codeSnippets: [], codeResults: [], urls: [], toolcall_history: [] };
  } catch (err) {
    clearTimeout(hardTimer);
    console.error(err);
    throw err;
  }
}

export default { infer };
