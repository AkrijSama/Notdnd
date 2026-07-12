// ---------------------------------------------------------------------------
// OOC GROUNDING (owner ruling, Jul 10: ooc-grounding).
//
// The out-of-character channel worked, but the GM answering it was BLIND — the
// OOC call sent only a generic system prompt + the raw question, so the model
// asked the player to re-supply context that was ON SCREEN ("5 minutes to do
// what?" → "please clarify"). This builds a READ-ONLY grounding block from the
// SAME committed, on-screen state a narration turn sees, so the OOC answer is
// specific and never feigns ignorance of the GM's own narration.
//
// buildSoloScenePayload is pure (enqueuers are optional injected callbacks — we
// pass none), so this never mutates state or fires background work.
// ---------------------------------------------------------------------------

import { buildSoloScenePayload } from "../solo/scene.js";
import { buildSystemLoreClause } from "./systemLore.js";

function clamp(value, max) {
  const t = String(value || "").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

// Assembles the grounding context (a plain text block) an OOC answer needs: the
// recent narration verbatim + the committed state the player can see. Pure; a
// failure to build the scene degrades gracefully to whatever is directly on the
// run (never throws — the OOC path must stay non-fatal).
export function buildOocGroundingContext(run) {
  let scene = null;
  try {
    scene = buildSoloScenePayload(run, {});
  } catch {
    scene = null;
  }
  if (scene && scene.ok === false) {
    scene = null;
  }
  const parts = [];

  // 1) RECENT NARRATION verbatim — the prose the player just read (the last
  //    committed GM narration). This is the referent for "what does that mean?"
  //    questions like "5 minutes to do what?".
  const narration = typeof run?.narration === "string" ? run.narration.trim() : "";
  if (narration) {
    parts.push(`RECENT NARRATION (you wrote this — the player just read it, word for word):\n${clamp(narration, 1200)}`);
  }

  // 2) CURRENT LOCATION
  const loc = scene?.location || run?.locations?.[run?.currentLocationId] || null;
  if (loc?.name) {
    parts.push(`LOCATION: ${clamp(loc.name, 80)}${loc.description ? ` — ${clamp(loc.description, 240)}` : ""}`);
  }

  // 3) WORLD CLOCK — the committed time-of-day. There is NO real-time countdown
  //    unless a committed clock event says so (urgency in prose is not a timer).
  const time = run?.world?.time || null;
  if (time?.clock) {
    parts.push(`WORLD CLOCK: ${time.clock}${time.phase ? ` (${time.phase})` : ""}. No real-time countdown runs unless a committed clock event says so.`);
  }

  // 4) ACTIVE CONDITIONS
  const conds = Array.isArray(scene?.player?.conditions) ? scene.player.conditions.filter(Boolean) : [];
  if (conds.length) {
    parts.push(`ACTIVE CONDITIONS: ${conds.map((c) => c.name || c.id).filter(Boolean).join(", ")}`);
  }

  // 5) COMMITTED OBJECTIVES (the main quest + active quests)
  const quests = scene?.quests || {};
  const objLines = [];
  if (quests.mainQuest?.title) {
    objLines.push(`MAIN — ${clamp(quests.mainQuest.title, 100)}${quests.mainQuest.objective ? `: ${clamp(quests.mainQuest.objective, 140)}` : ""}`);
  }
  for (const q of Array.isArray(quests.activeQuests) ? quests.activeQuests : []) {
    const stageObj = Array.isArray(q.stages) && q.stages[0]?.objective ? `: ${clamp(q.stages[0].objective, 140)}` : "";
    objLines.push(`${clamp(q.title || "quest", 100)}${stageObj}`);
  }
  if (objLines.length) {
    parts.push(`COMMITTED OBJECTIVES:\n- ${objLines.join("\n- ")}`);
  }

  // 6) THE WORLD'S MOST RECENT COMMITTED DEVELOPMENT + the decision it poses —
  //    the real referent when the player asks "what am I deciding?".
  const dev = scene?.recentDevelopment || null;
  if (dev && (dev.title || dev.brief)) {
    parts.push(
      `RECENT DEVELOPMENT (committed, real in the world): ${clamp(dev.title, 80)} — ${clamp(dev.brief, 220)}` +
        (dev.decision ? ` The choice in front of the player: ${clamp(dev.decision, 220)}` : "")
    );
  }

  // 7) KNOWN THREADS (non-hidden only — a hidden thread never leaves the server).
  //    The committed answer to "what should I be worried about": the title, plus the
  //    agenda once revealed, plus a known deadline. A hidden thread is absent.
  const threads = (Array.isArray(scene?.threads) ? scene.threads : []).filter((t) => t && t.revealState !== "hidden" && t.title);
  if (threads.length) {
    const lines = threads.map((t) => {
      const agenda = t.revealState === "revealed" && typeof t.agenda === "string" && t.agenda ? ` — ${clamp(t.agenda, 160)}` : "";
      const dl = t.deadline && Number.isFinite(t.deadline.inMinutes) ? ` (comes due in ~${t.deadline.inMinutes} min of world time)` : "";
      return `${clamp(t.title, 60)}${agenda}${dl}`;
    });
    parts.push(`ONGOING THREADS (committed — the real answer to "what should I be worried about"):\n- ${lines.join("\n- ")}`);
  }

  // 7b) STANDINGS (reputation-engine-v1) — the committed answer to "where do I stand
  //     with X". Met individuals' disposition tier + discovered factions' standing
  //     tier, from real numbers. Hidden standings never appear (visibility law).
  const rep = scene && typeof scene.reputation === "object" && scene.reputation ? scene.reputation : null;
  const repLines = [];
  for (const ind of Array.isArray(rep?.individuals) ? rep.individuals : []) {
    if (!ind?.name || !ind.tier) continue;
    const romance = ind.romanceTier ? `, romance: ${ind.romanceTier}` : "";
    repLines.push(`${clamp(ind.name, 40)} — ${ind.tier} (${ind.affinity >= 0 ? "+" : ""}${ind.affinity}${romance})`);
  }
  for (const f of Array.isArray(rep?.factions) ? rep.factions : []) {
    if (!f?.name || !f.tier) continue;
    repLines.push(`${clamp(f.name, 40)} [faction] — ${f.tier} (${f.standing >= 0 ? "+" : ""}${f.standing})`);
  }
  if (repLines.length) {
    parts.push(`STANDINGS (committed — the real answer to "where do I stand with X"):\n- ${repLines.join("\n- ")}`);
  }

  // 8) PRESENT NPCS
  const cast = (Array.isArray(scene?.cast) ? scene.cast : []).filter((c) => c && c.present !== false && (c.displayName || c.name));
  if (cast.length) {
    parts.push(`PRESENT NPCS: ${cast.map((c) => clamp(c.displayName || c.name, 40)).join(", ")}`);
  }

  // 9) SYSTEM LORE (WINDOW/VOICE world-law) so an OOC answer about them is exact.
  parts.push(buildSystemLoreClause().trim());

  return parts.join("\n\n");
}

// The OOC framing that rides ON TOP of the grounding block — direct, specific,
// grounded, and stripped of the assistant register that produced the blind
// "please clarify" reply.
export const OOC_FRAMING =
  "The player is asking OUT OF CHARACTER. Answer from the committed state and recent narration ABOVE — you wrote it; never ask the player to provide context that appears there. " +
  "Be direct and specific (2-4 sentences). " +
  "When the player asks what a stake, deadline, or piece of narration means, NAME the committed decision it bears on (from RECENT DEVELOPMENT or COMMITTED OBJECTIVES) and its stakes — do not just restate the phrase. " +
  "If the true answer is a secret the player has not discovered, say what IS known and that the rest is undiscovered — never feign ignorance of your own narration. " +
  "Do NOT narrate story events, advance the fiction, change any state, speak as an in-world character, or open with quotation marks. " +
  "No assistant register: no \"let me know\", no \"please clarify\", no offering menus of possibilities for things the committed state already answers.";

// The full OOC system prompt: grounding block, then the framing.
export function buildOocSystemPrompt(run) {
  const grounding = buildOocGroundingContext(run);
  return `${grounding}\n\n${OOC_FRAMING}`;
}
