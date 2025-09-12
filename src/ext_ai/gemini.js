import { GoogleGenAI } from "@google/genai";

function buildGeminiTools(toolList) {
  const tools = [];
  const set = new Set(toolList || []);
  if (set.has("grounding")) tools.push({ googleSearch: {} });
  if (set.has("crawling")) tools.push({ urlContext: {} });
  if (set.has("code_execution")) tools.push({ codeExecution: {} });
  return tools;
}

// Core inference for Gemini. Takes normalized inputs and returns a provider-agnostic result.
export async function infer({ apiKey, model, systemPrompt, userPrompt, tools = [], timeoutSec = 120 }) {
  const ai = new GoogleGenAI({ apiKey });
  const geminiTools = buildGeminiTools(tools);

  const config = {
    thinkingConfig: { thinkingBudget: 8192 },
    tools: geminiTools.length
      ? geminiTools
      : [{ googleSearch: {} }, { urlContext: {} }, { codeExecution: {} }],
  };
  const contents = [
    { role: "user", parts: [{ text: String(systemPrompt || "") }] },
    { role: "user", parts: [{ text: String(userPrompt || "") }] },
  ];

  let text = "";
  const codeSnippets = [];
  const codeResults = [];
  const urls = new Set();

  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const hardTimer = setTimeout(() => {
    try { controller?.abort(); } catch {}
  }, Math.max(1000, Number(timeoutSec || 0) * 1000));

  try {
    const stream = await ai.models.generateContentStream({
      model,
      config,
      contents,
      signal: controller?.signal,
    });
    for await (const chunk of stream) {
      const c = chunk?.candidates?.[0];
      const part = c?.content?.parts?.[0];
      if (part?.text) text += part.text;
      if (part?.executableCode) codeSnippets.push(String(part.executableCode || ""));
      if (part?.codeExecutionResult) codeResults.push(String(part.codeExecutionResult || ""));
      const gm = c?.groundingMetadata;
      const chunks = gm?.groundingChunks || [];
      for (const ch of chunks) {
        const uri = ch?.web?.uri;
        if (uri) urls.add(String(uri));
      }
    }
    clearTimeout(hardTimer);
    return { text, codeSnippets, codeResults, urls: Array.from(urls), toolcall_history: [] };
  } catch (err) {
    clearTimeout(hardTimer);
    console.error(err);
    throw err;
  }
}
