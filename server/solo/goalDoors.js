// GOALS AS THREAD SOURCES + THE TWO DOORS (B2). Closes the ledgered gap: a Project or
// Ambition, once committed, REGISTERS as a D.5 thread source so the world reacts to it
// (Projects fire beats — someone notices, a cost arrives; Ambitions carry arc pressure
// — a rival stirs, the price of scale comes due). Plus the two goal-creation doors:
//   • DEMONSTRATED — 3+ same-pattern committed actions → ONE diegetic ask → confirm.
//   • OFFERED — an NPC/world proposal commits as an offered goal the player accepts.
// goals.js stays the record owner (commitGoal); this module owns the thread bridge and
// the two doors, so the threads coupling lives in exactly one place.
import { loadThreadsFromJson } from "./threads.js";
import { commitGoal, contentTokens, goalMatchesIntent, inferGoalScale, activeGoals } from "./goals.js";

function isPlainObject(v) { return Boolean(v) && typeof v === "object" && !Array.isArray(v); }
function isString(v) { return typeof v === "string" && v.trim().length > 0; }

// Law-6 (owner-tunable): goal-thread deadlines in world-clock minutes. A Project's
// cost lands within a few days; an Ambition's price is a longer but REACHABLE arc.
// The old ambition deadline (+100000 ≈ 69 in-world days) never fired, so the price
// never landed. The prescriptive minTurn gates drive the beats; the deadline is the
// backstop that guarantees the arc resolves rather than dangling forever.
const GOAL_DEADLINE_MINUTES = Object.freeze({ project: 4320, ambition: 10080 }); // 3 days / 7 days

// The faction most RELEVANT to a goal (token overlap with name/wants), else a
// discovered faction, else the first. Null when the run carries no factions — so a
// factionless run simply skips the reputation effect rather than targeting nothing.
function relevantFactionId(run, tokens) {
  const factions = isPlainObject(run?.factions) ? Object.values(run.factions) : [];
  if (!factions.length) return null;
  const toks = (Array.isArray(tokens) ? tokens : []).map((t) => String(t).toLowerCase()).filter(Boolean);
  let best = null; let bestScore = 0;
  for (const f of factions) {
    const hay = `${f.name || ""} ${f.wants || ""}`.toLowerCase();
    const score = toks.reduce((s, t) => s + (hay.includes(t) ? 1 : 0), 0);
    if (score > bestScore) { bestScore = score; best = f; }
  }
  const chosen = best || factions.find((f) => f.discovered) || factions[0];
  return chosen?.factionId || null;
}

// ── THREAD-SOURCE REGISTRATION ─────────────────────────────────────────────────
// Build a `player_goal` front for a Project/Ambition and load it through the validated
// thread bridge (loadThreadsFromJson). Grounded in the run's current location so the
// referential-closure check passes. Cross-links goal.flags.threadId. Idempotent.
export function registerGoalThread(run, goal, { nowMinutes } = {}) {
  if (!isPlainObject(goal) || (goal.scale !== "project" && goal.scale !== "ambition")) return null;
  const threadId = `thread_goal_${goal.goalId}`;
  if (run?.threads && run.threads[threadId]) return threadId; // already registered
  const loc = run?.currentLocationId;
  if (!isString(loc)) return null;
  const summary = String(goal.summary || "your goal").slice(0, 100);
  const tokens = Array.isArray(goal.matchTokens) && goal.matchTokens.length ? goal.matchTokens.slice(0, 4) : contentTokens(summary).slice(0, 4);
  const front = goal.scale === "project"
    ? projectFront(threadId, summary, tokens, loc, run, nowMinutes)
    : ambitionFront(threadId, summary, tokens, loc, run, nowMinutes);
  const res = loadThreadsFromJson(run, [front], {});
  if (res.loaded && res.loaded.length) {
    goal.flags = isPlainObject(goal.flags) ? goal.flags : {};
    goal.flags.threadId = threadId;
    return threadId;
  }
  return null;
}

// PROJECT → a beat-bearing opportunity: someone notices (a committed NPC), then a
// cost arrives (a committed object-state), and pursuing it shifts a faction's regard.
// Structural mutations, not narrated sentences — the world actually reorganizes.
function projectFront(threadId, summary, tokens, loc, run, nowMinutes) {
  const now = Number.isFinite(nowMinutes) ? nowMinutes : (Number(run?.world?.time?.minutes) || 0);
  const factionId = relevantFactionId(run, tokens);
  return {
    frontId: threadId,
    kind: "opportunity",
    origin: "player_goal",
    topology: "linear",
    title: `Project: ${summary}`.slice(0, 80),
    agenda: `The world reacts to the player pursuing: ${summary}.`.slice(0, 200),
    revealState: "revealed", // the player set this goal — it is known
    groundedIn: { locationRefs: [loc] },
    clock: { minTurnsBetweenBeats: 2, expiresAtMinutes: now + GOAL_DEADLINE_MINUTES.project },
    ...(factionId ? { reputationEffects: [{ target: factionId, delta: 2, tags: ["player_goal", "project"] }] } : {}),
    beats: [
      {
        beatId: `${threadId}_b1`, label: "someone notices", telegraph: "Word of what you're building gets around.",
        brief: `Someone has noticed you are working toward ${summary} — and it interests them.`.slice(0, 280),
        decision: "Lean into the attention, or keep the work quiet.",
        trigger: { descriptive: { onCanon: { keywords: tokens.length ? tokens : ["work", "build", "pursue"] } } },
        // STRUCTURAL: the interested party commits as a real NPC the player can meet.
        payload: {
          fact: { text: `Word spreads that you are pursuing ${summary}.`.slice(0, 280) },
          npc: { npcId: `${threadId}_ally`, displayName: "an interested party", role: "interested" }
        }
      },
      {
        beatId: `${threadId}_b2`, label: "a cost arrives", telegraph: "Ambition draws its price.",
        brief: `Pursuing ${summary} has drawn a real cost — a rival, a debt, or a demand.`.slice(0, 280),
        decision: "Pay the cost and press on, or trim your ambition.",
        trigger: { prescriptive: { requiresBeat: `${threadId}_b1`, minTurn: 6 } },
        // STRUCTURAL: the cost commits as a real object-state obstacle at the location.
        payload: {
          fact: { text: `The cost of pursuing ${summary} comes due.`.slice(0, 280) },
          objectState: { key: `${threadId}_cost`, state: "demanded", reason: `A cost has come due for ${summary}.`.slice(0, 200) }
        }
      }
    ],
    resolution: [{ kind: "beat_final" }]
  };
}

// AMBITION → arc pressure on a REACHABLE clock: a rival stirs (as a committed NPC —
// not a sentence), then the price of scale (a committed object-state), and the whole
// arc shifts the relevant faction against you on resolution.
function ambitionFront(threadId, summary, tokens, loc, run, nowMinutes) {
  const now = Number.isFinite(nowMinutes) ? nowMinutes : (Number(run?.world?.time?.minutes) || 0);
  const factionId = relevantFactionId(run, tokens);
  return {
    frontId: threadId,
    kind: "rival",
    origin: "player_goal",
    topology: "linear",
    title: `Ambition: ${summary}`.slice(0, 80),
    agenda: `A great ambition draws great pressure: ${summary}.`.slice(0, 200),
    revealState: "revealed",
    groundedIn: { locationRefs: [loc] },
    // Law-6 REACHABLE deadline (was +100000 ≈ 69 days, which never fired).
    clock: { minTurnsBetweenBeats: 4, expiresAtMinutes: now + GOAL_DEADLINE_MINUTES.ambition },
    ...(factionId ? { reputationEffects: [{ target: factionId, delta: -3, tags: ["player_goal", "ambition"] }] } : {}),
    beats: [
      {
        beatId: `${threadId}_b1`, label: "a rival stirs", telegraph: "An ambition this large does not go unanswered.",
        brief: `Your ambition — ${summary} — has drawn a rival who wants the same thing, or wants you to fail.`.slice(0, 280),
        decision: "Move against the rival, or race them to it.",
        trigger: { descriptive: { onCanon: { keywords: tokens.length ? tokens : ["ambition", "claim", "rise"] } }, prescriptive: { minTurn: 5 } },
        // STRUCTURAL: the rival commits as a real NPC the player can actually confront.
        payload: {
          fact: { text: `A rival rises against your ambition to ${summary}.`.slice(0, 280) },
          npc: { npcId: `${threadId}_rival`, displayName: "a rival", role: "rival" }
        }
      },
      {
        beatId: `${threadId}_b2`, label: "the price of scale", telegraph: "The world tilts against those who reach too high.",
        brief: `Reaching for ${summary} costs more than you planned — the arc demands a sacrifice.`.slice(0, 280),
        decision: "Pay the price to keep the ambition alive, or let it shrink.",
        trigger: { prescriptive: { requiresBeat: `${threadId}_b1`, minTurn: 12 } },
        // STRUCTURAL: the price commits as a real object-state at the location.
        payload: {
          fact: { text: `The ambition to ${summary} demands its price.`.slice(0, 280) },
          objectState: { key: `${threadId}_price`, state: "exacted", reason: `The price of ${summary} came due.`.slice(0, 200) }
        }
      }
    ],
    resolution: [{ kind: "beat_final", outcome: "resolved" }]
  };
}

// ── DEMONSTRATED DOOR ──────────────────────────────────────────────────────────
// Scan the recent committed-attempt timeline for a repeated pattern: a meaningful
// token appearing across 3+ of the last N distinct intents. Returns a proposal (with
// a diegetic ASK, VOICE-flavored in Babel, neutral elsewhere), or null. Does NOT
// commit — the player confirms first. Guards: no re-ask for an already-asked pattern,
// and skips a pattern already covered by an active goal.
export function detectDemonstratedGoal(run, { minCount = 3, window = 8 } = {}) {
  const attempts = (Array.isArray(run?.timeline) ? run.timeline : []).filter((e) => e?.type === "attempt" && isString(e?.payload?.intent));
  if (attempts.length < minCount) return null;
  const recent = attempts.slice(-window);
  const perIntent = recent.map((e) => ({ intent: e.payload.intent, tokens: new Set(contentTokens(e.payload.intent)) }));
  const freq = new Map();
  for (const it of perIntent) for (const t of it.tokens) freq.set(t, (freq.get(t) || 0) + 1);
  let best = null, bestCount = 0;
  for (const [t, c] of freq) if (c > bestCount || (c === bestCount && best && t.length > best.length)) { best = t; bestCount = c; }
  if (!best || bestCount < minCount) return null;
  if (activeGoals(run).some((g) => (Array.isArray(g.matchTokens) && g.matchTokens.includes(best)) || goalMatchesIntent(g, best))) return null;
  if (run?.flags?.demonstratedGoalAsked === best) return null; // asked already
  const exemplar = perIntent.find((it) => it.tokens.has(best))?.intent || best;
  const summary = exemplar.replace(/^\s*i\s+(?:want to|will|keep|try to|am trying to|need to|'?m going to|'?m gonna|intend to|plan to)\s+/i, "").trim() || best;
  const scale = inferGoalScale(exemplar);
  const babel = String(run?.world?.variant || "").toLowerCase() === "babel";
  const ask = babel
    ? `[ YOU RETURN TO THIS, AGAIN AND AGAIN. IS THIS YOUR PURPOSE HERE — TO ${best.toUpperCase()}? ]`
    : `You keep coming back to this. Is it becoming your purpose — to ${best}?`;
  return { token: best, count: bestCount, summary, scale, exemplar, ask };
}

// Note the ask so it surfaces once and never re-fires for the same pattern.
export function armDemonstratedAsk(run, proposal) {
  if (!isPlainObject(run) || !proposal) return;
  run.flags = isPlainObject(run.flags) ? run.flags : {};
  run.flags.demonstratedGoalAsked = proposal.token;
  run.flags.demonstratedGoalPrompt = { token: proposal.token, summary: proposal.summary, scale: proposal.scale, ask: proposal.ask };
}

const AFFIRM_RE = /\b(yes|yeah|yep|aye|indeed|it is|that'?s (?:right|it)|confirm|agreed?|do it|make it so|i (?:will|do)|sure)\b/i;
const DECLINE_RE = /\b(no|nope|nah|not (?:really|yet)|never mind|forget it|decline|leave it|drop it)\b/i;

// The player's answer to a pending demonstrated ask. Returns "confirm" | "decline" | null.
export function detectDemonstratedAnswer(run, intent) {
  if (!isPlainObject(run?.flags?.demonstratedGoalPrompt) || !isString(intent)) return null;
  if (DECLINE_RE.test(intent)) return "decline";
  if (AFFIRM_RE.test(intent)) return "confirm";
  return null;
}

// Commit the pending demonstrated goal (on a confirm) + register its thread. Clears the
// prompt. Returns the goal, or null. On a decline, callers just clearDemonstratedPrompt.
export function captureDemonstratedGoal(run, { nowMinutes = 0, turn = 0 } = {}) {
  const prompt = run?.flags?.demonstratedGoalPrompt;
  if (!isPlainObject(prompt)) return null;
  const goal = commitGoal(run, {
    summary: prompt.summary, scale: prompt.scale, matchTokens: [prompt.token],
    door: "demonstrated", provenance: `demonstrated: repeated "${prompt.token}"`
  }, { nowMinutes, turn });
  clearDemonstratedPrompt(run);
  if (goal) registerGoalThread(run, goal, { nowMinutes });
  return goal;
}
export function clearDemonstratedPrompt(run) {
  if (isPlainObject(run?.flags)) delete run.flags.demonstratedGoalPrompt;
}

// The pending demonstrated ASK, folded into the narrator prompt so the GM poses it
// diegetically this turn (the player's next confirm/decline resolves it). "" when none.
export function buildDemonstratedAskDirective(run) {
  const prompt = run?.flags?.demonstratedGoalPrompt;
  if (!isPlainObject(prompt) || !isString(prompt.ask)) return "";
  return ` The player keeps circling one purpose. Voice this question to them, in-fiction, and let them answer: ${prompt.ask}`;
}

// ── OFFERED DOOR ───────────────────────────────────────────────────────────────
// Mirrors the questOffer accept flow. An NPC/world proposal rides an NPC as
// `npc.goalOffer = { goal:{summary,scale,matchTokens?,stakes?}, offerText, accepted }`
// (free-form NPC field, no schema work). A present, un-accepted offer + an affirmative
// commits the goal (door:"offered") and registers its Project/Ambition thread.
export function getGoalOfferingNpcs(run) {
  const here = run?.currentLocationId;
  return Object.values(run?.npcs || {}).filter(
    (npc) => isPlainObject(npc) && npc.currentLocationId === here && npc.status !== "gone" && npc.status !== "dead"
      && isPlainObject(npc.goalOffer) && npc.goalOffer.accepted !== true && isPlainObject(npc.goalOffer.goal)
  );
}

export function detectGoalAcceptIntent(run, intent) {
  const offerers = getGoalOfferingNpcs(run);
  if (!offerers.length || !isString(intent)) return null;
  // A bare affirmative is trusted ONLY because an offer is pending (the questFlow gate).
  if (!AFFIRM_RE.test(intent)) return null;
  return { npcId: offerers[0].npcId };
}

export function captureOfferedGoal(run, npcId, { nowMinutes = 0, turn = 0 } = {}) {
  const npc = run?.npcs?.[npcId];
  const offer = npc?.goalOffer;
  if (!isPlainObject(offer) || offer.accepted === true || !isPlainObject(offer.goal)) return null;
  const g = offer.goal;
  const scale = g.scale && ["task", "project", "ambition"].includes(g.scale) ? g.scale : inferGoalScale(String(g.summary || ""));
  const goal = commitGoal(run, {
    summary: g.summary, scale, matchTokens: Array.isArray(g.matchTokens) ? g.matchTokens : contentTokens(g.summary),
    door: "offered", provenance: `offered by ${npc.displayName || npcId}`, stakes: g.stakes
  }, { nowMinutes, turn });
  if (!goal) return null;
  npc.goalOffer = { ...offer, accepted: true };
  registerGoalThread(run, goal, { nowMinutes });
  return goal;
}
