import { GoogleGenAI } from "@google/genai";

function buildGeminiTools(toolList) {
  const tools = [];
  const set = new Set(toolList || []);
  if (set.has("grounding")) tools.push({ googleSearch: {} });
  if (set.has("crawling")) tools.push({ urlContext: {} });
  if (set.has("code_execution")) tools.push({ codeExecution: {} });
  return tools;
}

function addCitations(response) {
  let text = response.text;
  const supports = response.candidates?.[0]?.groundingMetadata?.groundingSupports;
  const chunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks;

  if (!supports || !chunks) {
    return text;
  }

  // Sort supports by end_index in descending order to avoid shifting issues when inserting.
  const sortedSupports = [...supports].sort(
      (a, b) => (b.segment?.endIndex ?? 0) - (a.segment?.endIndex ?? 0),
  );

  for (const support of sortedSupports) {
      const endIndex = support.segment?.endIndex;
      if (endIndex === undefined || !support.groundingChunkIndices?.length) {
      continue;
      }

      const citationLinks = support.groundingChunkIndices
      .map(i => {
          const uri = chunks[i]?.web?.uri;
          if (uri) {
          return `[${i + 1}](${uri})`;
          }
          return null;
      })
      .filter(Boolean);

      if (citationLinks.length > 0) {
      const citationString = " " + citationLinks.join(", ");
      text = text.slice(0, endIndex) + citationString + text.slice(endIndex);
      }
  }

  return text;
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

  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const hardTimer = setTimeout(() => {
    try { controller?.abort(); } catch {}
  }, Math.max(1000, Number(timeoutSec || 0) * 1000));

  try {
    const result = await ai.models.generateContent({
      model,
      config,
      contents,
      signal: controller?.signal,
    });
    clearTimeout(hardTimer);

    const text = result.text;
    const candidates = result.candidates;

    const textWithCitations = addCitations({ text, candidates });

    const codeSnippets = [];
    const codeResults = [];
    let urls = [];

    if (candidates && candidates.length > 0) {
        const c = candidates[0];
        if (c.content && c.content.parts) {
            for (const part of c.content.parts) {
                if (part.executableCode) codeSnippets.push(String(part.executableCode || ""));
                if (part.codeExecutionResult) codeResults.push(String(part.codeExecutionResult || ""));
            }
        }
        const gm = c.groundingMetadata;
        const supports = gm?.groundingSupports;
        const chunks = gm?.groundingChunks;

        if (supports && chunks && supports.length > 0 && chunks.length > 0) {
            urls = ['Sources are cited inline.'];
        } else if (gm && gm.groundingChunks) {
            const urlSet = new Set();
            for (const ch of gm.groundingChunks) {
                const uri = ch?.web?.uri;
                if (uri) urlSet.add(String(uri));
            }
            urls = Array.from(urlSet);
        }
    }

    return { text: textWithCitations, codeSnippets, codeResults, urls, toolcall_history: [] };
  } catch (err) {
    clearTimeout(hardTimer);
    console.error(err);
    throw err;
  }
}
