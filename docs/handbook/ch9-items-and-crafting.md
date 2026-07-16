# Chapter 9 — Items & Crafting

*The Inkborne System — Core Book*

> Economy constraints: see [economy-law.md](../design/economy-law.md).

A sword in one world is a printed blade in another and a bound spirit in a
third — and all three are the *same object* to the engine. This chapter is
the contract every item in every world book signs, the law that keeps money
real, and the one recipe schema all crafting runs on.

---

## The item contract

Every item, in every world, is exactly this:

> **item = slot + a bounded stat-mod package + at most one granted
> ability + tags + flavor**

> Rarity tiers (Common→God) and the provenance log on items of power: see [economy-law.md, Law 7](../design/economy-law.md).

- **Slot** — where it sits (below). One item, one slot.
- **Stat-mod package** — bonuses to stats or derived stats, bounded by the
  item's rarity budget. The validator enforces the budget; a world book
  physically cannot print an item that overspends.
- **At most one ability** — a single granted effect, and it must be drawn
  from the engine's effect vocabulary (the ten statuses of Chapter 8, queue
  operations, checks, resource effects — things the engine already knows how
  to do). An item can make you *hasted when bloodied* or *shielded on a
  crit*; it cannot introduce an eleventh mechanic.
- **Tags** — machine-readable hooks (*blade*, *ranged*, *conductive*,
  *heirloom*) that world rules and threads key on.
- **Flavor** — the prose. Unbounded, unvalidated, and where the world's
  soul lives. Flavor never carries mechanics.

### Slots

Four worn slots, universal across all worlds:

| Slot | Count | What lives there |
|---|---|---|
| **Weapon** | 1 | The thing you fight with — whatever that means where you are. |
| **Armor** | 1 | The thing that stands between you and the floor. |
| **Accessory** | 2 | Everything else that changes your numbers: rings, implants, charms, sigils. |

Only slotted items modify your stats. Everything else you own is
**carried** — usable, tradeable, quest-relevant, but inert on your sheet
until it's in a slot.

### Rarity and the stat budget

Five tiers. Each tier's budget is the **total stat-mod points** an item may
spend (a +1 to any stat or derived stat costs one point), plus whether it
may carry its one ability:

| Rarity | Stat budget | Ability? |
|---|---:|---|
| **Common** | 1 | No — clean tools, honest steel. |
| **Uncommon** | 2 | No — better made, nothing more. |
| **Rare** | 3 | **Yes** — the tier where items get a trick. |
| **Epic** | 5 | Yes — a name, a history, a trick that matters. |
| **Relic** | 7 | Yes — the items world books build stories around. |

*Why ability gates at Rare: the first two tiers stay arithmetic so early
play stays legible — a new player compares two Commons on one number. The
jump from 3→5→7 keeps each tier above Rare a felt upgrade without letting a
Relic double a grown character's stats (a full ~20-milestone career grants
+10 stat points; a Relic is most of a tier's growth, not a career's).* The validator
enforces all of it: budget, single ability, vocabulary membership.

## Money

Each world has **one base currency**. Its name is lore — scrip, gil-marks,
cowries, ration-chits — its behavior is law:

- **Integer, indivisible, server-owned.** Your wallet is engine state, like
  HP. No half-coins, no client-side balances, no narrating yourself rich.
- **The anti-inert-economy law: money must be able to buy things.** A world
  book is *required* to price, at minimum: **items** (gear at every rarity
  its markets sell), **services** (healing, transport, information, repairs,
  bribes — the world's verbs for hire), and **crafting inputs** (the
  materials its recipes consume). A currency that can't be spent is a
  validator error, not a design choice. If the ledger pays you (Chapter 7)
  and the market can't take it, the economy is broken — so the contract
  makes that impossible to ship.

Prices, wages, and haggling are world content; haggling with someone who has
reason to resist is a contested roll (Chapter 3) like any other.

## Crafting

All crafting, in every world, runs on **one recipe schema**:

> **recipe = inputs + check (stat + DC) + time + output**

- **Inputs** — the materials consumed, priced in the world's markets (see
  the law above: if a recipe needs it, the world must sell it or place it).
- **Check** — one stat check against the recipe's DC, proficiency applying
  if you're trained in the relevant craft domain. Forging is STR or VIT
  work; wiring a scrambler is INT; distilling under a deadline might be DEX.
  The recipe names its stat.
- **Time** — real, committed time. The world moves while you work; threads
  do not wait for the glue to dry.
- **Output** — the item produced, itself bound by the item contract above.

The check resolves through **Chapter 3's three bands** — crafting is not a
special subsystem, it's a check with materials on the table:

- **Success** — the output, as specified.
- **Success at a cost** — you get the item, *and* the cost commits: a
  **flawed** version (one stat-mod reduced by 1, or a quirk tag the world
  book defines) **or** extra materials burned in the save. The recipe
  declares which cost it uses.
- **Failure with consequence** — no output, and the situation *changes*:
  materials ruined, the forge damaged, the noise noticed, the deadline now
  closer and the client now colder. Never "nothing happens, buy more iron."

**Recipes are world-book content.** The core system ships the schema and
the resolution; what can be made, from what, by whom — that's the world's
to say. A wasteland's recipes are water and salvage; a sprawl's are
firmware and favors. Same schema, different civilization.

---

*Slots hold the numbers, rarity bounds them, money must move, and making
things is just another roll with real stakes. That's the whole material
world — the rest is what your world book fills it with.*
