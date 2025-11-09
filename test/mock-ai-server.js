#!/usr/bin/env node
/**
 * Mock AI API server for testing subagent functionality
 * Simulates chat/completions endpoint for OpenAI-compatible APIs
 *
 * Usage: node test/mock-ai-server.js [port]
 * Default port: 43333
 */

import express from 'express';
import process from 'node:process';

const PORT = process.env.MOCK_AI_PORT ? Number(process.env.MOCK_AI_PORT) : 43333;
const app = express();

app.use(express.json());

// Mock chat completions endpoint
app.post('/v1/chat/completions', (req, res) => {
  const { messages, model } = req.body;

  // Extract last user message
  const lastUserMessage = messages?.filter(m => m.role === 'user').pop()?.content || '';

  // Generate a mock response
  const mockResponse = {
    id: `chatcmpl-${Math.random().toString(36).slice(2, 15)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model || 'mock-model',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: `Mock AI response to: "${lastUserMessage.slice(0, 50)}...". This is a test response from the mock AI server. Task completed successfully.`
        },
        finish_reason: 'stop'
      }
    ],
    usage: {
      prompt_tokens: 20,
      completion_tokens: 30,
      total_tokens: 50
    }
  };

  res.json(mockResponse);
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'Mock AI server is running' });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    message: 'Mock AI API Server',
    endpoints: {
      'POST /v1/chat/completions': 'Mock chat completions (OpenAI-compatible)',
      'GET /health': 'Health check'
    }
  });
});

// Start server
app.listen(PORT, '127.0.0.1', () => {
  console.log(`Mock AI server listening on http://127.0.0.1:${PORT}`);
  console.log(`Health check: http://127.0.0.1:${PORT}/health`);
  console.log(`Chat completions: POST http://127.0.0.1:${PORT}/v1/chat/completions`);
});

// Handle shutdown gracefully
process.on('SIGINT', () => {
  console.log('\nShutting down mock AI server...');
  process.exit(0);
});
