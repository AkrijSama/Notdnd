# Non-Combat Activities as First-Class Mechanical Loops

**Status:** NORTH-STAR design spec. **Design-only** — no engine code, no schemas-as-implementation. This document locks the vision so it does not drift; it is **parked behind solo-combat validation** and builds nothing. When the build eventually starts, it starts from the dependency order at the end of this doc.

**Builds on:** current HEAD. Anchors cited against the live spine (`server/solo/attempt.js`, `server/solo/rules.js`, `server/solo/schema.js`) and the handbook (`docs/handbook/ch3`, `ch7`, `ch9`).

---

## 1. Core thesis

Inkborne's spine is **generic over activity type**. The four laws that make combat a game — three-band resolution, committed state, server-owns-truth, and consequence — say nothing about swords. They are a general grammar for *"a character attempts something with stakes, the server decides and commits the outcome, and the fiction narrates what the server already made true."*

**Combat is simply the first activity built on that spine.** Romance, crafting, and professions are not adjacent features or "social minigames." They are **the same machine pointed at a different verb.** A relationship check is an attack roll aimed at a disposition meter instead of a hit-point pool. A crafting attempt is a contested check whose failure band spoils materials instead of dealing damage. A profession is a progression ledger (Ch7) whose XP comes from deliveries and commissions instead of kills.

The payoff is the product thesis: **a player who never fights can still play a full game.** A dating-sim run, a crafting-professional run, a merchant run — each is a complete game with real stakes, not ambient flavor, *because it runs on the same spine that makes combat a game.* Nothing here invents a new resolution system. Everything here is the existing spine, named for a new activity.

---

## 2. Reference framing (the design model, explicitly)

**Emulate Stardew Valley's STRUCTURE.** Stardew's non-combat activities — farming, crafting, fishing, relationships — are *real systems* with their own progression, their own committed state (a friendship heart level, a skill level, a shipped-goods ledger), and their own stakes (a crop that dies, a gift that lands wrong, a bundle left incomplete). Each is a first-class loop a player can pursue for hundreds of hours *without touching the mines*. That is the target: non-combat activities that stand on their own as games.

**Do NOT emulate AI Town's structure.** AI Town is autonomous NPCs milling through schedules with no spine underneath — there is no check, no committed stake, no win/lose state, no progression the player drives. It is **atmosphere, not a game.** An Inkborne romance where the NPC merely "reacts warmly" with no committed disposition delta and no failure stakes *is AI Town* — engagement theater with nothing underneath. The spine is precisely what prevents that drift.

**AI Town contributes only the PRESENTATION layer** — VN sprites, NPC daily schedules, the felt sense of a living place. That is real value and worth adopting *as presentation*. It is not a design model for the loops. Schedules make an NPC *available*; the spine makes interacting with them a *game*.

**Character.AI is the DEMAND signal and the CAUTIONARY lesson.** The demand is proven: people want deep, persistent AI relationships badly enough to spend hours daily. The caution is the whole reason for the spine: Character.AI is engagement without a spine or a durable monetization surface — infinite conversation, no stakes, no state that *progresses toward anything*, nothing that can be *won*. Inkborne's answer to "why would a relationship here be different from Character.AI" is one sentence: **because it is a mechanical loop with committed state, real stakes, and a route you can win or lose.**

---

## 3. The shared spine (what every loop inherits, unchanged)

Every loop below rides these existing primitives. None of them are new.

- **Law 1 — no stakes, no roll** (`ch3` Tier 0 AUTOMATIC; `attempt.js` `band: "automatic"`). Safe conversation, browsing a stall, admiring a finished blade — these never roll. A loop only engages the dice when failure would *cost something*: standing, time, materials, a closing route.
- **Law 2 — three bands, never nothing** (`attempt.js` bands `success | success_at_cost | failure`). Every rolled attempt in every loop lands in one of three bands and **commits state in all three**. There is no "nothing happens." A romance move at cost advances disposition *and* incurs a complication; a botched craft consumes materials.
- **Committed state, server-owned.** The outcome is engine state — like HP or the wallet (`ch9` "server-owned, no client-side balances"). The relationship meters, reputation, and recipe outputs live on the run, not in the prose.
- **Server owns truth; the narrator describes.** Same discipline as combat: the server decides the band and commits the delta; the GM narrates *what the server already made true*. The model never owns a disposition number, never declares a craft succeeded, never grants standing. It reports the committed outcome in fiction.
- **Consequence and foreclosure.** Failure has teeth and retries degrade (`attempt.js` retry foreclosure). A spurned advance can harden an NPC; a repeated botched recipe can foreclose the approach until something changes.

The rest of this doc is just: *point that machine at a disposition meter, at a recipe, at a reputation ledger.*

---

## 4. Loop 1 — Romance / Relationship

### (a) How it uses the existing spine
A **relationship check** is an ordinary contested check (`ch3`) whose target is an NPC's disposition rather than their HP. The player states a social intent — persuade, charm, reassure, confront, deceive, confide — against a **goal-bearing NPC** (an NPC with wants the server tracks). The server applies Law 1 first: if the move carries no stake (idle chat with someone not set against you), it is AUTOMATIC and does not roll. If it carries a stake (a confession that could land wrong, a lie that could be seen through, a boundary being pushed), it rolls, and the three bands apply exactly as an attack roll's do:
- **success** — the move lands; disposition moves toward the player's goal.
- **success_at_cost** — it lands, but something is spent or exposed (a vulnerability revealed, a rival alerted, a promise now owed — the `debt`/`suspicion` meters exist for exactly this).
- **failure** — it misses; disposition can *harden*, and repeated missteps foreclose the approach (you cannot flirt your way past a boundary you keep trampling).

Insight/read-the-room is the perception analogue: a check against the NPC's true disposition, not a free reveal.

### (b) Committed state it introduces
**Almost none — the state already exists.** `schema.js` already carries `REQUIRED_RELATIONSHIP_METERS = [trust, affection, fear, debt, suspicion, loyalty, rivalry]` and `validateRelationship` (relationship as a committed object between two entities). The loop **names these as the disposition surface** and defines which meter a given social verb targets. What the design must add later (not now): a **route** concept — a named relationship arc with committed gates (a threshold on `affection`+`trust` that unlocks a beat), and a **route outcome** (committed, terminal-ish: together / estranged / transactional). "Winning a route" is reaching its committed end state, the way "winning a fight" is the enemy reaching 0 HP.

### (c) What stakes and progression mean here
- **Stakes:** a failed social move is not a re-roll-until-it-works slot machine. It moves a meter the *wrong* way, can raise `suspicion`/`fear`, can spend a one-time opening, and foreclosure means some doors close for good. That is what separates this from Character.AI's consequence-free chat.
- **Progression:** disposition meters climbing across sessions *is* the progression — a persistent, committed arc. A route is a milestone-like ladder (mirrors `ch7`'s "the number is the world talking"): the meters are the honest math, the route beats are the world's felt drama.

### (d) Narrator vs. server
The server commits the meter deltas and the band; the GM narrates the NPC's reaction as the *consequence of the committed change*, never as the change itself. The model may voice warmth or a cooling; it may not assert "she now trusts you" as a mechanical fact — it describes the trust the server already recorded. Same law as "the model narrates the wound the server dealt."

---

## 5. Loop 2 — Crafting

### (a) How it uses the existing spine
Crafting is **contract-through-three-band**, already gestured at in `ch9` ("the one recipe schema all crafting runs on") and `ch3`'s domains (*fieldcraft*, and the "talent vs. craft" distinction). A crafting attempt is a contested check: the character attempts a recipe, the DC is the recipe's difficulty, proficiency applies if the character holds the relevant domain. Law 1 gates it — assembling something trivial with materials to spare is AUTOMATIC, no roll. When failure would cost materials or time, it rolls into the three bands:
- **success** — the recipe's output item is granted (via the existing item contract, `ch9`: slot + bounded stat-mod + at most one ability + tags + flavor). Nothing new mechanically; a craft *produces a legal item*.
- **success_at_cost** — the item is made but flawed (a lower rarity roll, a consumed extra material, a tag missing) or made but something else is spent.
- **failure** — the attempt spoils; committed inventory is consumed without an output. This is the crafting analogue of taking damage: the loss is real and server-committed.

### (b) Committed state it introduces
Reuses existing surfaces: the **recipe schema** (`ch9`), **committed inventory** (server-owned, integer, like the wallet), and **materials as gating inputs** (the anti-inert-economy law already *requires* world books to price crafting inputs). The loop names later (not now): a **recipe-known** set (which recipes a character has learned — a committed unlock, granted by the skill/activity-grant primitive in §7) and optionally a **craft-quality** derived from the band. No new resolution system; the recipe is data, the check is Ch3, the output is a Ch9 item.

### (c) What stakes and progression mean here
- **Stakes:** materials are finite and server-committed; a failed craft *destroys inputs*. Money must be able to buy those inputs (`ch9` anti-inert-economy law), so crafting is genuinely embedded in the economy — a botch has a purse cost, not just a flavor cost.
- **Progression:** crafting XP feeds the same **ledger** as everything else (`ch7`: "XP to next milestone = current milestone × 100"). A crafter's milestones are earned through commissions and successful runs. Higher standing/known-recipes gate access to rarer recipes — progression is *committed events accumulating*, identical in shape to a fighter's kill-earned XP.

### (d) Narrator vs. server
The server rolls the band, consumes the inputs, and grants (or withholds) the item; the GM narrates the forge, the failure's ruin, the finished piece — describing the item the server already created against the Ch9 contract. The model never invents an item outside the vocabulary, never grants a stat the budget forbids (`ch9` "physically cannot print an item that overspends"), never declares a craft succeeded. Same discipline as combat's "the server owns the hit."

---

## 6. Loop 3 — Profession / Reputation

### (a) How it uses the existing spine
A profession is **non-combat progression on the existing ledger** (`ch7`), and reputation is **committed standing state** the world gates content on. `ch3` already names *standing* as a canonical stake ("the moment failure would cost something — time, safety, secrecy, standing"), and `schema.js` already carries `player.reputation`. A profession loop is: the character does profession work (deliveries, commissions, negotiations, cures, salvage), each resolved by the ordinary spine, and success feeds two committed surfaces — the **XP ledger** (advancing milestones) and a **reputation/standing** value with a faction, guild, or town. Haggling and contested negotiation are already Ch3 contested rolls (`ch9`: "haggling with someone who has reason to resist is a contested roll").

### (b) Committed state it introduces
Reuses `player.reputation` and the Ch7 milestone ledger. Names later (not now): **standing scoped to an entity/faction** (a merchant's standing with the caravan guild vs. the town watch — likely modeled as reputation-per-faction, an extension of the existing single `reputation`), and **rank/title** as the world-facing display of a milestone (`ch7`: a milestone can grant "a rank, a stripe, a louder reputation"). The profession itself is a **granted activity** (see §7's skill/activity-grant primitive): "you are a licensed crafter / a chartered merchant" is a committed capability, not a prose claim.

### (c) What stakes and progression mean here
- **Stakes:** reputation moves both ways and gates access — low standing closes a market, a guild, a route; a botched commission or a broken contract *lowers* committed standing (with foreclosure: burn a guild and that door stays shut). Standing is spendable and losable, like HP or coin.
- **Progression:** the milestone ladder *is* the career. A "crafting professional" advances by the same `ch7` curve a fighter climbs; the world maps those milestones onto ranks/titles/licenses. Higher standing unlocks rarer recipes, better contracts, restricted locations — progression gates content exactly as combat power gates a dungeon.

### (d) Narrator vs. server
The server commits the standing delta, the XP, the rank recompute (`ch7`: "a milestone is a recompute, not a shopping trip"); the GM narrates the guild's respect, the door that now opens, the title conferred — describing standing the server already recorded. The model never grants a rank or asserts a reputation number.

---

## 7. Prerequisites (dependency-ordered — the build order, when it builds)

None of this builds until solo-combat is validated. When it does, this is the order, because each item depends on the ones above it.

1. **The skill / activity-grant primitive.** The foundational unlock: a committed, server-owned capability record — "knows recipe X", "is a chartered merchant", "has the *insight* domain", "route Y is open." Every loop needs the engine to grant and check a non-combat capability the same way it grants a feat. Until a capability can be *committed and gated on*, none of the three loops has a spine to stand on. **This is the true prerequisite for all three.** (Design already gestured at in the Babel skill-acquisition spec; that hybrid design is the seed.)
2. **NPC disposition as first-class committed state.** The relationship meters exist in `schema.js` but must be *load-bearing*: a live surface that social checks read and write, that persists across sessions, and that the scene payload exposes. Romance is blocked on this; profession partially depends on it (faction disposition).
3. **Time / schedule system (#14) — NPC availability.** Loops need NPCs to be *somewhere at some time* — a shop open at hours, a person you can only court in the evening, a commission board that refreshes. This is the "when" layer. It is a **presentation-and-availability** dependency (borrowed from AI Town's schedule idea), not a resolution dependency: the spine works without it, but the loops feel like a living place only with it. Romance and profession both want it; crafting is largely independent of it.
4. **VN presentation layer.** Sprites, expression variants, speaker framing (the talk/VN pipeline already carries `talkResult.speakerName` and expression variants). This is **presentation only** — it makes the loops *feel* like Character.AI-grade relationships and a Stardew-grade town. It is last because every loop is fully a *game* without it; the VN layer makes it a *product people fall in love with*. It must never become the design (that is the AI Town trap).

**Ordering rationale:** (1) is the resolution substrate every loop needs; (2) makes romance and faction-standing real; (3) makes the world *available* across time; (4) makes it beautiful. A loop can ship the moment its own prerequisites (1, and for romance also 2) are met; 3 and 4 are enrichment, not gates on the mechanics.

---

## 8. Non-goals and anti-patterns (guardrails against drift)

- **No new resolution system.** If a proposal needs a fourth band, a bespoke "romance meter minigame," or a crafting subsystem that does not resolve through Ch3, it has drifted off-spine. Every loop is Law 1 + Law 2 + committed state. Full stop.
- **No AI Town drift.** An NPC "reacting" with no committed delta and no failure stake is atmosphere, not a loop. If a social exchange cannot be *lost*, it is not on the spine yet.
- **No Character.AI drift.** Infinite consequence-free conversation is the thing to *beat*, not to become. Every relationship must progress toward a committed, winnable/losable route state.
- **Narrator never owns outcome.** The same law that governs combat governs all three loops: the server commits, the model describes. A loop where the model asserts disposition, grants an item, or confers standing has broken the moat.
- **Presentation is not design.** VN sprites and schedules serve the loops; they are never the reason a loop exists.

---

## 9. Open questions (to resolve at build time, not now)

- **Reputation shape:** does `player.reputation` become per-faction (a map), or does a separate faction-standing surface sit beside it? (Leaning: per-faction extension, so the single existing field generalizes rather than forks.)
- **Route modeling:** is a romance "route" a specialized quest (reusing the quest engine's staged completion), or its own committed arc type? (Leaning: a quest-shaped arc, so it inherits gating/foreclosure for free.)
- **Craft-quality:** does the band map to output rarity, or to a separate quality tag? (Design-time; both stay inside the Ch9 item contract.)
- **No-combat playthrough acceptance:** what is the concrete proof that "a player who never fights can play a full game"? (Proposal: a scripted no-combat session — court a route to its end, craft to a milestone, earn a rank — that the harness can drive and assert committed deltas on, the way the combat slice is proven.)

---

## 10. Summary

The spine already contains most of what these loops need: three bands, committed state, the relationship meters, `reputation`, the Ch9 recipe/item/economy contract, the Ch7 ledger. The vision is not to *build new systems* — it is to **recognize that combat was only the first activity**, and to point the same machine at love, craft, and trade so that each becomes a game with stakes rather than flavor with vibes. Stardew for structure, AI Town for presentation only, Character.AI for demand and as the cautionary tale. Parked behind solo-combat validation; built in the order of §7 when the time comes.
