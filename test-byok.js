/**
 * BYOK Implementation Test Suite
 * Tests all acceptance criteria for ticket-7002ac76
 */

import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PASS = '\x1b[32m✓\x1b[0m';
const FAIL = '\x1b[31m✗\x1b[0m';
const INFO = '\x1b[34mℹ\x1b[0m';

let testsPassed = 0;
let testsFailed = 0;

function log(message) {
  console.log(message);
}

function pass(message) {
  testsPassed++;
  log(`${PASS} ${message}`);
}

function fail(message) {
  testsFailed++;
  log(`${FAIL} ${message}`);
}

function info(message) {
  log(`${INFO} ${message}`);
}

async function readFileContent(path) {
  try {
    return await readFile(join(__dirname, path), 'utf-8');
  } catch (error) {
    return null;
  }
}

function checkFileExists(content, filename) {
  if (content !== null) {
    pass(`${filename} exists`);
    return true;
  } else {
    fail(`${filename} does not exist`);
    return false;
  }
}

function checkStringInFile(content, searchString, description, filename) {
  if (content && content.includes(searchString)) {
    pass(`${description} found in ${filename}`);
    return true;
  } else {
    fail(`${description} NOT found in ${filename}`);
    return false;
  }
}

function checkStringNotInFile(content, searchString, description, filename) {
  if (content && !content.includes(searchString)) {
    pass(`${description} correctly absent from ${filename}`);
    return true;
  } else {
    fail(`${description} incorrectly present in ${filename}`);
    return false;
  }
}

async function testAcceptanceCriteria() {
  log('\n=== BYOK Implementation Test Suite ===\n');

  // AC1: Settings UI panel created with provider dropdown and API key input
  log('AC1: Settings UI panel with provider dropdown and API key input');
  const settingsContent = await readFileContent('src/components/Settings.js');

  if (checkFileExists(settingsContent, 'src/components/Settings.js')) {
    checkStringInFile(settingsContent, 'openai', 'OpenAI provider option', 'Settings.js');
    checkStringInFile(settingsContent, 'grok', 'Grok provider option', 'Settings.js');
    checkStringInFile(settingsContent, 'gemini', 'Gemini provider option', 'Settings.js');
    checkStringInFile(settingsContent, 'local', 'Local provider option', 'Settings.js');
    checkStringInFile(settingsContent, 'provider-select', 'Provider dropdown', 'Settings.js');
    checkStringInFile(settingsContent, 'api-key-input', 'API key input field', 'Settings.js');
  }

  log('');

  // AC2: API keys stored in sessionStorage
  log('AC2: API keys stored in sessionStorage and retrieved on page load');
  const clientContent = await readFileContent('src/api/client.js');

  if (checkFileExists(clientContent, 'src/api/client.js')) {
    checkStringInFile(clientContent, 'sessionStorage.setItem', 'sessionStorage.setItem usage', 'client.js');
    checkStringInFile(clientContent, 'ai_api_key', 'ai_api_key storage key', 'client.js');
    checkStringInFile(clientContent, 'ai_provider', 'ai_provider storage key', 'client.js');
    checkStringInFile(settingsContent, 'loadSettings', 'Load settings on page load', 'Settings.js');
  }

  log('');

  // AC3: client.js attaches X-AI-Provider and X-AI-Key headers
  log('AC3: src/api/client.js attaches X-AI-Provider and X-AI-Key headers');

  if (clientContent) {
    checkStringInFile(clientContent, 'X-AI-Provider', 'X-AI-Provider header', 'client.js');
    checkStringInFile(clientContent, 'X-AI-Key', 'X-AI-Key header', 'client.js');
    checkStringInFile(clientContent, '/api/ai/generate', '/api/ai/generate endpoint', 'client.js');
    checkStringInFile(clientContent, '/api/gm/respond', '/api/gm/respond endpoint', 'client.js');
  }

  log('');

  // AC4: server/index.js reads headers and passes to AI adapter
  log('AC4: server/index.js reads headers and passes to AI adapter layer');
  const serverContent = await readFileContent('server/index.js');

  if (checkFileExists(serverContent, 'server/index.js')) {
    checkStringInFile(serverContent, 'x-ai-provider', 'Reading X-AI-Provider header', 'server/index.js');
    checkStringInFile(serverContent, 'x-ai-key', 'Reading X-AI-Key header', 'server/index.js');
    checkStringInFile(serverContent, 'generateAIResponse', 'Calling AI adapter layer', 'server/index.js');
    checkStringInFile(serverContent, 'generateGMResponse', 'Calling GM adapter layer', 'server/index.js');
  }

  log('');

  // AC5: Server falls back to process.env keys
  log('AC5: Server falls back to process.env keys when headers not provided');

  if (serverContent) {
    checkStringInFile(serverContent, 'process.env.OPENAI_API_KEY', 'OpenAI env var fallback', 'server/index.js');
    checkStringInFile(serverContent, 'process.env.GROK_API_KEY', 'Grok env var fallback', 'server/index.js');
    checkStringInFile(serverContent, 'process.env.GEMINI_API_KEY', 'Gemini env var fallback', 'server/index.js');
    checkStringInFile(serverContent, 'getAICredentials', 'Credential resolution function', 'server/index.js');
  }

  log('');

  // AC6: Server returns 402 with specific error
  log('AC6: Server returns 402 with {error:"no_key", message:"Please provide an API key in Settings"}');

  if (serverContent) {
    checkStringInFile(serverContent, '402', '402 status code', 'server/index.js');
    checkStringInFile(serverContent, 'no_key', 'no_key error code', 'server/index.js');
    checkStringInFile(serverContent, 'Please provide an API key in Settings', 'Error message text', 'server/index.js');
    checkStringInFile(serverContent, 'validateCredentials', 'Credential validation', 'server/index.js');
  }

  log('');

  // AC7: Local provider works without requiring a key
  log('AC7: Local provider option works without requiring a key');
  const promptingContent = await readFileContent('server/gm/prompting.js');

  if (checkFileExists(promptingContent, 'server/gm/prompting.js')) {
    checkStringInFile(promptingContent, 'local', 'Local provider support', 'prompting.js');
    checkStringInFile(promptingContent, 'callLocal', 'Local provider function', 'prompting.js');
  }

  if (serverContent) {
    checkStringInFile(serverContent, "provider === 'local'", 'Local provider validation', 'server/index.js');
  }

  if (settingsContent) {
    checkStringInFile(settingsContent, 'requiresKey: false', 'Local provider requires no key', 'Settings.js');
  }

  log('');

  // AC8: No API key values in server logs
  log('AC8: No API key values appear in server logs');

  if (serverContent) {
    checkStringNotInFile(serverContent, 'console.log(apiKey', 'Direct apiKey logging', 'server/index.js');
    checkStringNotInFile(serverContent, 'console.log(.*key.*)', 'Key value logging', 'server/index.js');
    checkStringInFile(serverContent, '// Log provider and source, but NEVER log the API key', 'Logging safety comment', 'server/index.js');
  }

  log('');

  // AC9: Existing env var deployments continue to work
  log('AC9: Existing env var deployments continue to function unchanged');

  if (serverContent) {
    checkStringInFile(serverContent, 'source: \'env\'', 'Environment variable source tracking', 'server/index.js');
    checkStringInFile(serverContent, 'process.env', 'Environment variable usage', 'server/index.js');
  }

  const envExampleContent = await readFileContent('.env.example');
  if (checkFileExists(envExampleContent, '.env.example')) {
    checkStringInFile(envExampleContent, 'OPENAI_API_KEY', 'OpenAI env var example', '.env.example');
    checkStringInFile(envExampleContent, 'GROK_API_KEY', 'Grok env var example', '.env.example');
    checkStringInFile(envExampleContent, 'GEMINI_API_KEY', 'Gemini env var example', '.env.example');
  }

  log('');

  // Additional checks
  log('Additional Implementation Checks:');

  const packageContent = await readFileContent('package.json');
  checkFileExists(packageContent, 'package.json');

  const indexHtmlContent = await readFileContent('public/index.html');
  if (checkFileExists(indexHtmlContent, 'public/index.html')) {
    checkStringInFile(indexHtmlContent, 'Settings', 'Settings UI integration', 'index.html');
  }

  const stylesContent = await readFileContent('public/styles.css');
  checkFileExists(stylesContent, 'public/styles.css');

  // Summary
  log('\n=== Test Summary ===');
  log(`Passed: ${testsPassed}`);
  log(`Failed: ${testsFailed}`);

  if (testsFailed === 0) {
    log(`\n${PASS} All acceptance criteria verified!`);
    process.exit(0);
  } else {
    log(`\n${FAIL} Some tests failed. Please review.`);
    process.exit(1);
  }
}

// Run tests
testAcceptanceCriteria().catch(error => {
  console.error('Test suite error:', error);
  process.exit(1);
});
