// OpenAI provider using official SDK (Responses API)
import OpenAI from 'openai';
import { loadFilePayload, buildFileContextBlock } from './fileUtils.js';

function shouldUseWebSearch(tools) {
  // Only enable web search when explicitly asked for grounding/search.
  // Do NOT treat crawling/read as search.
  const s = new Set((tools || []).map(v => String(v || '').toLowerCase()));
  return s.has('grounding');
}

export async function infer({ apiKey, model, baseUrl, systemPrompt, userPrompt, tools = [], timeoutSec = 120, filePath, fileMeta }) {
  const client = new OpenAI({ apiKey, baseURL: String(baseUrl || '').trim() || undefined });
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const hardTimer = setTimeout(() => { try { controller?.abort(); } catch {} }, Math.max(1000, Number(timeoutSec || 0) * 1000));

  const requestParams = {
    model,
    instructions: String(systemPrompt || ''),
  };

  const userContent = [{ type: 'input_text', text: String(userPrompt || '') || 'Prompt missing?' }];

  if (filePath) {
    const attachment = await loadFilePayload(filePath, fileMeta || {});
    if (attachment?.kind === 'pdf' && attachment?.base64) {
      userContent.unshift({
        type: 'input_file',
        filename: attachment.fileName,
        file_data: `data:${attachment.mimeType};base64,${attachment.base64}`,
      });
    }
    const contextBlock = buildFileContextBlock(attachment);
    if (contextBlock) {
      userContent.push({ type: 'input_text', text: `\n\n${contextBlock}` });
    }
  }

  requestParams.input = [
    {
      role: 'user',
      content: userContent,
    },
  ];

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
                //urls.push(String(annotation.url));
                if (urls.length < 1) urls.push('Sources are cited inline.'); // openai currently return sourced already inline cited
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

    //if (reasoningText) {
    //  const reasoningSummary = reasoningText.split('\n').map((line) => `> ${line}`).join('\n');
    //  text = reasoningSummary + (text ? `\n\n${text}` : '');
    //}

    return { text, codeSnippets: [], codeResults: [], urls, toolcall_history: [] };
  } catch (err) {
    clearTimeout(hardTimer);
    console.error(err);
    throw err;
  }
}

export default { infer };
