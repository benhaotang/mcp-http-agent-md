// OpenAI-compatible endpoint provider using official SDK (Chat Completions)
import OpenAI from 'openai';

export async function infer({ apiKey, model, baseUrl, systemPrompt, userPrompt, tools = [], timeoutSec = 120 }) {
  const client = new OpenAI({ apiKey, baseURL: String(baseUrl || '').trim() || undefined });
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const hardTimer = setTimeout(() => { try { controller?.abort(); } catch {} }, Math.max(1000, Number(timeoutSec || 0) * 1000));

  const messages = [];
  if (systemPrompt && String(systemPrompt).trim()) messages.push({ role: 'system', content: String(systemPrompt) });
  messages.push({ role: 'user', content: String(userPrompt || '') });

  try {
    const completion = await client.chat.completions.create({ model, messages, temperature: 1, stream: false, signal: controller?.signal });
    clearTimeout(hardTimer);
    const choice = (Array.isArray(completion?.choices) ? completion.choices : [])[0];
    const text = String(choice?.message?.content || '');
    return { text, codeSnippets: [], codeResults: [], urls: [] };
  } catch (err) {
    clearTimeout(hardTimer);
    console.error(err);
    throw err;
  }
}

export default { infer };
