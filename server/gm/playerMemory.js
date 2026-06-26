import { generateUtility } from "../ai/openrouter.js";
import { getEntity, upsertEntity } from "./memoryStore.js";

const interactionCounters = new Map();
const exchangeBuffers = new Map();

function profileFileName(playerName) {
  const slug = String(playerName || "player")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80) || "player";
  return `player_${slug}.md`;
}

function profileEntityName(playerName) {
  return `Player Profile: ${String(playerName || "Unknown Player").trim() || "Unknown Player"}`;
}

function profileKey(campaignId, playerName) {
  return `${String(campaignId || "")}::${String(playerName || "").trim().toLowerCase()}`;
}

function extractJsonObject(rawText = "") {
  const source = String(rawText || "").trim();
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : source;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    return candidate.slice(start, end + 1);
  }
  return candidate;
}

function parseAnalysis(rawText = "") {
  try {
    const parsed = JSON.parse(extractJsonObject(rawText));
    return {
      preferred_play_style: String(parsed?.preferred_play_style || "mixed").trim() || "mixed",
      decision_tendency: String(parsed?.decision_tendency || "cautious").trim() || "cautious",
      interests: Array.isArray(parsed?.interests)
        ? [...new Set(parsed.interests.map((entry) => String(entry || "").trim()).filter(Boolean))]
        : [],
      emotional_engagement: Array.isArray(parsed?.emotional_engagement)
        ? [...new Set(parsed.emotional_engagement.map((entry) => String(entry || "").trim()).filter(Boolean))]
        : []
    };
  } catch {
    return {
      preferred_play_style: "mixed",
      decision_tendency: "cautious",
      interests: [],
      emotional_engagement: []
    };
  }
}

function parseStoredProfile(body = "") {
  const match = String(body || "").match(/```json\s*([\s\S]*?)```/i);
  if (!match) {
    return null;
  }
  try {
    const parsed = JSON.parse(match[1].trim());
    return {
      preferred_play_style: String(parsed?.preferred_play_style || "mixed"),
      decision_tendency: String(parsed?.decision_tendency || "cautious"),
      interests: Array.isArray(parsed?.interests) ? parsed.interests.map((entry) => String(entry || "")) : [],
      emotional_engagement: Array.isArray(parsed?.emotional_engagement)
        ? parsed.emotional_engagement.map((entry) => String(entry || ""))
        : []
    };
  } catch {
    return null;
  }
}

function mergeAnalysis(existing = null, next = null) {
  if (!next) {
    return existing || null;
  }
  if (!existing) {
    return next;
  }
  return {
    preferred_play_style: next.preferred_play_style || existing.preferred_play_style || "mixed",
    decision_tendency: next.decision_tendency || existing.decision_tendency || "cautious",
    interests: [...new Set([...(existing.interests || []), ...(next.interests || [])])].slice(0, 20),
    emotional_engagement: [...new Set([...(existing.emotional_engagement || []), ...(next.emotional_engagement || [])])].slice(0, 20)
  };
}

function buildProfileBody(playerName, merged, exchanges = []) {
  const interestLine = merged?.interests?.length ? merged.interests.join(", ") : "none observed yet";
  const engagementLine = merged?.emotional_engagement?.length
    ? merged.emotional_engagement.join("; ")
    : "no strong emotional signals yet";

  const recent = exchanges
    .slice(-5)
    .map((entry, idx) => `${idx + 1}. Player: ${entry.playerMessage}\n   GM: ${entry.gmResponse}`)
    .join("\n\n");

  return [
    `# Player Profile: ${playerName}`,
    "",
    `Preferred play style: ${merged?.preferred_play_style || "mixed"}`,
    `Decision tendency: ${merged?.decision_tendency || "cautious"}`,
    `Interests: ${interestLine}`,
    `Emotional engagement: ${engagementLine}`,
    "",
    "Recent exchange sample:",
    recent || "- No exchange sample captured yet.",
    "",
    "Structured Analysis:",
    "```json",
    JSON.stringify(
      {
        preferred_play_style: merged?.preferred_play_style || "mixed",
        decision_tendency: merged?.decision_tendency || "cautious",
        interests: merged?.interests || [],
        emotional_engagement: merged?.emotional_engagement || []
      },
      null,
      2
    ),
    "```",
    ""
  ].join("\n");
}

/**
 * Updates a player's profile memory entity using batched interaction analysis.
 * @param {string} campaignId
 * @param {string} playerName
 * @param {string} gmResponse
 * @param {string} playerMessage
 * @returns {Promise<{updated: boolean, analysis: object | null, entityName: string | null}>}
 */
export async function updatePlayerProfile(campaignId, playerName, gmResponse, playerMessage) {
  const campaignKey = String(campaignId || "").trim();
  const name = String(playerName || "").trim();
  if (!campaignKey || !name) {
    return { updated: false, analysis: null, entityName: null };
  }

  const key = profileKey(campaignKey, name);
  const nextCount = Number(interactionCounters.get(key) || 0) + 1;
  interactionCounters.set(key, nextCount);

  const exchange = {
    playerMessage: String(playerMessage || "").trim(),
    gmResponse: String(gmResponse || "").trim(),
    at: new Date().toISOString()
  };
  const buffer = exchangeBuffers.get(key) || [];
  buffer.push(exchange);
  exchangeBuffers.set(key, buffer.slice(-20));

  if (nextCount % 5 !== 0) {
    return { updated: false, analysis: null, entityName: null };
  }

  const sampled = (exchangeBuffers.get(key) || []).slice(-10);
  const transcript = sampled
    .map((entry, idx) => `${idx + 1}. Player: ${entry.playerMessage}\nGM: ${entry.gmResponse}`)
    .join("\n\n");

  const analysisResponse = await generateUtility(
    [
      {
        role: "system",
        content: "Analyze RPG player behavior and return strict JSON. No prose."
      },
      {
        role: "user",
        content:
          "Analyze this player's recent messages and the GM's responses. Extract:\n"
          + "- preferred_play_style: combat | social | exploration | puzzle | mixed\n"
          + "- decision_tendency: aggressive | diplomatic | cautious | chaotic\n"
          + "- interests: [list of topics/themes they gravitate toward]\n"
          + "- emotional_engagement: [moments where they seemed most engaged]\n"
          + "Return as JSON.\n\n"
          + transcript
      }
    ],
    campaignKey
  );

  const nextAnalysis = parseAnalysis(analysisResponse.content);
  const existing = await getEntity(campaignKey, profileFileName(name));
  const merged = mergeAnalysis(parseStoredProfile(existing?.body || ""), nextAnalysis);
  const body = buildProfileBody(name, merged, sampled);

  const saved = await upsertEntity(campaignKey, {
    name: profileEntityName(name),
    fileName: profileFileName(name),
    type: "player_character",
    tags: ["player-profile", name.toLowerCase().replace(/\s+/g, "-")],
    body,
    relations: [{ target: name, type: "profile_for" }]
  });

  return {
    updated: true,
    analysis: merged,
    entityName: saved?.name || null
  };
}

/**
 * Returns condensed player profile context for prompt injection.
 * @param {string} campaignId
 * @param {string} playerName
 * @returns {Promise<string>}
 */
export async function getPlayerContext(campaignId, playerName) {
  const campaignKey = String(campaignId || "").trim();
  const name = String(playerName || "").trim();
  if (!campaignKey || !name) {
    return "";
  }

  const entity = await getEntity(campaignKey, profileFileName(name));
  if (!entity) {
    return `PLAYER PROFILE for ${name}: No prior profile yet. Learn this player's preferences from their actions this session.`;
  }

  const parsed = parseStoredProfile(entity.body || "") || {
    preferred_play_style: "mixed",
    decision_tendency: "cautious",
    interests: [],
    emotional_engagement: []
  };

  const interests = parsed.interests.length > 0 ? parsed.interests.join(", ") : "unknown";
  const engagement = parsed.emotional_engagement.length > 0 ? parsed.emotional_engagement.join("; ") : "unknown";

  return `PLAYER PROFILE for ${name}: Play style: ${parsed.preferred_play_style}. Tends toward ${parsed.decision_tendency}. Interested in: ${interests}. Engages most with: ${engagement}. Tailor your narration to create moments this player will find compelling.`;
}
