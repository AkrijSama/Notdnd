# Competitive Landscape — v1 (2026-07-17)

**Status:** strategy canon. Informs positioning, roadmap, and marketing copy.
Re-derive before distribution launch.

---

## SILLYTAVERN (open-source frontend, community standard for uncensored RP)

**WHAT IT IS:** free self-hosted middleware; user supplies the model
(local/OpenRouter); character cards (PNG-embedded data), keyword-triggered
lorebooks, extensions (dice/stat trackers, Visual Novel mode with expression
sprites, STscript macros), group chat.

**WHY IT IS NOT A COMPETITOR (the puppet problem):** every game feature is
decoration the model can ignore. Dice roll but nothing forces narrative
obedience (no authority gate, no committed state). Lorebooks are
keyword-injection, not memory (missed keyword = contradicted world). The
player is puppeteer and audience at once: the world cannot push back, which
produces the documented "their story didn't need me" hollowness. The
server-truth layer Inkborne is built on does not exist in ST's architecture
and cannot be added as an extension.

**WHAT IT PROVES (free market research):**

1. Large-scale demand for uncensored RP: users self-host Node servers for it
   (validates Forbidden tier demand).
2. VN-with-sprites is a beloved feature (validates the VN retention pillar).
3. The ST user's pain list = Inkborne's pitch: setup hell, lore misses, no
   real mechanics, prompt-babysitting → "the campaign that runs itself,
   remembers everything, and can't be bullied."

**POSITIONING RULE:** never compete on price or prompt-exposure. Inkborne's
product is that nobody needs to touch the prompt.

---

## DESIGN-LOCKED ROADMAP ITEMS ADOPTED FROM THIS ANALYSIS

*(build-forbidden until their gates)*

1. **ST CHARACTER-CARD IMPORTER** (post-validation, distribution-era): read a
   community character card file and mint an Inkborne NPC from it THROUGH the
   world-book mint tables (voice, romance data, preferences assigned per our
   laws; imported text treated as untrusted flavor, never as committed
   authority). Acquisition funnel aimed at the ST userbase.
2. **ENSEMBLE SCENES** (post-content): multi-NPC VN scenes (several committed
   voice contracts interacting in one scene). Quality bar: beats ST group chat
   because each speaker carries an enforced committed register.
3. **EXPRESSION DYNAMICS:** already on the art roadmap (pose/expression
   part-tagged library + tailor); ST's Visual Novel mode recorded here as
   market validation, not a new item.

---

## STANDING COMPETITOR TABLE

*(from the strategic audit at 3cf9553, recorded for continuity)*

- **Friends & Fables:** shipped, paying users, 5e familiarity; user-reported
  memory leaks (NPCs forgetting relationships, quest context loss,
  scene-transition resets) + resented credit economy.
- **AI Dungeon:** massive base, weak/decorative mechanics, drift at depth.
- **RoleForge-class:** shallow.
- **Inkborne's moat vs all:** server-owned truth + mechanics integrity; behind
  all on distribution/payment/content volume.

## THE FUN CEILING (derived estimates, 2026-07-20)

*Folded from the product-thesis adversarial review. These are **derived/estimated**
fun scores — not measured; no competitor is instrumented, and per
[[validation-baseline]] agent autoplay can't grade fun. They calibrate the "~6.5–7
ceiling" claim and where each rival breaks. The point is not the exact number; it is
that every incumbent's ceiling is set by a **structural** failure Inkborne's engine is
built to not have.*

| Product | Fun (est.) | Trajectory | The structural ceiling |
|---|---|---|---|
| SillyTavern + a strong model | **bimodal 8 / 3** | flat | Peaks high with a tuned card + power user; collapses to ~3 on memory decay / no stakes / no game underneath. No floor — the median session is nowhere near the peak. |
| AI companions (Character.AI-class) | **~7.5** | flat/soft | Emotional continuity is real, but there is no game and no consequence — a companion, not a campaign. Ceiling is affective, not ludic. |
| Token-RPGs / structured-RP apps | **~7** | rising slowly | Have *some* mechanics, but memory is a chat window and stakes are soft; depth thins as the session grows. |
| Friends & Fables | **~6.5** | fragile | Shipped 5e game, paying users — but user-reported memory leaks (NPCs forget relationships, quest context lost, scene resets) and a resented credit economy cap it. Durability is the exact failure. |
| AI Dungeon | **~6** | falling | Massive base, but decorative mechanics and drift-at-depth; the canonical "no game underneath / bully-able stakes" product. |

**Read:** nobody's ceiling is set by *prose* — every ceiling is set by **durability,
stakes, or the missing game.** That is the thesis in one table: beauty is not the
contested axis; the commit/consequence spine is. See
[[product-thesis]] for the moat framing and the payload gaps.
