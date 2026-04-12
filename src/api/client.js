/**
 * API Client for NOTDND
 * Handles communication with the backend, including BYOK headers
 */

const API_BASE = '';
export const DEFAULT_LOCAL_ENDPOINT = 'http://localhost:11434';
export const DEFAULT_LOCAL_MODEL = 'llama3.2';
export const DEFAULT_AUTO_SPAWN_ENTITIES = true;

const STORAGE_KEYS = {
  provider: 'ai_provider',
  cloudProvider: 'ai_cloud_provider',
  apiKey: 'ai_api_key',
  localEndpoint: 'ai_local_endpoint',
  localModel: 'ai_local_model',
  gmAutoSpawn: 'gm_auto_spawn_entities',
};

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function normalizeLocalEndpoint(endpoint = DEFAULT_LOCAL_ENDPOINT) {
  const trimmed = (endpoint || DEFAULT_LOCAL_ENDPOINT).trim();
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

function getLocalConnectionEndpoint(endpoint) {
  const normalized = normalizeLocalEndpoint(endpoint);
  return normalized.endsWith('/v1')
    ? `${normalized}/models`
    : `${normalized}/api/tags`;
}

function buildGMPrompt(context, userInput) {
  return `
Game Master Context: ${JSON.stringify(context)}

Player Input: ${userInput}

Respond as the Game Master, narrating what happens next in the story.
`;
}

function readAutoSpawnSetting() {
  const stored = sessionStorage.getItem(STORAGE_KEYS.gmAutoSpawn);
  return stored == null ? DEFAULT_AUTO_SPAWN_ENTITIES : stored === 'true';
}

/**
 * Get stored API provider and key from sessionStorage
 */
function getStoredCredentials() {
  const provider = sessionStorage.getItem(STORAGE_KEYS.provider) || 'local';
  const cloudProvider =
    sessionStorage.getItem(STORAGE_KEYS.cloudProvider) ||
    (provider !== 'local' ? provider : 'openai');
  const apiKey = sessionStorage.getItem(STORAGE_KEYS.apiKey) || '';
  const localEndpoint = normalizeLocalEndpoint(
    sessionStorage.getItem(STORAGE_KEYS.localEndpoint) || DEFAULT_LOCAL_ENDPOINT
  );
  const localModel = sessionStorage.getItem(STORAGE_KEYS.localModel) || DEFAULT_LOCAL_MODEL;
  const autoSpawnEntities = readAutoSpawnSetting();

  return { provider, cloudProvider, apiKey, localEndpoint, localModel, autoSpawnEntities };
}

async function parseErrorResponse(response, fallbackMessage) {
  try {
    const data = await response.json();
    return data?.message || data?.error || fallbackMessage;
  } catch (error) {
    return fallbackMessage;
  }
}

async function requestLocalProxy(prompt, options = {}) {
  const { localEndpoint, localModel } = getStoredCredentials();
  const { model, ...rest } = options;

  const response = await fetch(getLocalChatEndpoint(localEndpoint), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: model || localModel,
      messages: [{ role: 'user', content: prompt }],
      stream: false,
      ...rest,
    }),
  });

  if (!response.ok) {
    const message = await parseErrorResponse(
      response,
      `Local proxy request failed: ${response.statusText}`
    );
    throw new Error(message);
  }

  const data = await response.json();
  const result = data?.choices?.[0]?.message?.content;

  if (typeof result !== 'string' || result.length === 0) {
    throw new Error('Local proxy returned an unexpected response');
  }

  return { result, provider: 'local', spawn: [], pendingSpawns: [] };
}

/**
 * Make an API request with AI provider headers
 */
async function apiRequest(endpoint, options = {}) {
  const { provider, apiKey } = getStoredCredentials();

  const headers = {
    'Content-Type': 'application/json',
    ...options.headers,
  };

  // Always attach the selected provider so the server does not fall back to env defaults.
  if (provider) {
    headers['X-AI-Provider'] = provider;
    if (provider !== 'local' && apiKey) {
      headers['X-AI-Key'] = apiKey;
    }
  }

  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers,
  });

  if (response.status === 402) {
    const error = await response.json();
    throw new Error(error.message || 'API key required');
  }

  if (!response.ok) {
    throw new Error(`API request failed: ${response.statusText}`);
  }

  return response.json();
}

/**
 * Generate AI content
 */
export async function generateAI(prompt, options = {}) {
  const { provider, localEndpoint, localModel } = getStoredCredentials();

  if (provider === 'local') {
    if (options.forceServer) {
      return apiRequest('/api/ai/generate', {
        method: 'POST',
        body: JSON.stringify({ prompt, localEndpoint, localModel }),
      });
    }

    return requestLocalProxy(prompt, options);
  }

  return apiRequest('/api/ai/generate', {
    method: 'POST',
    body: JSON.stringify({ prompt, ...options }),
  });
}

/**
 * Get GM response
 */
export async function getGMResponse(context, userInput, options = {}) {
  const {
    provider,
    autoSpawnEntities,
    localEndpoint,
    localModel,
  } = getStoredCredentials();

  if (provider === 'local' && !options.forceServer) {
    return requestLocalProxy(buildGMPrompt(context, userInput));
  }

  const requestBody = {
    context,
    userInput,
    autoSpawnEntities:
      typeof options.autoSpawnEntities === 'boolean'
        ? options.autoSpawnEntities
        : autoSpawnEntities,
    localEndpoint,
    localModel,
  };

  return apiRequest('/api/gm/respond', {
    method: 'POST',
    body: JSON.stringify(requestBody),
  });
}

export async function getCampaignState(context = {}) {
  const campaignId = context?.campaignId ? `?campaignId=${encodeURIComponent(context.campaignId)}` : '';
  return apiRequest(`/api/campaign/state${campaignId}`, {
    method: 'GET',
  });
}

export async function updateGMSettings(autoSpawnEntities, context = {}) {
  saveGMSettings({ autoSpawnEntities });
  return apiRequest('/api/gm/settings', {
    method: 'POST',
    body: JSON.stringify({
      autoSpawnEntities,
      context,
    }),
  });
}

export async function approvePendingSpawns(pendingSpawnIds = [], context = {}) {
  return apiRequest('/api/gm/spawn/approve', {
    method: 'POST',
    body: JSON.stringify({
      pendingSpawnIds,
      context,
    }),
  });
}

/**
 * Test the local Ollama endpoint from the browser.
 */
export async function testLocalConnection(endpoint = getStoredCredentials().localEndpoint) {
  const response = await fetch(getLocalConnectionEndpoint(endpoint), {
    method: 'GET',
  });

  if (!response.ok) {
    const message = await parseErrorResponse(
      response,
      `Local connection test failed: ${response.statusText}`
    );
    throw new Error(message);
  }

  return response.json();
}

export function saveGMSettings(settings = {}) {
  if (hasOwn(settings, 'autoSpawnEntities')) {
    sessionStorage.setItem(
      STORAGE_KEYS.gmAutoSpawn,
      settings.autoSpawnEntities ? 'true' : 'false'
    );
  }
}

/**
 * Save AI provider settings to sessionStorage
 */
export function saveSettings(providerOrSettings, apiKey) {
  if (typeof providerOrSettings === 'string') {
    sessionStorage.setItem(STORAGE_KEYS.provider, providerOrSettings);

    if (providerOrSettings !== 'local') {
      sessionStorage.setItem(STORAGE_KEYS.cloudProvider, providerOrSettings);
    }

    if (apiKey !== undefined) {
      if (apiKey) {
        sessionStorage.setItem(STORAGE_KEYS.apiKey, apiKey);
      } else {
        sessionStorage.removeItem(STORAGE_KEYS.apiKey);
      }
    }

    return;
  }

  const settings = providerOrSettings || {};

  if (hasOwn(settings, 'provider') && settings.provider) {
    sessionStorage.setItem(STORAGE_KEYS.provider, settings.provider);
    if (settings.provider !== 'local') {
      sessionStorage.setItem(STORAGE_KEYS.cloudProvider, settings.provider);
    }
  }

  if (hasOwn(settings, 'apiKey')) {
    if (settings.apiKey) {
      sessionStorage.setItem(STORAGE_KEYS.apiKey, settings.apiKey);
    } else {
      sessionStorage.removeItem(STORAGE_KEYS.apiKey);
    }
  }

  if (hasOwn(settings, 'localEndpoint')) {
    sessionStorage.setItem(
      STORAGE_KEYS.localEndpoint,
      normalizeLocalEndpoint(settings.localEndpoint || DEFAULT_LOCAL_ENDPOINT)
    );
  }

  if (hasOwn(settings, 'localModel')) {
    sessionStorage.setItem(
      STORAGE_KEYS.localModel,
      (settings.localModel || DEFAULT_LOCAL_MODEL).trim()
    );
  }

  if (hasOwn(settings, 'autoSpawnEntities')) {
    saveGMSettings({ autoSpawnEntities: settings.autoSpawnEntities });
  }
}

/**
 * Get current settings
 */
export function getSettings() {
  return getStoredCredentials();
}
