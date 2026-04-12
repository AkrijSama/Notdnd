/**
 * NOTDND Server
 * Express server with BYOK (Bring Your Own Key) support
 */

import express from 'express';
import { generateAIResponse, generateGMResponse } from './gm/prompting.js';
import {
  addSpawnsToCampaign,
  appendChatMessage,
  approvePendingSpawns,
  getAutoSpawnEntities,
  getCampaignState,
  queueSpawnEntries,
  resolveCampaignId,
  setAutoSpawnEntities,
} from './db/repository.js';
import { attachRealtimeClient, broadcast, getConnectedClientCount } from './realtime/wsHub.js';

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static('public'));
app.use(express.static('src'));

/**
 * Extract AI credentials from headers or environment variables
 * @param {object} req - Express request object
 * @returns {object} { provider, apiKey, source }
 */
function getAICredentials(req) {
  // Check headers first (BYOK)
  const headerProvider = req.headers['x-ai-provider'];
  const headerKey = req.headers['x-ai-key'];
  const localEndpoint = req.headers['x-local-endpoint'] || req.body?.localEndpoint || null;
  const localModel = req.headers['x-local-model'] || req.body?.localModel || null;

  if (headerProvider) {
    // User provided BYOK
    return {
      provider: String(headerProvider).toLowerCase(),
      apiKey: headerKey || null,
      source: 'header',
      localEndpoint,
      localModel,
    };
  }

  // Fallback to environment variables
  // Check for provider-specific env vars
  if (process.env.OPENAI_API_KEY) {
    return {
      provider: 'openai',
      apiKey: process.env.OPENAI_API_KEY,
      source: 'env',
      localEndpoint,
      localModel,
    };
  }

  if (process.env.GROK_API_KEY) {
    return {
      provider: 'grok',
      apiKey: process.env.GROK_API_KEY,
      source: 'env',
      localEndpoint,
      localModel,
    };
  }

  if (process.env.GEMINI_API_KEY) {
    return {
      provider: 'gemini',
      apiKey: process.env.GEMINI_API_KEY,
      source: 'env',
      localEndpoint,
      localModel,
    };
  }

  if (process.env.ANTHROPIC_API_KEY) {
    return {
      provider: 'anthropic',
      apiKey: process.env.ANTHROPIC_API_KEY,
      source: 'env',
      localEndpoint,
      localModel,
    };
  }

  if (process.env.OPENROUTER_API_KEY) {
    return {
      provider: 'openrouter',
      apiKey: process.env.OPENROUTER_API_KEY,
      source: 'env',
      localEndpoint,
      localModel,
    };
  }

  // Default to local if no credentials provided
  return {
    provider: 'local',
    apiKey: null,
    source: 'default',
    localEndpoint,
    localModel,
  };
}

/**
 * Validate that credentials are sufficient for the provider
 * @param {string} provider - AI provider name
 * @param {string} apiKey - API key (can be null)
 * @returns {boolean} true if valid, false otherwise
 */
function validateCredentials(provider, apiKey) {
  // Local provider doesn't require a key
  if (provider === 'local') {
    return true;
  }

  // All other providers require a key
  return apiKey != null && apiKey !== '';
}

function buildAdapterOptions(credentials) {
  return {
    localEndpoint: credentials.localEndpoint,
    localModel: credentials.localModel,
  };
}

/**
 * POST /api/ai/generate
 * Generate AI content
 */
app.post('/api/ai/generate', async (req, res) => {
  try {
    const { prompt } = req.body;

    if (!prompt) {
      return res.status(400).json({ error: 'bad_request', message: 'Prompt is required' });
    }

    const credentials = getAICredentials(req);
    const { provider, apiKey, source } = credentials;

    // Log provider and source, but NEVER log the API key
    console.log(`[AI Generate] Provider: ${provider}, Source: ${source}`);

    // Validate credentials
    if (!validateCredentials(provider, apiKey)) {
      return res.status(402).json({
        error: 'no_key',
        message: 'Please provide an API key in Settings',
      });
    }

    // Generate response
    const result = await generateAIResponse(provider, prompt, apiKey, buildAdapterOptions(credentials));

    return res.json({ result, provider });
  } catch (error) {
    console.error('[AI Generate] Error:', error.message);
    return res.status(500).json({ error: 'server_error', message: error.message });
  }
});

/**
 * POST /api/gm/respond
 * Get GM response for game
 */
app.post('/api/gm/respond', async (req, res) => {
  try {
    const { context, userInput } = req.body;

    if (!userInput) {
      return res.status(400).json({ error: 'bad_request', message: 'User input is required' });
    }

    const credentials = getAICredentials(req);
    const { provider, apiKey, source } = credentials;
    const campaignId = resolveCampaignId(context || {});

    // Log provider and source, but NEVER log the API key
    console.log(`[GM Respond] Provider: ${provider}, Source: ${source}`);

    // Validate credentials
    if (!validateCredentials(provider, apiKey)) {
      return res.status(402).json({
        error: 'no_key',
        message: 'Please provide an API key in Settings',
      });
    }

    if (typeof req.body.autoSpawnEntities === 'boolean') {
      setAutoSpawnEntities(campaignId, req.body.autoSpawnEntities);
    }

    const autoSpawnEntities = getAutoSpawnEntities(campaignId);

    // Generate GM response
    const gmResult = await generateGMResponse(
      provider,
      context || {},
      userInput,
      apiKey,
      buildAdapterOptions(credentials)
    );

    appendChatMessage(campaignId, { sender: 'GM', text: gmResult.narrative });

    let spawnedTokens = [];
    let pendingSpawns = [];

    if (Array.isArray(gmResult.spawn) && gmResult.spawn.length > 0) {
      if (autoSpawnEntities) {
        spawnedTokens = addSpawnsToCampaign(campaignId, gmResult.spawn);
        spawnedTokens.forEach(token => {
          broadcast('gm:spawn', token);
        });
      } else {
        pendingSpawns = queueSpawnEntries(campaignId, gmResult.spawn);
      }
    }

    return res.json({
      result: gmResult.narrative,
      narrative: gmResult.narrative,
      provider,
      spawn: spawnedTokens,
      pendingSpawns,
      autoSpawnEntities,
      campaign: getCampaignState(campaignId),
    });
  } catch (error) {
    console.error('[GM Respond] Error:', error.message);
    return res.status(500).json({ error: 'server_error', message: error.message });
  }
});

app.get('/api/campaign/state', (req, res) => {
  const campaignId = resolveCampaignId(req.query || {});
  res.json({ campaign: getCampaignState(campaignId) });
});

app.post('/api/gm/settings', (req, res) => {
  const campaignId = resolveCampaignId(req.body?.context || {});
  const enabled = setAutoSpawnEntities(campaignId, req.body?.autoSpawnEntities);
  res.json({
    autoSpawnEntities: enabled,
    campaign: getCampaignState(campaignId),
  });
});

app.post('/api/gm/spawn/approve', (req, res) => {
  const campaignId = resolveCampaignId(req.body?.context || {});
  const { tokens } = approvePendingSpawns(campaignId, req.body?.pendingSpawnIds);

  tokens.forEach(token => {
    broadcast('gm:spawn', token);
  });

  res.json({
    approved: tokens,
    campaign: getCampaignState(campaignId),
  });
});

app.get('/api/realtime/stream', (req, res) => {
  attachRealtimeClient(req, res);
});

/**
 * Health check endpoint
 */
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    realtimeClients: getConnectedClientCount(),
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`NOTDND server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log('BYOK enabled: header-based authentication with env fallback');
});

export default app;
