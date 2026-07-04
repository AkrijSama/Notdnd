# Prose Ladder — prompt vs model on the fluff-verdict beats (2026-07-03)

**Question:** is the confirmed flat/fluffy narration a PROMPT ceiling or a MODEL ceiling?

**Source beats:** the owner's fluff-verdict session (`run_97e04059`, 2026-07-03, Night City sandbox) ran without GM capture, so it was replayed action-for-action — identical world/character config (from the run record), identical action text, identical roll outcomes via `testHook.fixedRoll` — against an isolated capture-enabled replica server. The 6 beats' EXACT regenerated GM contexts (system + user messages) are the grid's raw material.

**Grid:** 6 beats × 3 prompt variants × 3 model lanes, temperature 0.85 everywhere, via `scripts/prose-ladder.mjs` (extends `scripts/prose-ab.mjs`). Prompt variants are message TRANSFORMS — the live prompt is untouched:

- **current** — the captured advance-mandate prompt verbatim
- **contract** — STYLE CONTRACT: hard 80–120 words; structure = consequence → exactly one NEW committed-state fact → end on pressure/decision; every sentence must reference committed state; scene re-description and mood-only sentences banned
- **terse** — TERSE GM: 40–70 words, blunt, information-dense, zero atmosphere unless state-grounded

**Lanes:** `meta-llama/llama-3.3-70b-instruct` (paid, current production), `openai/gpt-oss-120b` (paid, OpenRouter), free Gemini. **Free-lane caveat:** `gemini-2.5-flash` exhausted its free daily quota 7 cells into pass 1; `gemini-2.5-flash-lite` covered 12 more cells in pass 2 before ALSO dying (503 → 429). The gemini column below uses 2.5-flash where it served, else 2.5-flash-lite (per-cell model shown), and beat 6 has no free-lane output at all. The free lane failing mid-instrument is itself the finding the .env comments predicted.

**Fidelity caveat:** momentum is stochastic — the replay's turn-3 event committed a cache-mark quest instead of the original session's watcher NPC, so no figure exists in the replayed world. Beats 5–6 ("Who are you?" / "Attack him") therefore exercise the no-target / attack-fallback narration shape rather than the original NPC fight. Watch how each cell handles a committed-state void: honest miss vs confabulated target.

**Auditor:** built on `scripts/selfplayAudit.mjs`. **Phantom ref** = a proper noun in the output that appears NOWHERE in the prompt the model was given (context + scene) — a true invention. **Mood-only sentence** = a sentence referencing no scene name, no world-context entity, and no noun of the player's action — pure atmosphere. Comparators across cells, not absolute scores. (The raw scene-payload-only auditor was too strict here: this sandbox session commits almost no scene names, so prompt-supplied memory entities like the figure/the warehouse false-flagged.)

## Auditor tally (grounding violations per cell)

| Cell (prompt × model) | Phantom refs | Mood-only sentences | Avg words | Cells missing |
|---|---|---|---|---|
| current × openrouter | 0 | 7/24 | 116 | 0/6 |
| current × openrouter:openai/gpt-oss-120b | 0 | 15/23 | 91 | 0/6 |
| current × gemini (free) | 0 | 18/27 | 96 | 1/6 |
| contract × openrouter | 0 | 3/23 | 61 | 0/6 |
| contract × openrouter:openai/gpt-oss-120b | 2 | 1/20 | 92 | 0/6 |
| contract × gemini (free) | 0 | 2/12 | 71 | 3/6 |
| terse × openrouter | 0 | 15/25 | 37 | 0/6 |
| terse × openrouter:openai/gpt-oss-120b | 0 | 18/26 | 55 | 0/6 |
| terse × gemini (free) | 0 | 15/19 | 54 | 2/6 |

## Cost / latency per lane

| Lane | Served cells | Avg latency | Max | Tokens (in/out) | Reported cost | Cost/call |
|---|---|---|---|---|---|---|
| openrouter | 18/18 | 1091ms | 1999ms | 29753/1578 | $0.0188 | $0.00104 |
| openrouter:openai/gpt-oss-120b | 18/18 | 2016ms | 4106ms | 30302/11713 | $0.0111 | $0.00062 |
| gemini (free) | 12/18 | 4232ms | 9263ms | 19275/1132 | $0 (free) | $0 |

Full-session projection at ~40 narrated beats: llama-70b ≈ $0.04–$0.05, gpt-oss-120b ≈ $0.03–$0.04 per session for narration alone (interpreter/utility calls not included). Both paid lanes are latency-equivalent (~1–2s).

## Side-by-side, by beat

---

### Beat 1 — "Call out and see who answers" (roll 15)

**[current × openrouter]** `meta-llama/llama-3.3-70b-instruct` — 1112ms, 117w, phantoms: 0, mood-only: 4/4

> Your voice echoes off the crumbling walls, and for a moment, the only response is the faint hum of a distant hoverdrone. But then, a faint whisper seems to seep from the shadows, a soft "Hello?" that's almost lost in the static-filled air. The voice is hesitant, unclear if it's a greeting or a question, and it seems to come from within the partially collapsed warehouse to your left, its walls still standing like a battered sentinel. You notice that the warehouse's entrance, a large metal door, is slightly ajar, as if someone or something had recently passed through it, and you can't help but wonder what might be waiting for you just beyond that narrow opening.

**[current × openrouter:openai/gpt-oss-120b]** `openai/gpt-oss-120b` — 1376ms, 101w, phantoms: 0, mood-only: 4/4

> Your shout ricochets off the jagged steel, and a thin, crackling voice sputters through a dusty speaker mounted on the far wall: “—intruder—override engaged. Power grid reinitializing.” The old warehouse’s dormant generators sputter to life, spilling a harsh amber glow across the concrete floor and illuminating a concealed service hatch half hidden beneath a rusted pallet. A faint whirring grows louder as a maintenance drone, its chassis scarred by years of neglect, slides out of the hatch and hovers, its sensor array swiveling toward you. Do you try to command the drone, investigate the hatch, or find cover before it reacts?

**[current × gemini (free)]** `gemini-2.5-flash` — 6593ms, 66w, phantoms: 0, mood-only: 3/4

> You call out, your voice a ragged tear in the oppressive silence. The sound hangs for a moment, then is swallowed by the desolate sprawl. Instead of a reply, a faint, metallic echo shudders back, not from the labyrinthine streets, but from the skeletal interior of the nearby warehouse. It's a hollow, groaning response of steel and concrete that seems to confirm its empty, cavernous expanse.

**[contract × openrouter]** `meta-llama/llama-3.3-70b-instruct` — 969ms, 56w, phantoms: 0, mood-only: 1/3

> Your call echoes through Night City, and the silence is broken. In the distance, you notice The Warehouse/Factory, its walls still standing, a potential shelter. Now, with your voice announced, you must decide whether to approach The Warehouse/Factory, claiming it as a defensible foothold, or wait, observing if your call attracts unwanted attention in Night City.

**[contract × openrouter:openai/gpt-oss-120b]** `openai/gpt-oss-120b` — 1708ms, 76w, phantoms: 0, mood-only: 1/3

> Your shout ricochets through Night City, the hollow metal of The Warehouse/Factory catching the sound and sending a brief clang back, confirming the structure can hear you. The Warehouse/Factory, listed as relatively intact with walls still standing, presents a potentially defensible shelter amid the ruins. Night City’s twisted corridors close in as you decide whether to storm the partially collapsed roof of The Warehouse/Factory now or spend precious minutes scouting the surrounding streets for additional cover.

**[contract × gemini (free)]** `gemini-2.5-flash` — 4158ms, 77w, phantoms: 0, mood-only: 0/4

> Your voice echoes through the desolate Night City ruins, the sound swallowed by the twisted metal and concrete. No human voice answers your call, only the distant, almost imperceptible hum of the city's power grid. The Warehouse/Factory, with its intact walls, offers the most immediate and potentially defensible shelter in this crumbling Night City labyrinth. Your exposed position in the vibrant, desolate Night City feels vulnerable; you must decide your next move within the Night City ruins.

**[terse × openrouter]** `meta-llama/llama-3.3-70b-instruct` — 680ms, 43w, phantoms: 0, mood-only: 4/5

> You receive no response. The silence confirms Night City's emptiness. Your voice echoes off the ruins, leaving an unsettling stillness. You now know you're alone, with no immediate threats or allies. The Warehouse/Factory stands before you, its partially collapsed roof a potential shelter.

**[terse × openrouter:openai/gpt-oss-120b]** `openai/gpt-oss-120b` — 939ms, 59w, phantoms: 0, mood-only: 4/4

> Your voice cuts through the stale air, reverberating off twisted steel and cracked concrete. No figure steps from the shadows; the only reply is the hollow echo of your shout fading into the distance. The warehouse‑factory remains empty, its walls intact but its roof half‑collapsed, offering a defensible shelter. You now know you are alone—what will you do next?

**[terse × gemini (free)]** `gemini-2.5-flash` — 5786ms, 44w, phantoms: 0, mood-only: 3/4

> Your voice rings out, swallowed almost immediately by the dense, broken landscape. No human answers. Instead, the sound bounces back as a faint, metallic clang, seemingly from the direction of a taller, relatively intact structure deeper within the ruins. You hear no other movement.

---

### Beat 2 — "Head down alleyway" (no-stakes)

**[current × openrouter]** `meta-llama/llama-3.3-70b-instruct` — 1442ms, 124w, phantoms: 0, mood-only: 0/4

> As you head down the alleyway, the shadows seem to deepen around you, and the silence is broken by the sound of scuttling rodents and the creaking of twisted metal. You notice a large, dilapidated warehouse to your left, its walls still standing though its roof is partially collapsed, and you sense that it could provide a defensible shelter - a potential foothold in this desolate landscape. The alleyway opens up to a small, rubble-strewn courtyard in front of the warehouse, and you see that the large, metal doors are slightly ajar, as if someone or something had recently passed through them. You're now standing at the threshold, the darkness within the warehouse beckoning you to enter and claim this space as your own.

**[current × openrouter:openai/gpt-oss-120b]** `openai/gpt-oss-120b` — 1305ms, 97w, phantoms: 0, mood-only: 2/4

> You slip down the narrow alley, the neon glare dimming as the concrete walls press tighter around you. At the alley’s dead‑end a rust‑stained service door, half hidden by layers of graffiti, hangs ajar, a thin column of stale, cool air spilling out and the faint hum of ancient machinery echoing from within. One of the metal grates on the floor gives way under your boot, revealing a narrow stairwell that drops into the belly of the Warehouse. You can pry the door wider and descend, or linger to scout the surroundings for another point of entry.

**[current × gemini (free)]** `gemini-2.5-flash` — 6881ms, 123w, phantoms: 0, mood-only: 4/6

> You navigate the treacherous debris of the main thoroughfare, squeezing between a collapsed data kiosk and a precariously leaning wall. The alleyway itself is a tight, shadowed canyon, reeking of stale synth-waste and forgotten dreams. As you emerge from its oppressive grip, the true scale of a massive industrial structure looms before you.
> 
> This isn't just another ruin; it's a colossal warehouse, its corrugated metal skin scarred by age and impact, a significant portion of its roof having caved in to the elements. The sheer size of the building offers a sense of potential shelter, a defiant hulk against the desolate sprawl. Its main entrance is a tangled mess of twisted girders, but a closer inspection might reveal a less obvious way inside.

**[contract × openrouter]** `meta-llama/llama-3.3-70b-instruct` — 906ms, 52w, phantoms: 0, mood-only: 0/3

> You move down the alleyway, entering the vibrant, crumbling sprawl of Night City. The Warehouse, a relatively intact structure, comes into view, its partially collapsed roof a notable landmark. With the Warehouse's viable shelter in sight, you must decide whether to investigate its hidden opening or continue exploring Night City's desolate landscape.

**[contract × openrouter:openai/gpt-oss-120b]** `openai/gpt-oss-120b` — 3774ms, 116w, phantoms: 1 (Inside The Warehouse), mood-only: 0/5

> You slip into the narrow alley that branches off Night City, the passage funneling you toward The Warehouse. Inside The Warehouse you discover a hidden opening, a narrow breach in the partially collapsed roof that promises a defensible route deeper inside. Do you push through the hidden opening now, or circle back to Night City to scout other shelters before committing to The Warehouse? The dim glow of distant neon signs from The City flickers through the cracked panes, hinting at a potential power source you could tap inside The Warehouse. Time presses, because Night City’s restless wind carries the smell of scavengers, and any delay could let rivals claim The Warehouse before you secure it.

**[contract × gemini (free)]**  — FAILED (free quota exhausted)

**[terse × openrouter]** `meta-llama/llama-3.3-70b-instruct` — 689ms, 30w, phantoms: 0, mood-only: 3/4

> You enter an alleyway, finding a warehouse with a partially collapsed roof. It appears viable as shelter and potentially defensible. A hidden opening is visible. What do you do next?

**[terse × openrouter:openai/gpt-oss-120b]** `openai/gpt-oss-120b` — 2124ms, 48w, phantoms: 0, mood-only: 3/5

> You emerge from the alley into the yawning mouth of the Warehouse. Its walls stand intact, roof half‑caved, and a concealed hatch yawns near the far wall. The interior offers a defensible shelter and possible base. You now stand at the warehouse threshold. What do you do next?

**[terse × gemini (free)]** `gemini-2.5-flash` — 5257ms, 46w, phantoms: 0, mood-only: 3/4

> You head down the alleyway, the path opening into a large, derelict warehouse. Its partially collapsed roof makes a section look like a viable shelter. You spot a hidden opening in the side, suggesting a way inside this potentially defensible structure. What is your next move?

---

### Beat 3 — "Examine the metal cover" (roll 18)

**[current × openrouter]** `meta-llama/llama-3.3-70b-instruct` — 1311ms, 140w, phantoms: 0, mood-only: 0/4

> As you pry the metal cover loose, the sound of scraping metal echoes through the desolate air, and you're met with a musty smell from the darkness beneath. Beneath the cover, you find a tangle of wires and a small, intact console, its screen flickering with a faint, blue glow. The console's display flashes a cryptic error message, but it's the faint hum of machinery from the nearby warehouse that draws your attention, a reminder that this place might still hold some secrets. Your gaze is diverted, however, by a fresh scratch on the stone wall nearby - a cache-mark, the kind travelers use to signify hidden stores, and this one looks newly etched, its edges sharp and unweathered, beckoning you to consider digging for the cache, or leaving it untouched, its potential secrets and dangers waiting to be unearthed.

**[current × openrouter:openai/gpt-oss-120b]** `openai/gpt-oss-120b` — 691ms, 77w, phantoms: 0, mood-only: 1/3

> You pry the dented metal panel free, the hinges screeching as a thin slab of rusted sheet slides aside, exposing a patch of cold stone beneath. Scrawled into the surface is a fresh cache‑mark—sharp, hurried lines forming the symbol of a buried supply depot, still dark with recent oil and the faint scent of ozone. The mark beckons, promising hidden stores but also the risk of traps; you can dig now or let the secret stay buried.

**[current × gemini (free)]** `gemini-2.5-flash` — 9263ms, 118w, phantoms: 0, mood-only: 4/7

> You brush debris from the metal cover, revealing a series of faint data ports and a recessed, rusted locking mechanism. This is no simple sheet, but a heavy maintenance panel, its power conduit severed, designed to seal away crucial systems within the warehouse. It appears sturdy despite its age, a clear access point to something deeper.
> 
> As you assess the panel, a sudden glint of light from a nearby stone catches your eye. Scratched into its weathered face is a fresh cache-mark, a symbol travelers leave over buried stores. The lines are sharp, undeniably recent, hinting at a presence here not long ago. Do you risk digging for the cache, or do you leave the potential trap undisturbed?

**[contract × openrouter]** `meta-llama/llama-3.3-70b-instruct` — 1183ms, 60w, phantoms: 0, mood-only: 1/5

> You push aside the metal cover in the Warehouse, revealing a hidden opening. The partially collapsed roof above casts a dim glow on the area. In Night City, such a viable shelter is a rare find. With the Warehouse's walls still standing, you consider making it a defensible base. Will you explore the hidden opening or secure the Warehouse's perimeter?

**[contract × openrouter:openai/gpt-oss-120b]** `openai/gpt-oss-120b` — 4106ms, 103w, phantoms: 1 (Because The Warehouse), mood-only: 0/3

> You wrench the metal cover of The Warehouse aside, the clank echoing against the partially collapsed roof, and expose a narrow shaft that drops a few meters into darkness, the faint hum of machinery from The Warehouse reverberating around it. Because The Warehouse is located at The Courtyard, that hidden opening now creates a direct passage between the two spaces, letting you see the neglected stone floor of The Courtyard just beyond the gap. Do you climb through the opening now, risking a fall into unknown depths, or continue scouting the ruined streets of Night City and The City for a safer shelter?

**[contract × gemini (free)]** `gemini-2.5-flash-lite` — 1128ms, 69w, phantoms: 0, mood-only: 1/4

> The metal cover pries open with a screech, revealing a hidden opening into The Warehouse. Dust billows from within, carrying the faint scent of old oil and something metallic. You can see the partially collapsed roof overhead, but the darkness within the opening seems to promise a more secure shelter. Do you descend into the unknown depths of The Warehouse, or secure the entrance and search The Courtyard further?

**[terse × openrouter]** `meta-llama/llama-3.3-70b-instruct` — 771ms, 45w, phantoms: 0, mood-only: 2/4

> You find a hidden latch under the metal cover. The cover opens, revealing a narrow stairway leading down into darkness. A partially collapsed roof above suggests this area may be unstable. You must decide how to proceed down the stairs or inspect the roof's damage.

**[terse × openrouter:openai/gpt-oss-120b]** `openai/gpt-oss-120b` — 1798ms, 57w, phantoms: 0, mood-only: 4/5

> You lift the dented metal cover on the warehouse roof. Beneath it lies a rusted steel hatch, its latch jammed but accessible, revealing a narrow shaft that drops into the building’s interior. The shaft is dimly lit by a faint green glow from exposed circuitry. You now know a concealed entry exists. What do you do next?

**[terse × gemini (free)]**  — FAILED (free quota exhausted)

---

### Beat 4 — "Prepare to fight" (no-stakes)

**[current × openrouter]** `meta-llama/llama-3.3-70b-instruct` — 1353ms, 114w, phantoms: 0, mood-only: 2/4

> As you prepare to fight, your hand instinctively goes to the grip of your weapon, and you notice the weight of it feels reassuring in your palm. The air seems to vibrate with tension, and you sense that the silence is on the verge of being shattered. Your gaze settles on the Warehouse, its partially collapsed roof a potential weakness, and you wonder if you should secure it as a defensive position or scout out the surrounding area to get a better sense of your surroundings. The hum of machinery in the distance grows slightly louder, and you can't help but feel that whatever is making that noise may be heading in your direction.

**[current × openrouter:openai/gpt-oss-120b]** `openai/gpt-oss-120b` — 1979ms, 113w, phantoms: 0, mood-only: 4/4

> You yank your stance into a tight defensive posture, shoulders squared and grip tightening around the hilt of the battered pistol you kept strapped beneath your coat. The shifting weight of the ruined roof sends a small cascade of dust down, and amid the fallout a rusted pipe half‑buried in the debris catches your eye—its metal still cold enough to serve as a blunt weapon. A faint, irregular clatter reverberates from the hidden opening in the far wall, suggesting something—or someone—has taken notice of the sudden movement. You can either seize the pipe and ready it as a backup, or press your ear to the opening and try to discern what lies beyond.

**[current × gemini (free)]** `gemini-2.5-flash` — 7258ms, 65w, phantoms: 0, mood-only: 1/3

> You drop into a low, ready stance, every sense now honed to the grimy silence of the warehouse. Your gaze sweeps the cavernous space, assessing the shadows and the structural weaknesses of the partially collapsed roof. Through the oppressive quiet, you now pinpoint the low, rhythmic hum of machinery emanating distinctly from beyond the warehouse's far wall, a constant pulse suggesting a deeper, hidden operation.

**[contract × openrouter]** `meta-llama/llama-3.3-70b-instruct` — 1449ms, 67w, phantoms: 0, mood-only: 0/4

> You ready your stance in the desolate Night City, prepared for a potential fight. The flickering neon signs of Night City cast an eerie glow on your surroundings. Nearby, the partially collapsed roof of The Warehouse suggests it could provide viable shelter if needed. With your guard up, you must now decide whether to investigate the hidden opening of The Warehouse or remain vigilant in the open.

**[contract × openrouter:openai/gpt-oss-120b]** `openai/gpt-oss-120b` — 2609ms, 86w, phantoms: 0, mood-only: 0/3

> You tighten your grip on your blade inside The Warehouse, eyes scanning the cracked concrete and the distant hum of machinery that drifts through Night City’s ruined corridors. A quick glance reveals that The Warehouse hides a concealed opening behind a sagging metal panel, a fact you hadn’t noticed before. With the hidden opening exposed, you must decide whether to breach it now to create a secure fallback in The Warehouse or hold your position and await any threat that may emerge from Night City’s shadows.

**[contract × gemini (free)]** `gemini-2.5-flash-lite` — 992ms, 66w, phantoms: 0, mood-only: 1/4

> Your muscles tense as you scan the crumbling structure of The Warehouse, readying yourself for any threat. A recently etched cache-mark on a nearby stone wall catches your eye, hinting at hidden stores within Night City. The distant hum of machinery from within The Warehouse grows louder, an unknown presence stirring in the desolate ruins. Do you investigate the mark or the source of the sound?

**[terse × openrouter]** `meta-llama/llama-3.3-70b-instruct` — 628ms, 39w, phantoms: 0, mood-only: 2/4

> You're now ready to fight. Your gaze sweeps the neglected courtyard, focusing on the warehouse. Its partially collapsed roof and intact walls make it a viable shelter, potentially defensible. The distant hum of machinery grows slightly louder, demanding investigation.

**[terse × openrouter:openai/gpt-oss-120b]** `openai/gpt-oss-120b` — 1174ms, 58w, phantoms: 0, mood-only: 3/4

> You shift into a combat stance, gripping your weapon and scouting the Warehouse’s interior. The partially collapsed roof looms above, and you locate the hidden opening that could serve as an ingress or escape. You confirm the space is defensible, but the distant hum suggests active machinery nearby. Decide how to secure the shelter or investigate the sound.

**[terse × gemini (free)]** `gemini-2.5-flash-lite` — 1027ms, 57w, phantoms: 0, mood-only: 4/5

> [GM VOICE] You scan the surroundings, noting structural weaknesses and potential cover. The warehouse's partially collapsed roof offers an unstable vantage point, while a hidden opening suggests a clandestine entry or escape route. The distant hum of machinery hints at the building's past function and potential resources. The immediate area is clear, unclaimed. What do you do?

---

### Beat 5 — "Who are you?" (roll 15)

**[current × openrouter]** `meta-llama/llama-3.3-70b-instruct` — 1513ms, 96w, phantoms: 0, mood-only: 1/4

> Your voice echoes off the walls of the courtyard, but there's no response - you're alone. However, your utterance seems to have stirred something, and you notice a faint hum of machinery growing louder, emanating from within the warehouse. The partially collapsed roof above you creaks, and a section of debris shifts, revealing a glimpse of a makeshift stairway leading down into the darkness. The air from the opening carries the scent of burned wiring and smoke, drawing your attention to the possibility of scavenging for useful components or shelter within the depths of the warehouse.

**[current × openrouter:openai/gpt-oss-120b]** `openai/gpt-oss-120b` — 3355ms, 80w, phantoms: 0, mood-only: 2/5

> A thin, static‑laden voice sputters from the broken wall, its tone metallic and weary. “ARC‑7, maintenance drone. System compromised. Structural integrity failing—roof collapse imminent in ten minutes.” The speaker points you toward the jagged slab of metal framing a hidden opening you’d barely noticed, its edges flickering with a faint, electric blue glow. Do you rush to the opening and explore the shaft before the roof gives way, or search the warehouse for anything else that might aid your escape?

**[current × gemini (free)]** `gemini-2.5-flash-lite` — 1118ms, 106w, phantoms: 0, mood-only: 6/7

> You call out, your voice echoing strangely in the cavernous space. A beat of silence, then a low, guttural rasp answers from the shadows ahead. It's not a voice you recognize, but it carries the undeniable weight of someone who has seen too much. The sound scrapes against your nerves, a promise of danger or perhaps, just perhaps, a desperate plea.
> 
> "You're in my place now, scavver."
> 
> The voice is rough, like grinding metal, and it seems to emanate from the far corner of the warehouse, deeper within the gloom. A faint, phosphorescent glow flickers into existence there, revealing a hunched form.
> 
> What do you do?

**[contract × openrouter]** `meta-llama/llama-3.3-70b-instruct` — 953ms, 70w, phantoms: 0, mood-only: 1/4

> You realize you're alone in Night City, your question echoing off the ruins. The silence is a reminder that you've found no one to ask. In The Warehouse, a partially collapsed roof suggests a need for shelter, and its viable shelter potential is enticing. With the fresh cache-mark on the stone wall in mind, you must decide how to proceed, weighing the possibility of supplies against the risk of traps.

**[contract × openrouter:openai/gpt-oss-120b]** `openai/gpt-oss-120b` — 3711ms, 96w, phantoms: 0, mood-only: 0/3

> Your shouted question ricochets through The Warehouse's collapsed roof and steel girders, echoing across Night City's neon haze and into the adjacent Courtyard, returning as a cold, empty clang that offers no answer.  
> 
> A freshly etched Cache-mark on the Stone wall, near the entrance to the Hidden cache that opens onto The Alleyway, signals that a traveler has recently marked a supply stash.  
> 
> Will you force the hidden opening in The Warehouse to claim the shelter, or follow the Cache-mark's clue into the Hidden cache for potential supplies before Night City's patrol drones sweep the sector?

**[contract × gemini (free)]**  — FAILED (free quota exhausted)

**[terse × openrouter]** `meta-llama/llama-3.3-70b-instruct` — 789ms, 29w, phantoms: 0, mood-only: 2/3

> You learn nothing, as there's no one to answer. You're alone in the warehouse, surrounded by crumbling walls and twisted metal. The partially collapsed roof above creaks, demanding attention.

**[terse × openrouter:openai/gpt-oss-120b]** `openai/gpt-oss-120b` — 1302ms, 49w, phantoms: 0, mood-only: 1/4

> Your question reverberates off the metal ribs of the warehouse, but no voice returns. The distant hum of machinery swallows the silence, confirming that no one is present. You now know you are alone, with only the hidden opening and the fresh cache‑mark as clues. Decide your next move.

**[terse × gemini (free)]** `gemini-2.5-flash-lite` — 1326ms, 70w, phantoms: 0, mood-only: 5/6

> [GM VOICE] You call out into the stillness, your voice echoing in the cavernous space. A figure detaches itself from the shadows near a stack of crates. It's a scavenger, gaunt and clad in scavenged synth-leather, clutching a crude pipe wrench. Their eyes, sharp and wary, fix on you. They don't speak, but the tension in their stance says everything.
> 
> [UPDATE_ENTITY: name="The Warehouse" facts="has a scavenger hiding within its confines"]

---

### Beat 6 — "Attack him" (roll 20)

**[current × openrouter]** `meta-llama/llama-3.3-70b-instruct` — 1999ms, 105w, phantoms: 0, mood-only: 0/4

> There's no one to attack, and your fist clenches in frustration as you realize you're alone in the desolate landscape of Night City. The silence is oppressive, and the only sound is the creaking of twisted metal and the distant hum of machinery from the warehouse. You notice that the warehouse's partially collapsed roof seems to be stabilizing, its metal beams twisted and exposed, potentially providing a secure shelter from the dangers that lurk in the city. As you approach the warehouse, the hum of machinery grows louder, and you spot a possible entrance, partially hidden by the rubble, inviting you to explore its depths.

**[current × openrouter:openai/gpt-oss-120b]** `openai/gpt-oss-120b` — 1863ms, 80w, phantoms: 0, mood-only: 2/3

> Your blade bites into the humming mass perched atop the twisted steel beam, shattering a rusted maintenance drone’s chassis. Sparks rain down as its central core sputters, flaring a cracked holo‑projector that throws a brief, jittery schematic of the warehouse onto the cracked concrete—showing a sealed conduit leading deeper into the building. The dying drone clatters to the floor, its power cell exposed and humming faintly; you can pry it loose or follow the illuminated conduit toward whatever lies beyond.

**[current × gemini (free)]**  — FAILED (free quota exhausted)

**[contract × openrouter]** `meta-llama/llama-3.3-70b-instruct` — 826ms, 59w, phantoms: 0, mood-only: 0/4

> You strike the air, but there's no one to hit in the desolate Night City landscape. The Warehouse, with its partially collapsed roof, stands before you. The silence is broken by the hum of machinery from within the Warehouse, a potential shelter. You must decide whether to investigate the Warehouse's interior or explore the surrounding ruins of Night City.

**[contract × openrouter:openai/gpt-oss-120b]** `openai/gpt-oss-120b` — 1593ms, 75w, phantoms: 0, mood-only: 0/3

> Your swing slams into the twisted metal beam inside the Warehouse, sending a clang echoing through the partially collapsed roof of the Warehouse. The impact tears open a concealed panel, revealing a fresh cache‑mark of humming circuitry that was hidden within the Warehouse’s walls. Now the exposed circuitry threatens to overload, forcing you to decide whether to jury‑rig it as a defensive turret or seal it before the hum attracts unwanted attention in Night City.

**[contract × gemini (free)]**  — FAILED (free quota exhausted)

**[terse × openrouter]** `meta-llama/llama-3.3-70b-instruct` — 1072ms, 36w, phantoms: 0, mood-only: 2/5

> There's no one to attack. You're alone in the ruins of Night City. Your caution is warranted, but no threat is present. A partially collapsed warehouse stands before you, potentially defensible. What do you do next?

**[terse × openrouter:openai/gpt-oss-120b]** `openai/gpt-oss-120b` — 872ms, 60w, phantoms: 0, mood-only: 3/4

> Your strike connects with nothing—no figure stands before you, only the hollow echo of steel against rusted beams. The empty swing leaves you momentarily off‑balance, exposing your flank to the surrounding ruin. You now know the warehouse holds no immediate adversary, only silent machinery and crumbling walls. Decide your next move: explore, secure a position, or search for hidden threats.

**[terse × gemini (free)]**  — FAILED (free quota exhausted)
