/**
 * Regression tests for expanded BYOK provider support and local Ollama proxy mode.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const PASS = '\x1b[32m✓\x1b[0m';
const FAIL = '\x1b[31m✗\x1b[0m';

let passed = 0;
let failed = 0;

function logPass(message) {
  passed += 1;
  console.log(`${PASS} ${message}`);
}

function logFail(message, error) {
  failed += 1;
  console.error(`${FAIL} ${message}`);
  if (error) {
    console.error(error.stack || error.message || error);
  }
}

async function runTest(name, fn) {
  try {
    await fn();
    logPass(name);
  } catch (error) {
    logFail(name, error);
  }
}

function createJsonResponse(json, init = {}) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    statusText: init.statusText ?? 'OK',
    async json() {
      return json;
    },
  };
}

const sessionData = new Map();

global.sessionStorage = {
  getItem(key) {
    return sessionData.has(key) ? sessionData.get(key) : null;
  },
  setItem(key, value) {
    sessionData.set(key, String(value));
  },
  removeItem(key) {
    sessionData.delete(key);
  },
  clear() {
    sessionData.clear();
  },
};

const adapters = await import('./server/ai/adapters.js');
const client = await import('./src/api/client.js');

console.log('\n=== Provider Expansion Test Suite ===\n');

await runTest('Anthropic adapter uses /v1/messages and normalizes content', async () => {
  let capturedRequest = null;

  global.fetch = async (url, options = {}) => {
    capturedRequest = { url, options };
    return createJsonResponse({
      content: [{ type: 'text', text: 'Anthropic response' }],
    });
  };

  const result = await adapters.callAnthropic('Hello Claude', 'anthropic-key');

  assert.equal(result.content, 'Anthropic response');
  assert.equal(capturedRequest.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(capturedRequest.options.headers['x-api-key'], 'anthropic-key');
  assert.equal(capturedRequest.options.headers['anthropic-version'], '2023-06-01');

  const body = JSON.parse(capturedRequest.options.body);
  assert.equal(body.max_tokens, 1024);
  assert.equal(body.messages[0].role, 'user');
  assert.equal(body.messages[0].content, 'Hello Claude');
});

await runTest('OpenRouter adapter sends OpenRouter attribution headers', async () => {
  let capturedRequest = null;

  global.fetch = async (url, options = {}) => {
    capturedRequest = { url, options };
    return createJsonResponse({
      choices: [{ message: { content: 'OpenRouter response' } }],
    });
  };

  const result = await adapters.callOpenRouter('Hello OpenRouter', 'openrouter-key');

  assert.equal(result.content, 'OpenRouter response');
  assert.equal(capturedRequest.url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(capturedRequest.options.headers.Authorization, 'Bearer openrouter-key');
  assert.equal(capturedRequest.options.headers['HTTP-Referer'], 'https://notdnd.app');
  assert.equal(capturedRequest.options.headers['X-Title'], 'NOTDND');
});

await runTest('Local GM requests go directly to the Ollama endpoint from the client', async () => {
  sessionStorage.clear();
  client.saveSettings({
    provider: 'local',
    localEndpoint: 'http://localhost:11434',
    localModel: 'llama3.2',
  });

  const requests = [];
  global.fetch = async (url, options = {}) => {
    requests.push({ url, options });
    return createJsonResponse({
      choices: [{ message: { content: 'Local GM response' } }],
    });
  };

  const response = await client.getGMResponse({ location: 'tavern' }, 'look around');

  assert.equal(response.result, 'Local GM response');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'http://localhost:11434/v1/chat/completions');
  assert.ok(!String(requests[0].url).includes('/api/gm/respond'));

  const body = JSON.parse(requests[0].options.body);
  assert.equal(body.model, 'llama3.2');
  assert.match(body.messages[0].content, /Game Master Context:/);
  assert.match(body.messages[0].content, /Player Input: look around/);
});

await runTest('Local connection testing pings the browser-configured Ollama endpoint', async () => {
  let capturedUrl = null;

  global.fetch = async (url) => {
    capturedUrl = url;
    return createJsonResponse({ models: [] });
  };

  await client.testLocalConnection('http://localhost:11434');
  assert.equal(capturedUrl, 'http://localhost:11434/api/tags');
});

await runTest('Settings UI includes Cloud and Local tabs plus new provider fields', async () => {
  const content = await readFile(new URL('./src/components/Settings.js', import.meta.url), 'utf-8');

  assert.match(content, /Cloud/);
  assert.match(content, /Local/);
  assert.match(content, /anthropic/);
  assert.match(content, /openrouter/);
  assert.match(content, /local-endpoint-input/);
  assert.match(content, /local-model-input/);
  assert.match(content, /test-local-connection-btn/);
});

await runTest('Server env fallbacks include Anthropic and OpenRouter keys', async () => {
  const content = await readFile(new URL('./server/index.js', import.meta.url), 'utf-8');
  const envExample = await readFile(new URL('./.env.example', import.meta.url), 'utf-8');

  assert.match(content, /process\.env\.ANTHROPIC_API_KEY/);
  assert.match(content, /process\.env\.OPENROUTER_API_KEY/);
  assert.match(envExample, /ANTHROPIC_API_KEY/);
  assert.match(envExample, /OPENROUTER_API_KEY/);
});

console.log('\n=== Test Summary ===');
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);

if (failed > 0) {
  process.exit(1);
}
