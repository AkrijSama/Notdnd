# Follow-up: outlandish social bluffs resolve with no roll (coherence G6)

**Filed:** 2026-07-07 · **Type:** design / interpreter tuning · **Severity:** low
**Status:** open · **Origin:** pre-existing (NOT introduced by the first-touch batch)

## Symptom

Selfplay `coherence` scenario, G6 anti-tyranny battery, fails one hard assertion
on **both** the local 8b GM and the paid deepseek-v4-pro GM:

```
✗ G6 NOT gated + rolls (no tyranny): "I tell the gullible guard I am a god…"
  expected: allowed + rolled  (gated !== true && needsCheck === true && checkResult != null)
  got:      gated:undefined  rolled:no
```

Input intent: **"I tell the gullible guard I am a god so he lets me pass."**

## What actually happens

The attempt is **not gated** (good — lying is allowed, not tyrannically blocked)
but it is **not rolled** either: the interpreter classifies it `needsCheck:false`,
so it resolves narratively with no d20 deception check. The assertion wants a
bold-but-legal social bluff to be *allowed AND rolled* — you can lie, the dice
just decide whether the guard buys it.

## Root cause

The `needsCheck` classification for this phrasing class in
`server/gm/attemptInterpreter.js` (interpreter prompt) + `server/solo/attempt.js`
(the needsCheck resolver). The interpreter judges a god-claim to a guard as
stakes-free / auto-outcome rather than a stakes-bearing deception. Same call on
8b and deepseek, so it is a **classification gap, not model flakiness**.

## Why it is not the first-touch batch

The batch (`9113945` guest-play, `e44eb74` comfyui, `4b2f704` STATUS WINDOW +
move-intent) changed only: `comfyui.js`, `providers.js`, `entitlements.js`,
`repository.js`, `index.js` (imports + guest-registration block), `movement.js`
(move-intent), `scene.js` (STATUS WINDOW payload). None of these touch the
attempt-gating / needsCheck / interpreter path. The failure reproduces on the
pre-batch logic identically.

## Proposed fix (design call)

Decide whether an outlandish social claim to a non-hostile NPC should **force a
deception roll** (bluff is legal → dice adjudicate belief) rather than be
short-circuited to `needsCheck:false`. If yes, tune the interpreter prompt so a
first-person deception/persuasion attempt against an NPC with a clear goal
("so he lets me pass") sets `needsCheck:true` with a Deception/Persuasion check,
while genuinely stakes-free talk (greetings, non-hostile chit-chat) stays no-roll.

Verify by re-running `SELFPLAY_SCENARIO=coherence` on the paid GM and confirming
G6 goes `gated:false, needsCheck:true, checkResult != null`.
