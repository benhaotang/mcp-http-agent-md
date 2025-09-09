// Groq provider using official SDK
import { Groq } from 'groq-sdk';

function buildTools(tools) {
  const set = new Set((tools || []).map(t => String(t || '').toLowerCase()));
  const arr = [];
  // Only enable browser_search when grounding/search is requested.
  if (set.has('grounding') || set.has('search')) {
    arr.push({ type: 'browser_search' });
  }
  // Code tool is separate (do not infer from crawling)
  if (set.has('code') || set.has('code_execution')) {
    arr.push({ type: 'code_interpreter' });
  }
  return arr;
}

export async function infer({ apiKey, model, baseUrl, systemPrompt, userPrompt, tools = [], timeoutSec = 120 }) {
  const client = new Groq({ apiKey, baseURL: String(baseUrl || '').trim() || undefined });
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const hardTimer = setTimeout(() => { try { controller?.abort(); } catch {} }, Math.max(1000, Number(timeoutSec || 0) * 1000));

  const messages = [];
  if (systemPrompt && String(systemPrompt).trim()) messages.push({ role: 'system', content: String(systemPrompt) });
  messages.push({ role: 'user', content: String(userPrompt || '') });

  try {
    const completion = await client.chat.completions.create({
      model,
      messages,
      stream: false,
      reasoning_effort: 'medium',
      tools: buildTools(tools)
    });
    clearTimeout(hardTimer);
    const choice = (Array.isArray(completion?.choices) ? completion.choices : [])[0];
    const text = String(choice?.message?.content || '');
    // executed_tools and search_results are available on the message; surface minimal info
    const urls = [];
    const toolOut = (choice?.message?.executed_tools || []);
    for (const t of toolOut) {
      const sr = t?.search_results?.results || [];
      for (const r of sr) {
        if (r?.url) urls.push(String(r.url));
      }
    }
    return { text, codeSnippets: [], codeResults: [], urls };
  } catch (err) {
    clearTimeout(hardTimer);
    console.error(err);
    throw err;
  }
}

export default { infer };
