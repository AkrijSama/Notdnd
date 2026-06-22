import { generateUtility } from "../ai/openrouter.js";
import { getState } from "../db/repository.js";
import { getEntity, upsertEntity } from "./memoryStore.js";
import { getStyleConfig } from "./styleConfig.js";

const responseCounters = new Map();
const exchangeBuffers = new Map();

function dateStamp() {
  return new Date().toISOString().slice(0, 10);
}

function sessionLogName(campaignId) {
  return `Session Log ${campaignId} ${dateStamp()}`;
}

function stripJsonFence(text = "") {
  const trimmed = String(text || "").trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
  if (fenced) {
    return fenced[1].trim();
  }
  return trimmed;
}

function normalizeExtraction(raw = {}) {
  return {
    name: String(raw?.name || "").trim(),
    type: String(raw?.type || "lore").trim(),
    facts: Array.isArray(raw?.facts) ? raw.facts.map((fact) => String(fact || "").trim()).filter(Boolean) : [],
    relations: Array.isArray(raw?.relations)
      ? raw.relations
          .map((relation) => ({
            target: String(relation?.target || "").trim(),
            type: String(relation?.type || "related_to").trim() || "related_to"
          }))
          .filter((relation) => relation.target)
      : []
  };
}

function detectSentiment(text = "") {
  const lower = String(text || "").toLowerCase();
  if (/\b(trust|allied|friend|helped|saved|grateful|bond)\b/.test(lower)) {
    return "positive";
  }
  if (/\b(hostile|hate|threat|betray|suspicious|angry|fear)\b/.test(lower)) {
    return "negative";
  }
  return "neutral";
}

function normalizeName(value = "") {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function uniqStrings(values = []) {
  return [...new Set(values.map((entry) => String(entry || "").trim()).filter(Boolean))];
}

async function appendSessionLog(campaignId, line) {
  const logName = sessionLogName(campaignId);
  const existing = await getEntity(campaignId, logName);
  const logBody = [String(existing?.body || "").trim(), line].filter(Boolean).join("\n");
  await upsertEntity(campaignId, {
    name: logName,
    type: "session_log",
    tags: ["session", "auto-log", dateStamp()],
    body: logBody,
    relations: existing?.relations || []
  });
}

/**
 * Extracts and persists memory updates from GM narrative output.
 * @param {{campaignId: string, narrative: string, playerMessage?: string, playerName?: string, mode?: string}} params
 * @returns {Promise<{updatedEntities: string[], extractedCount: number}>}
 */
export async function runAutoMemoryPipeline({ campaignId, narrative, playerMessage = "", playerName = "", mode = "session" }) {
  const campaignKey = String(campaignId || "unknown-campaign");
  const narrativeText = String(narrative || "").trim();
  if (!narrativeText) {
    return { updatedEntities: [], extractedCount: 0 };
  }

  let styleConfig = null;
  try {
    styleConfig = await getStyleConfig(campaignKey);
  } catch {
    styleConfig = null;
  }

  let extracted = [];
  try {
    const extraction = await generateUtility(
      [
        {
          role: "system",
          content:
            "Extract NEW or CHANGED facts from RPG narrative output. Return strict JSON only. No prose. Return [] if nothing new."
        },
        {
          role: "user",
          content:
            "Extract any NEW or CHANGED facts from this narrative. Return JSON array of entities: [{ name: string, type: npc|location|faction|event|item|lore|quest|relationship, facts: string[], relations: [{ target: string, type: string }] }] Only extract facts that are NEW information not already established. If nothing new, return empty array.\n\n"
            + narrativeText
        }
      ],
      campaignKey
    );

    const parsed = JSON.parse(stripJsonFence(extraction.content));
    if (Array.isArray(parsed)) {
      extracted = parsed.map((entry) => normalizeExtraction(entry)).filter((entry) => entry.name);
    }
  } catch {
    extracted = [];
  }

  const updatedEntities = [];

  for (const item of extracted) {
    const existing = await getEntity(campaignKey, item.name);
    if (existing) {
      const appendedFacts = item.facts.length > 0 ? `\n\n${item.facts.map((fact) => `- ${fact}`).join("\n")}` : "";
      const mergedBody = `${String(existing.body || "").trim()}${appendedFacts}`.trim();
      await upsertEntity(campaignKey, {
        name: existing.name,
        type: item.type || existing.type,
        tags: existing.tags || [],
        body: mergedBody,
        relations: [...(existing.relations || []), ...(item.relations || [])],
        confidence: existing.confidence
      });
      updatedEntities.push(existing.name);
    } else {
      await upsertEntity(campaignKey, {
        name: item.name,
        type: item.type,
        tags: ["auto-extracted", mode],
        body: (item.facts || []).map((fact) => `- ${fact}`).join("\n") || "- Auto-extracted from narrative",
        relations: item.relations || [],
        confidence: 0.8
      });
      updatedEntities.push(item.name);
    }
  }

  if (styleConfig?.memory?.relationshipTracking) {
    const campaignState = getState({});
    const playerNames = uniqStrings([
      ...((campaignState.characters || [])
        .filter((entry) => String(entry?.campaignId || "") === campaignKey)
        .map((entry) => String(entry?.name || ""))),
      playerName
    ]);

    for (const item of extracted) {
      if (item.type !== "npc" || !item.name) {
        continue;
      }

      const factsText = uniqStrings(item.facts || []).join(" ");
      const relationTargets = new Set((item.relations || []).map((rel) => normalizeName(rel.target)));

      for (const targetPlayer of playerNames) {
        if (!targetPlayer) {
          continue;
        }
        const mentionsPlayer = relationTargets.has(normalizeName(targetPlayer))
          || new RegExp(`\\b${targetPlayer.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(factsText)
          || new RegExp(`\\b${targetPlayer.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(narrativeText);

        if (!mentionsPlayer) {
          continue;
        }

        const relationshipName = `${item.name} <-> ${targetPlayer}`;
        const existingRelationship = await getEntity(campaignKey, relationshipName);
        const sentiment = detectSentiment(`${factsText}\n${narrativeText}`);
        const interactionLine = `- ${new Date().toISOString()} (${sentiment}) ${factsText || narrativeText.slice(0, 260)}`;
        const mergedBody = [String(existingRelationship?.body || "").trim(), interactionLine].filter(Boolean).join("\n");

        await upsertEntity(campaignKey, {
          name: relationshipName,
          type: "relationship",
          tags: ["auto-relationship", "relationship-tracking", normalizeName(item.name), normalizeName(targetPlayer)],
          relations: [
            { target: item.name, type: "involves" },
            { target: targetPlayer, type: "involves" }
          ],
          body: mergedBody,
          confidence: 0.85
        });
        updatedEntities.push(relationshipName);
      }
    }
  }

  const now = new Date().toISOString();
  const updateLine = [
    `- ${now} [${mode}]`,
    playerMessage ? `Player: ${playerMessage}` : null,
    `GM: ${narrativeText.slice(0, 800)}`,
    updatedEntities.length ? `Memory updates: ${updatedEntities.join(", ")}` : "Memory updates: none"
  ]
    .filter(Boolean)
    .join("\n");

  await appendSessionLog(campaignKey, `${updateLine}\n`);

  const previousCount = Number(responseCounters.get(campaignKey) || 0);
  const nextCount = previousCount + 1;
  responseCounters.set(campaignKey, nextCount);

  const buffer = exchangeBuffers.get(campaignKey) || [];
  buffer.push({ playerMessage: String(playerMessage || "").trim(), narrative: narrativeText, at: now });
  exchangeBuffers.set(campaignKey, buffer.slice(-10));

  if (nextCount % 10 === 0) {
    const windowLines = (exchangeBuffers.get(campaignKey) || [])
      .slice(-10)
      .map((entry, idx) => `${idx + 1}. Player: ${entry.playerMessage}\nGM: ${entry.narrative}`)
      .join("\n\n");

    let summary = "";
    try {
      const result = await generateUtility(
        [
          {
            role: "system",
            content: "Summarize RPG conversation logs into concise session records."
          },
          {
            role: "user",
            content: `Summarize the last 10 exchanges into a 3-sentence session log entry:\n\n${windowLines}`
          }
        ],
        campaignKey
      );
      summary = String(result.content || "").trim();
    } catch {
      summary = "Summary unavailable for this batch.";
    }

    await appendSessionLog(campaignKey, `- ${new Date().toISOString()} [batch-summary]\n${summary}\n`);
  }

  return {
    updatedEntities: [...new Set(updatedEntities)],
    extractedCount: extracted.length
  };
}
