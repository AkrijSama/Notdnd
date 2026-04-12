/**
 * AI adapter implementations for cloud providers.
 * Each adapter normalizes its output to { content: string }.
 */

const DEFAULT_MODELS = {
  openai: 'gpt-4',
  grok: 'grok-beta',
  gemini: 'gemini-pro',
  anthropic: 'claude-3-5-sonnet-latest',
  openrouter: 'openai/gpt-4o-mini',
  local: 'llama3.2',
};

const DEFAULT_MAX_TOKENS = 1024;
const DEFAULT_LOCAL_ENDPOINT = 'http://localhost:11434';

function normalizeLocalEndpoint(endpoint = DEFAULT_LOCAL_ENDPOINT) {
  const trimmed = String(endpoint || DEFAULT_LOCAL_ENDPOINT).trim();
  const normalized = trimmed
    .replace(/\/+$/, '')
    .replace(/\/v1\/chat\/completions$/i, '')
    .replace(/\/chat\/completions$/i, '');

  return normalized || DEFAULT_LOCAL_ENDPOINT;
}

function getLocalChatEndpoint(endpoint) {
  const normalized = normalizeLocalEndpoint(endpoint);
  return normalized.endsWith('/v1')
    ? `${normalized}/chat/completions`
    : `${normalized}/v1/chat/completions`;
}

function getErrorDetail(errorData, fallback) {
  return (
    errorData?.error?.message ||
    errorData?.error ||
    errorData?.message ||
    fallback
  );
}

async function parseJsonResponse(response, label) {
  let data = null;

  try {
    data = await response.json();
  } catch (error) {
    if (!response.ok) {
      throw new Error(`${label} API error: ${response.statusText}`);
    }
    throw new Error(`${label} API returned invalid JSON`);
  }

  if (!response.ok) {
    throw new Error(`${label} API error: ${getErrorDetail(data, response.statusText)}`);
  }

  return data;
}

export function normalizeOpenAICompatibleResponse(data, providerName) {
  const content = data?.choices?.[0]?.message?.content;

  if (typeof content !== 'string' || content.length === 0) {
    throw new Error(`${providerName} returned an unexpected response`);
  }

  return { content };
}

export function normalizeGeminiResponse(data) {
  const content = data?.candidates?.[0]?.content?.parts?.[0]?.text;

  if (typeof content !== 'string' || content.length === 0) {
    throw new Error('Gemini returned an unexpected response');
  }

  return { content };
}

export function normalizeAnthropicResponse(data) {
  const contentPart = Array.isArray(data?.content)
    ? data.content.find(part => part?.type === 'text' && typeof part?.text === 'string')
    : null;

  if (!contentPart?.text) {
    throw new Error('Anthropic returned an unexpected response');
  }

  return { content: contentPart.text };
}

export async function callLocal(prompt, options = {}) {
  const endpoint = options.localEndpoint || process.env.LOCAL_AI_ENDPOINT || DEFAULT_LOCAL_ENDPOINT;
  const model = options.localModel || process.env.LOCAL_AI_MODEL || DEFAULT_MODELS.local;

  const response = await fetch(getLocalChatEndpoint(endpoint), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      stream: false,
    }),
  });

  const data = await parseJsonResponse(response, 'Local');
  return normalizeOpenAICompatibleResponse(data, 'Local');
}

/**
 * Call OpenAI API
 */
export async function callOpenAI(prompt, apiKey) {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: DEFAULT_MODELS.openai,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  const data = await parseJsonResponse(response, 'OpenAI');
  return normalizeOpenAICompatibleResponse(data, 'OpenAI');
}

/**
 * Call Grok API (X.AI)
 */
export async function callGrok(prompt, apiKey) {
  const response = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: DEFAULT_MODELS.grok,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  const data = await parseJsonResponse(response, 'Grok');
  return normalizeOpenAICompatibleResponse(data, 'Grok');
}

/**
 * Call Gemini API
 */
export async function callGemini(prompt, apiKey) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${DEFAULT_MODELS.gemini}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
      }),
    }
  );

  const data = await parseJsonResponse(response, 'Gemini');
  return normalizeGeminiResponse(data);
}

/**
 * Call Anthropic Messages API
 */
export async function callAnthropic(prompt, apiKey) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: DEFAULT_MODELS.anthropic,
      max_tokens: DEFAULT_MAX_TOKENS,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  const data = await parseJsonResponse(response, 'Anthropic');
  return normalizeAnthropicResponse(data);
}

/**
 * Call OpenRouter Chat Completions API
 */
export async function callOpenRouter(prompt, apiKey) {
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://notdnd.app',
      'X-Title': 'NOTDND',
      'X-OpenRouter-Title': 'NOTDND',
    },
    body: JSON.stringify({
      model: DEFAULT_MODELS.openrouter,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  const data = await parseJsonResponse(response, 'OpenRouter');
  return normalizeOpenAICompatibleResponse(data, 'OpenRouter');
}

/**
 * Generate AI content using a cloud provider and normalize to { content: string }.
 */
export async function generateAIContent(provider, prompt, apiKey, options = {}) {
  switch (provider.toLowerCase()) {
    case 'openai':
      return callOpenAI(prompt, apiKey);

    case 'grok':
      return callGrok(prompt, apiKey);

    case 'gemini':
      return callGemini(prompt, apiKey);

    case 'anthropic':
      return callAnthropic(prompt, apiKey);

    case 'openrouter':
      return callOpenRouter(prompt, apiKey);

    case 'local':
      return callLocal(prompt, options);

    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}
