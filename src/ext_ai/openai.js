// OpenAI provider using official SDK (Responses API)
import OpenAI from 'openai';

function shouldUseWebSearch(tools) {
  // Only enable web search when explicitly asked for grounding/search.
  // Do NOT treat crawling/read as search.
  const s = new Set((tools || []).map(v => String(v || '').toLowerCase()));
  return s.has('grounding') || s.has('search');
}

export async function infer({ apiKey, model, baseUrl, systemPrompt, userPrompt, tools = [], timeoutSec = 120 }) {
  const client = new OpenAI({ apiKey, baseURL: String(baseUrl || '').trim() || undefined });
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const hardTimer = setTimeout(() => { try { controller?.abort(); } catch {} }, Math.max(1000, Number(timeoutSec || 0) * 1000));

  const requestParams = {
    model,
    input: userPrompt || 'Prompt missing?',
    instructions: String(systemPrompt || ''),
  };

  if (shouldUseWebSearch(tools)) {
    requestParams.tools = [{ type: 'web_search_preview' }];
  }

  if (/^gpt-5/.test(String(model || ''))) {
    requestParams.reasoning = { effort: 'low', summary: 'auto' };
    requestParams.text = { verbosity: 'low' };
  }

  try {
    const response = await client.responses.create(requestParams);
    clearTimeout(hardTimer);

    let text = '';
    const urls = [];
    let reasoningText = '';

    const out = Array.isArray(response?.output) ? response.output : [];
    for (const item of out) {
      if (item?.type === 'message' && Array.isArray(item.content)) {
        for (const contentItem of item.content) {
          if (contentItem?.type === 'output_text') {
            if (contentItem?.text) text = contentItem.text;
            const ann = Array.isArray(contentItem?.annotations) ? contentItem.annotations : [];
            for (const annotation of ann) {
              if (annotation?.type === 'url_citation' && annotation?.url) {
                urls.push(String(annotation.url));
              }
            }
          }
        }
      } else if (item?.type === 'reasoning' && Array.isArray(item?.summary)) {
        reasoningText = item.summary
          .filter((s) => s?.type === 'summary_text')
          .map((s) => s?.text || '')
          .join('\n\n');
      }
    }

    if (reasoningText) {
      const reasoningSummary = reasoningText.split('\n').map((line) => `> ${line}`).join('\n');
      text = reasoningSummary + (text ? `\n\n${text}` : '');
    }

    return { text, codeSnippets: [], codeResults: [], urls };
  } catch (err) {
    clearTimeout(hardTimer);
    console.error(err);
    throw err;
  }
}

export default { infer };
