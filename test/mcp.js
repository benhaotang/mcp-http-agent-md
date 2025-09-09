// Simple test for the MCP provider (aisdkmcp.js)
// Usage: pnpm run test:mcp
// Note: This test expects an OpenAI-compatible server running locally (e.g., LM Studio)
// at http://localhost:1234/v1/ with a model id like 'qwen/qwen3-4b-2507'.
// If LM Studio is not running, the test will fail with a connection error.

import { infer } from '../src/ext_ai/aisdkmcp.js';

async function main() {
  // Load MCP servers by default so tools are available
  process.env.MCP_SKIP_SERVERS = process.env.MCP_SKIP_SERVERS || 'false';

  const baseUrl = process.env.MCP_TEST_BASE_URL || 'http://localhost:1234/v1/';
  const model = process.env.MCP_TEST_MODEL || 'qwen/qwen3-4b-2507';
  const apiKey = process.env.AI_API_KEY || process.env.MCP_TEST_API_KEY || 'lm-studio';

  console.log('[mcp-test] Using endpoint:', baseUrl);
  console.log('[mcp-test] Using model:', model);

  try {
    // Test 1: only pass 'filesystem' tool to the subagent
    const res = await infer({
      apiKey,
      model,
      baseUrl,
      systemPrompt:
        'You can call MCP tools. Call exactly one available tool with minimal valid inputs. Do not call any other tools. After the tool call, reply with: TOOL_CALLED <short summary>.',
      userPrompt: 'Perform a single tool call, then respond as instructed.',
      tools: ['filesystem'],
      timeoutSec: Number(process.env.MCP_TEST_TIMEOUT || 20),
    });

    console.log('[mcp-test] Response text:', res.text);
    const history = Array.isArray(res.toolcall_history) ? res.toolcall_history : [];
    console.log('[mcp-test] Toolcall history:', JSON.stringify(history));
    if (!String(res.text || '').includes('TOOL_CALLED')) {
      throw new Error('Expected marker TOOL_CALLED in response.');
    }
    if (history.length >= 1) {
      const servers = Array.from(new Set(history.map(h => h.server).filter(Boolean)));
      if (servers.some(s => s !== 'filesystem')) {
        throw new Error(`Unexpected server(s) used: ${servers.join(', ')} (expected only 'filesystem')`);
      }
      console.log('[mcp-test] Only filesystem server tools were used as expected.');
    } else {
      console.warn('[mcp-test] No tool calls recorded (model may have chosen to answer without tools).');
    }

    // Test 2: request a missing tool and expect an early error
    let missingErr = null;
    try {
      await infer({ apiKey, model, baseUrl, systemPrompt: '', userPrompt: 'noop', tools: ['nonexistent_mcp_tool'], timeoutSec: 10 });
    } catch (e) {
      missingErr = String(e?.message || e);
    }
    if (!missingErr || !missingErr.includes('mcp_requested_servers_not_found')) {
      throw new Error('Expected mcp_requested_servers_not_found error when requesting a missing server.');
    }
    console.log('[mcp-test] Missing tool error surfaced as expected.');

    console.log('[mcp-test] Tool selection tests OK');
  } catch (err) {
    console.error('[mcp-test] Failed:', err?.message || err);
    process.exitCode = 1;
  }
}

main();
