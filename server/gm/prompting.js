/**
 * AI Adapter Layer for NOTDND
 * Handles interactions with various AI providers
 */
import { generateAIContent } from '../ai/adapters.js';

const JSON_STRUCTURED_PROVIDERS = new Set(['openai', 'grok', 'gemini', 'openrouter']);
const SPAWN_CONTEXT_PATTERN = /\b(attack|ambush|battle|combat|enemy|encounter|fight|goblin|monster|orc|skeleton|bandit|initiative|dungeon|room|hall|chamber|corridor|appears|introduce|stranger|guard|merchant|villain|boss)\b/i;

/**
 * Local AI (mock implementation)
 */
async function callLocal(prompt) {
  const preview = prompt.replace(/\s+/g, ' ').trim().substring(0, 80);
  return `[Local AI Response to: ${preview}...]`;
}

function providerSupportsStructuredJson(provider) {
  return JSON_STRUCTURED_PROVIDERS.has(String(provider || '').toLowerCase());
}

function shouldRequestSpawnData(context = {}, userInput = '') {
  const combinedContext = `${JSON.stringify(context)} ${userInput}`;
  return SPAWN_CONTEXT_PATTERN.test(combinedContext);
}

function buildJsonSpawnInstruction() {
  return `
Return only valid JSON with this exact shape:
{
  "narrative": "string",
  "spawn": [
    {
      "type": "npc" | "monster",
      "name": "string",
      "hp": number,
      "ac": number,
      "stats": { "str": 0, "dex": 0, "con": 0, "int": 0, "wis": 0, "cha": 0 },
      "actions": ["string"],
      "disposition": "hostile" | "neutral" | "friendly",
      "tokenColor": "#RRGGBB"
    }
  ]
}
If no entity should appear, return an empty spawn array.
Do not wrap the JSON in markdown fences.
`;
}

function buildXmlSpawnInstruction() {
  return `
Return the narrative as plain text.
If the scene introduces any NPC or monster that should enter play, append a single XML block after the narrative:
<spawn>[{"type":"npc","name":"string","hp":1,"ac":1,"stats":{"str":0,"dex":0,"con":0,"int":0,"wis":0,"cha":0},"actions":["string"],"disposition":"neutral","tokenColor":"#RRGGBB"}]</spawn>
If no entity should appear, omit the <spawn> block entirely.
Do not wrap the response in markdown fences.
`;
}

function buildGMPrompt(provider, context, userInput, requestStructuredOutput) {
  const basePrompt = `
Game Master Context: ${JSON.stringify(context)}

Player Input: ${userInput}

Respond as the Game Master, narrating what happens next in the story.
`;

  if (!requestStructuredOutput) {
    return basePrompt;
  }

  return `${basePrompt}

The scene may require introducing NPCs or monsters onto the map. When that happens, include structured spawn data.
${providerSupportsStructuredJson(provider) ? buildJsonSpawnInstruction() : buildXmlSpawnInstruction()}
`;
}

function parseJsonObject(rawResponse) {
  const trimmed = String(rawResponse || '').trim();
  if (!trimmed) {
    return null;
  }

  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fencedMatch ? fencedMatch[1].trim() : trimmed;

  try {
    return JSON.parse(candidate);
  } catch (error) {
    const objectStart = candidate.indexOf('{');
    const objectEnd = candidate.lastIndexOf('}');

    if (objectStart >= 0 && objectEnd > objectStart) {
      try {
        return JSON.parse(candidate.slice(objectStart, objectEnd + 1));
      } catch (nestedError) {
        return null;
      }
    }

    return null;
  }
}

function sanitizeParsedSpawn(spawn) {
  return Array.isArray(spawn) ? spawn.filter(entry => entry && typeof entry === 'object') : [];
}

export function extractStructuredGMResponse(provider, rawResponse) {
  if (providerSupportsStructuredJson(provider)) {
    const parsed = parseJsonObject(rawResponse);

    if (parsed && typeof parsed.narrative === 'string') {
      return {
        narrative: parsed.narrative.trim(),
        spawn: sanitizeParsedSpawn(parsed.spawn),
        format: 'json',
      };
    }

    return {
      narrative: String(rawResponse || '').trim(),
      spawn: [],
      format: 'plain',
    };
  }

  const responseText = String(rawResponse || '');
  const spawnMatch = responseText.match(/<spawn>([\s\S]*?)<\/spawn>/i);
  const narrative = responseText.replace(/<spawn>[\s\S]*?<\/spawn>/gi, '').trim();

  if (!spawnMatch) {
    return {
      narrative,
      spawn: [],
      format: 'plain',
    };
  }

  let parsedSpawn = [];
  try {
    const parsedXmlPayload = JSON.parse(spawnMatch[1].trim());
    parsedSpawn = Array.isArray(parsedXmlPayload)
      ? parsedXmlPayload
      : sanitizeParsedSpawn(parsedXmlPayload?.spawn);
  } catch (error) {
    parsedSpawn = [];
  }

  return {
    narrative,
    spawn: sanitizeParsedSpawn(parsedSpawn),
    format: 'xml',
  };
}

/**
 * Generate AI response using specified provider
 * @param {string} provider - AI provider (openai, grok, gemini, local)
 * @param {string} prompt - The prompt to send
 * @param {string} apiKey - API key (optional for local, required for others)
 * @param {object} options - Adapter-specific options
 */
export async function generateAIResponse(provider, prompt, apiKey, options = {}) {
  const normalizedProvider = provider.toLowerCase();

  if (normalizedProvider === 'local' && !options.localEndpoint && !process.env.LOCAL_AI_ENDPOINT) {
    return callLocal(prompt);
  }

  if (normalizedProvider !== 'local' && !apiKey) {
    throw new Error(`${provider} API key required`);
  }

  const response = await generateAIContent(normalizedProvider, prompt, apiKey, options);
  return response.content;
}

/**
 * Generate GM response for game context
 * @param {string} provider - AI provider
 * @param {object} context - Game context
 * @param {string} userInput - User's input
 * @param {string} apiKey - API key
 * @param {object} options - Adapter-specific options
 */
export async function generateGMResponse(provider, context, userInput, apiKey, options = {}) {
  const requestStructuredOutput = shouldRequestSpawnData(context, userInput);
  const prompt = buildGMPrompt(provider, context, userInput, requestStructuredOutput);
  const rawResponse = await generateAIResponse(provider, prompt, apiKey, options);

  if (!requestStructuredOutput) {
    return {
      narrative: rawResponse,
      spawn: [],
      rawResponse,
      structuredOutputRequested: false,
      format: 'plain',
    };
  }

  const parsed = extractStructuredGMResponse(provider, rawResponse);

  return {
    narrative: parsed.narrative || rawResponse,
    spawn: parsed.spawn,
    rawResponse,
    structuredOutputRequested: true,
    format: parsed.format,
  };
}
