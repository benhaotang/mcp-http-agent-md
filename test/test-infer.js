// test-infer.js

import { infer } from '../src/ext_ai/openai.js';

async function runTest() {
  const apiKey = process.env.AI_API_KEY;
  if (!apiKey) {
    console.error('Error: AI_API_KEY environment variable is not set.');
    process.exit(1);
  }

  console.log('Running OpenAI inference test...');

  try {
    const result = await infer({
      apiKey,
      model: 'gpt-5-mini',
      systemPrompt: 'You are a helpful assistant.',
      userPrompt: 'Tell me about Mac OS 26 by searching the web',
      tools: ['grounding'],
      timeoutSec: 60,
    });

    console.log('--- Inference Result ---');
    console.log(JSON.stringify(result, null, 2));
    console.log('------------------------');

  } catch (error) {
    console.error('Inference failed:', error);
    process.exit(1);
  }
}

runTest();
