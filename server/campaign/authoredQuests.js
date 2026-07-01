// Authored campaign quest content that EXERCISES the check-gated, failable quest
// primitive (server/solo/quests.js — completion.kind "check" + stage.failOnMiss).
//
// Why this exists: the procedural main-quest arc (createMainQuest) only ever emits
// reach_location / talk_beat stages, so — although the engine has supported
// check/failOnMiss for a while and it is unit-proven (tests/solo-lethality.test.js)
// — NO real run ever created a quest stage that gates on a d20 and LOSES the quest
// on a miss. That left the one place the consequence/lethality doctrine ("a botched
// check can end the line") was not provable end-to-end in content. This seeds a
// real, LOSABLE side-quest into CAMPAIGN runs (never sandbox — sandbox carries no
// authored quests, per doctrine) so the primitive is exercised by an actual run.
//
// The trial is a two-stage arc:
//   Stage 0 — reach the second location (a grounded setup so the decisive check
//             isn't triggered by an unrelated turn-1 attempt).
//   Stage 1 — a CHECK stage with failOnMiss: the player's next contested attempt
//             at that place is the decisive roll. Pass -> the trial is completed;
//             MISS -> the quest is FAILED (status "failed"), irrecoverably. It is
//             isMain:false, so losing/completing it does not win or lose the run —
//             it is a genuine, self-contained test of "fail a check -> lose the
//             quest" in tracked state.

export const TRIAL_QUEST_ID = "quest_trial";

// Tone-flavored framing so the decisive check reads as a real, irreversible test
// rather than a trivial one. Keyed off the resolved tone (with a default).
const TRIAL_FLAVOR = {
  default: { seal: "an ancient warded seal", verb: "break", ruin: "the sealed vault" },
  dark_fantasy: { seal: "a blood-ward sunk into the reliquary door", verb: "break", ruin: "the reliquary" },
  grimdark: { seal: "a blood-ward sunk into the reliquary door", verb: "break", ruin: "the reliquary" },
  cosmic_horror: { seal: "a humming sigil that will not hold its shape", verb: "unmake", ruin: "the drowned shrine" },
  post_apocalyptic: { seal: "a corroded blast-door keypad", verb: "override", ruin: "the bunker" },
  steampunk: { seal: "a seized pressure-lock, hissing steam", verb: "crack", ruin: "the boiler vault" },
  sword_sorcery: { seal: "a rune-barred iron gate", verb: "force", ruin: "the barrow" },
  high_fantasy: { seal: "a warding glyph of the old order", verb: "dispel", ruin: "the shrine" },
  mythic: { seal: "a god-touched seal of binding", verb: "break", ruin: "the sanctum" },
  cyberpunk: { seal: "an ICE-locked vault node", verb: "breach", ruin: "the vault node" }
};

function toneKey(tone) {
  return String(tone || "").trim().toLowerCase().replace(/[^a-z_]+/g, "_");
}

function flavorFor(tone) {
  const key = toneKey(tone);
  return TRIAL_FLAVOR[key] || TRIAL_FLAVOR.default;
}

/**
 * Builds the check-gated, losable trial side-quest for a CAMPAIGN run. Its final
 * stage gates on the player's d20 (completion.kind "check") and FAILS the quest on
 * a miss (failOnMiss). Shape mirrors createMainQuest so it validates identically.
 *
 * @param {object} world resolved world (for tone flavor)
 * @param {{ secondLocationId?: string, secondLocationName?: string }} [options]
 * @returns {object} quest state to place at run.quests[TRIAL_QUEST_ID]
 */
export function buildTrialQuest(world = {}, options = {}) {
  const secondLocationId = typeof options.secondLocationId === "string" && options.secondLocationId
    ? options.secondLocationId
    : "second_location";
  const place = typeof options.secondLocationName === "string" && options.secondLocationName
    ? options.secondLocationName
    : "the deeper ruins";
  const f = flavorFor(world.tone);

  const stages = [
    {
      objective: `Descend to ${place}, where ${f.seal} bars the way deeper.`,
      completion: { kind: "reach_location", targetId: secondLocationId }
    },
    {
      // CHECK-GATED + FAILABLE: the decisive roll. One attempt; a miss ends it.
      objective: `Attempt to ${f.verb} ${f.seal} — you get ONE try. Botch it and ${f.ruin} collapses, losing this trail for good.`,
      completion: { kind: "check" },
      failOnMiss: true
    }
  ];

  return {
    questId: TRIAL_QUEST_ID,
    status: "active",
    isMain: false,
    authoredBy: "module",
    title: `Trial of ${capitalizeFirst(f.ruin.replace(/^the\s+/i, ""))}`,
    description:
      `A losable trial for the bold: reach ${place} and ${f.verb} ${f.seal}. ` +
      `Success opens the way; a failed attempt is final — the trail is lost.`,
    stages,
    stage: 0,
    // Mirror the active stage (stage 0) onto the top-level fields for back-compat,
    // exactly as createMainQuest does.
    objective: stages[0].objective,
    completion: stages[0].completion,
    relatedEntityIds: [],
    memoryFactIds: [],
    flags: { checkGated: true }
  };
}

function capitalizeFirst(value) {
  const s = String(value || "").trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}
