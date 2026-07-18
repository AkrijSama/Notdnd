# THE VERDANCE — Region Fuel v1 (babel world-book)

**Status:** SEALED 2026-07-17 (owner-ratified). This is world-book DATA for the
`babel` scenario, loaded verbatim (rephrased only for schema fit) into
`server/campaign/scenarios/babel.json`. It carries no code. Companion to
[babel-lebab-spec.md](../babel-lebab-spec.md) (the Tower/Lebab spine) and
[affordances-map-law.md](../../design/affordances-map-law.md) (the region graph
this fuels).

The Verdance is a corrupted Pacific-Northwest rainforest region — Exclusion Zone
country — where the licensed make uneasy money off a Chaos the Tower leaks. This
document is the region's canon: the cosmology it sits inside, its regional laws,
its 20 points of interest, and its factions.

---

## COSMOLOGY SPINE

- **THE GODDESS** is the Spirit of the Earth itself — the worldwide **VOICE**.
  Every beckoned hunter heard *her*. She grants the **STATUS WINDOW**. She
  manifests as a majestic **ELK**, or — in times of danger or egregious offense —
  an **EMERALD DRAGON**.
- **THE WORLD-TREE** is her anchor: her body-in-the-world. It is nearly
  unkillable; its visible condition (bloom / rot / glow) is a living readout of
  the land's corruption, expressed as **omens, not numbers** — sometimes cryptic
  even to keepers.
- **THE CHAOS DEMON LORD** is her dark mirror, seated at the bottom of **LEBAB**
  (the inverted 1000 floors beneath the Tower of Babel). The **TOWER** is his
  anchor — the wound in her world. Trees vs Towers; growth vs consumption; her
  omens vs his raptures.
- **Retro-implications (canon):** the Tower door killing the under-ranked is
  *his* threshold; raptures are *his* army-building (consumed human energy births
  chaos demons); floor-100's Lebab reveal means the Tower is his **chimney, not
  his seat**.
- **SEALED NOTE (owner-decide-later, not current canon):** the Tree, as an
  anchor, can in principle be threatened as the Tower can be climbed — late-game
  stakes, parked.

---

## REGIONAL LAWS

1. **RAPTURES ARE ANCIENT AND PUBLIC KNOWLEDGE.** This has happened for Ages.
   Everyone knows the pattern: a person vanishes without struggle (scene left
   eerily pristine); a demon outbreak follows. Families hold funerals for the
   vanished AND post watch rotations. No mystery about WHAT raptures are; the
   horror is that everyone knows and cannot stop it. Nature reclaims older sites.
2. **DEMONS DRIFT.** Newborn demons do not linger; they wander out, leaving
   **essence trails**. EXCEPTION: **portals** — a few strong demons stand
   permanent guard at portal sites.
3. **THE GODDESS'S LEDGER.** Take from the forest beyond need and misfortune
   finds you, scaling with greed and with proximity to the World-Tree (snapped
   gear, spoiled stores, wrong turns into rapture-sites). Egregious acts skip
   warnings — the Emerald Dragon comes. Regional folk wisdom: *"take gently."*
4. **GRAVEYARD OF CHAMPIONS.** God-backing raises the odds of death,
   statistically. The protagonist is not the first hero she has called, nor the
   last. She will never volunteer the count. Predecessor sites exist across the
   region.
5. **ESSENCE-SIGHT.** The protagonist's **unique trait** — he alone sees traces
   of demon essence (trails, residue, handler-scent), rendered via the STATUS
   WINDOW (trail strength = recency). This is WHY she summoned him: her
   counter-weapon; she cannot see into the Lord's work the way he can.
6. **ERA.** Modern parallel Earth; present-day technology level pre-corruption
   (Pacific-Northwest register: logging towns, ranger stations, highways,
   hospitals, hydro dams).

---

## THE 20 POINTS OF INTEREST

Danger tier → committed `state.dangerLevel`: SAFE 0 · LOW 1 · MID 2 · HIGH 3 ·
DEADLY 4. POI class rides `tags` as `poi:<class>`. Layout template is the closest
existing floor-plan pin (see the template wishlist at the foot).

| # | Name | Class | Danger | Note |
|---|------|-------|--------|------|
| 1 | The World-Tree | anchor / landmark | DEADLY-to-harm | Her anchor; regional living health-bar; omens, not numbers. |
| 2 | The Root Shrine | shrine / settlement | LOW | Keeper-camp at the Tree's base; monks/wardens read omens, quietly enforce "take gently"; rest + lore + rumor hub. |
| 3 | The Penitents' Row | ledger-site chain | LOW | Path of ruined poacher camps toward the Tree, each wrecked by escalating misfortune (one crushed under a *healthy* fallen oak); the Ledger made visible. |
| 4 | St. Brigid's Regional Medical | rapture-site (old) / supply-cache | MID | Pristine wards, dripping IVs, empty beds; region's only medicine stock still shelved; demon long gone, essence trails lead OUT (first tracking showcase); looters' cairns at the door. |
| 5 | The Warm House | rapture-site (fresh) | MID | Family home taken mid-dinner; trail out bright and recent; neighbors want to know which way it went; first bloodhound quest. |
| 6 | The Tithing Mill | faction-site (Hollow Congregation cell) | MID | Moss-eaten mill fronting Tower-worshippers whose tithe is betraying their own (guided "safe" routes past chaos; chalk marks on doorposts of houses that later vanish). No proof yet — essence-sight reads handler-scent on the marks; supplies the Cold Door. |
| 7 | The Drowned Highway | corrupted-infrastructure / route | MID | Interstate slumped into a flooded valley, car roofs as stepping stones; corrupted nesting in underpasses; shortcut vs safe long way. |
| 8 | Ranger Station 9 | corrupted-infrastructure / lore | MID | Fire-watch tower with intact pinned maps (**map-knowledge loot: reveals region nodes**); something roosts on the observation deck. |
| 9 | The Reservoir of the Unclaimed | mystery-site / archive | HIGH | Raptures consume energy but not memory; residue settles like silt and water gathers it; the dam's glass-still reservoir is generations FULL of it; it remembers faces — at dusk the lost mouth their final moments. Hooks: paid closure-readings (Ledger frowns); the region's only archive of what the vanished saw last. Future stake: if the Lord's side learned to harvest residue, this becomes a strategic target. |
| 10 | A Champion's Cairn | predecessor-site | MID | Burned ring, rusted Legendary driven into stone, bones buried respectfully BY SOMEONE; its provenance-vision is a prequel warning. |
| 11 | The Unfinished Map | predecessor-site | LOW | Collapsed hide-camp; hand-drawn map (**reveals nodes**) with margin notes about things "she didn't warn me about"; plants the omission arc. |
| 12 | The Old Rapture | rapture-site (ancient) | LOW | A hamlet swallowed generations ago, now pure forest: doorframes grown into trees, teacups in roots; proof the war is ancient; atmosphere + history loot. |
| 13 | Elkwater Crossing | settlement | SAFE-ish | Refugee/trader camp at a ford; watch rotations; funeral flags for the vanished. **Services: market, inn, quest-board.** |
| 14 | The Poacher's Yard | faction-site | MID | Organized crew stripping the forest industrially, somehow dodging the Ledger so far; locals hate them; her patience visibly ending; moral-fork content. |
| 15 | The Waking Mile | start-area / story | LOW | The CLEAREST ground in the region, deliberately kept calm by HER: soft light, honest paths, corruption pushed politely back; the shimmer at its edge is a boundary marker; older flattened bedding-spots in the grass show where OTHER champions woke. |
| 16 | The Bonelight Grove | flora / materials | MID-HIGH | Luminous chaos-touched stand; alchemy/crafting materials bloom here; so do the things that eat gatherers. |
| 17 | The Stillborn Field | mystery-site | HIGH | A FAILED rapture: the vanishing started and stopped halfway; half-consumed echoes flicker at dusk; keepers forbid entry; nobody understands it; the MC's sight might read what happened. |
| 18 | The Choir Cave | cave / XP-vein | HIGH | Karst galleries where chaos-saturated air through stone throats sings with STOLEN VOICES: playback of the consumed (a dead woman's verse; a counting-song from the Old Rapture's children); deeper galleries sing voices no one living has heard yet — the cave receives before the region loses; early-warning oracle or cruelest lure (the vanished singing your name); richest essence outside the Cold Door; depth disorients. Forbidden question (owner-decide-later): what is the instrument at the bottom? |
| 19 | The Cold Door | **PORTAL (endgame)** | DEADLY | A rapture that never cooled: a municipal cistern where the vanishing slowly CONTINUES; multiple strong guardian demons who never leave (regional law 2); the region's known "don't" and its richest vein; the Hollow Congregation delivers to it. |
| 20 | Her Clearing | story-gated | SAFE and terrifying | Unmarked meadow where the goddess manifests (the Elk's ground); you don't find it, it finds you. |

### Template wishlist (do NOT build this pass — pinned to nearest existing)
- **`dam`** — the Reservoir (pinned `ruin`) and its glass-still water want a dam
  floor plan.
- **`flooded-road`** — the Drowned Highway (pinned `road`) wants a flooded-route
  variant (car-roof stepping stones).
- **`cistern`** — the Cold Door (pinned `interior`) wants a municipal-cistern
  set-piece.

---

## FACTIONS

Seeded as minimal rows (name + standing + discovery); `disposition` / `wants` ride
`flags` for grounding (no engine field). Full standing/tier machinery is the
existing reputation engine.

| Faction | Disposition | Standing seed | Discovered | Wants |
|---|---|---|---|---|
| **Root Shrine Keepers** | friendly-reserved | +15 | yes | The Tree honored, the Ledger taught, the Stillborn Field left sealed. |
| **The Hollow Congregation** | hostile-SECRET (publicly ordinary mill-folk) | −30 | **no** | The Lord's favor via tithed betrayals; feed and protect the Cold Door; remain unproven. |
| **Elkwater Crossing Community** | neutral-warm, desperate | +8 | yes | Safety, medicine (St. Brigid's runs), news of the vanished, the traitor found. |
| **The Poacher's Yard Crew** | neutral-hostile, greedy | −15 | yes | Maximum extraction before consequences arrive; deniability. |

---

## THREAD-FRONTS

The engine caps **active** fronts at ≤3 (≤1 foreground) — the anti-noise law. Two
region fronts run live now; two more are **parked seeds** (authored here, rotate
in as the live arcs resolve).

**LIVE (in `fronts[]`):**
- **The Hollow Congregation** (`front_congregation`, secret) — the betrayal cell
  at the Tithing Mill; chalk marks → vanished houses → essence-sight reads the
  handler-scent.
- **The Warm House** (`front_warm_house`, opportunity) — the fresh-trail hunt; the
  set table, the bright trail, the neighbors' question.
- (`front_salvage` — the pre-region Charter salvage arc — is retained as the
  foreground front; it bridges cleanly to the Ledger/Poacher's-Yard extraction
  theme.)

**PARKED SEEDS (not instantiated — anti-noise ≤3 cap):**
- **The Reservoir closure-readings** — paid readings for grieving families (the
  Ledger frowns); the Unclaimed as the region's only archive.
- **The Cold Door supply line** — the Congregation's deliveries to the portal;
  the guardian demons who never leave; endgame.

Retired to make room (pre-region geopolitics, superseded by the rapture
cosmology): `front_queue` (the Assembly Gate Queue) and `front_cordon` (the Quiet
Office), along with their secrets.

---

## NAME / FLAVOR BANKS (PNW-corrupted register)

Theme-appropriate seed banks (owner: names need only fit the register; banks may
generate alternates). Carried in `world.nameBanks`. **Read-surface gap:** worldgen
name generation currently draws from `TONE_PRESETS` in `server/solo/worldGen.js`,
not from scenario-level `world.nameBanks` — the bank is authored data awaiting a
consumer (see the gap ledger below).

- **Settlements:** Elkwater Crossing · Hollow Pine · Cedar Slough · Static Ridge ·
  Mill Bend · Ranger's Rest.
- **Wilds:** The Green Static · The Bonelight · The Choir Cave · Drowned Highway ·
  The Waking Mile · Rot Hollow · The Unclaimed.
- **People (frontier):** Odile · Ruth · Emory · Priya · Tobias · Saw · Cal · Wren.

---

## GAP LEDGER (data loaded; consuming engine surface absent or partial)

Precise, per item 4 of the dispatch — DATA is loaded; these consumers do not yet
exist (no engine wired this pass):

1. **Essence-trail rendering.** POIs carry rapture-fresh/old/failed and
   predecessor classes whose payoff is the MC's essence-sight (trail strength =
   recency). There is **no essence-trail render/read surface** yet — the STATUS
   WINDOW does not draw trails. The classes are loaded as `tags`; the sight
   mechanic is a future engine surface.
2. **Map-knowledge loot items.** Ranger Station 9 and The Unfinished Map are
   canon map-reveal sources. The regionMap reveal READ (`map:babel` fact →
   nodes) already exists (`server/solo/regionMap.js` `mapKnowledgeReveals`), but
   **no loader seeds the pickup fact/item** — creating the map items is world-book
   content (per affordances-map-law: "this pass ships the read"). Ledgered:
   commit a `memoryFact { type:"map_knowledge", tags:["map:babel","item"] }` when
   the player loots either site.
3. **Service kinds beyond inn/market/training.** `LOCATION_SERVICE_KINDS` is only
   `["inn","market","training"]`. Elkwater's **quest-board** and Root Shrine's
   **lore** have no service-kind → not seeded as services (Elkwater seeds
   market+inn, which ARE live). Root Shrine's **rest** needs no service — Rest is
   a standing verb (`server/solo/affordances.js`). Ledgered: add `quest_board` /
   `lore` service kinds (or surface quest-board via the existing board/questOffer
   path) when those affordances are wanted.
4. **Layout templates.** `dam` / `flooded-road` / `cistern` don't exist; the
   Reservoir / Drowned Highway / Cold Door are pinned to nearest existing
   templates (see wishlist above). No templates built this pass.
5. **Scenario `world.nameBanks`.** Loaded as data; worldgen name generation reads
   `TONE_PRESETS`, not scenario nameBanks. Consumer TBD.
6. **Anti-noise front cap.** Two region fronts parked (Reservoir, Cold Door) —
   the ≤3 active-front law means they queue for rotation, not simultaneous play.
