# WORLD / MODULE LAW — the content taxonomy

**Status:** SEALED 2026-07-18 (owner law). Player-facing copy MUST use this
vocabulary. The banned phrase is **"story template(s)"** (and "template" used in
this content sense) on any player-facing surface.

---

## THE TAXONOMY

- **WORLD** — a *sealed universe*. Its own cosmology, factions, era, geography,
  canon. **Characters never cross between worlds.** A character belongs to exactly
  one world for its entire existence.
- **MODULE** — authored, **world-scoped** content *within* a world: a premise, a
  one-shot, an adventure. A module is always attached to a world; it is never a
  free-floating "template" that could be dropped into any world.

Player-facing copy: worlds contain modules. Never "story templates".
The "Modules — ready-made adventures within this world. Coming soon." panel is the
current placeholder.

---

## WHY IT IS SEALED (the systems this protects)

The "sealed universe, no cross-world characters" rule is not cosmetic — it is the
invariant several systems assume:

- **Seed / legends** — a world's generated seed and its emergent legends are
  world-local. A character carrying state across worlds would import a foreign
  seed/legend lineage and corrupt provenance.
- **Soul law** — a character's identity, memory, and continuity are bound to their
  world. Cross-world transfer would break the "the GM remembers *this* world's
  choices" contract.
- **Provenance** — every committed entity (POIs, factions, NPCs, items) is stamped
  to its world. Modules are world-scoped so authored content inherits that
  provenance cleanly; a world-agnostic "template" would have no provenance anchor.

A **module** is safe precisely because it is world-scoped: it authors content
*inside* an existing sealed universe, inheriting that world's seed, canon, and
provenance rather than pretending to be portable.

---

## THE RULE FOR CODE

- Player-facing strings say **world** and **module** — never "story template".
- Internal *layout*-template naming (mint templates, layout templates, string
  template literals) is **exempt** — it is not this content sense and not
  player-facing.
- Guard: a test asserts the banned phrase is absent from player-facing surfaces
  (see `tests/world-module-taxonomy.test.js`).
