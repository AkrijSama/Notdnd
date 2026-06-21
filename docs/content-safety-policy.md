# Content Safety Policy

## Scope

This policy covers the mobile-safe mainline NotDND product, constrained AI GM behavior, future AI NPCs, and future human-controlled NPC/live event layers.

NotDND can support dark fantasy, danger, betrayal, temptation, romance, consequences, and morally complex choices. It must not make explicit sexual harm or non-consensual sexual content part of the mobile-safe product.

## Mobile-Safe Mainline Rules

- Keep romance, flirtation, temptation, and intimacy non-explicit.
- Use fade-to-black for sexual intimacy.
- Keep player agency clear.
- Avoid content that invites the player to sexually coerce, exploit, or trap another character.
- Avoid explicit anatomy and explicit sex acts.
- Treat trauma references carefully and avoid eroticizing harm.
- Do not let random AI outputs introduce red-zone material.
- Store safety-relevant moderation metadata for future AI/human NPC systems.

## AI GM Restrictions

The AI GM may:

- Frame scenes.
- Describe locations and atmosphere.
- Narrate consequences after system resolution.
- Suggest structured actions.
- Summarize remembered facts.
- Roleplay safe, constrained NPC dialogue when allowed by state.

The AI GM must not:

- Mutate persistent state directly.
- Invent durable canon without structured capture and approval path.
- Introduce red-zone content.
- Create unsupported rewards, items, NPCs, factions, locations, or world events as canon.
- Override Akrij-authored lore.
- Use safety bypass language such as "uncensored" as a product promise.

## AI NPC Future Restrictions

Future AI NPCs must be:

- Bound to specific NPC state, relationship state, location, and route constraints.
- Given explicit allowed/disallowed topic boundaries.
- Routed through moderation and structured output validation.
- Prevented from escalating into sexual coercion, explicit content, or non-consensual sexual content.
- Logged for safety review without printing secrets or sensitive tokens.
- Backed by authored fallback responses.

AI NPCs should enrich continuity and relationship depth. They should not be the source of canonical truth.

## Human NPC Future Restrictions

Future human-controlled NPC sessions must include:

- Access control.
- Scheduling/session boundaries.
- Moderation tools.
- Audit logs.
- Report/block tools.
- Clear safety rules for operators.
- No red-zone roleplay in the mobile-safe product.

Human NPC sessions are a premium/social layer later, not MVP.

## Red-Zone Banned Categories

These are banned from the mobile-safe mainline and must be blocked for AI/human NPC systems:

- Explicit sexual acts.
- Explicit anatomy.
- Rape/sexual assault.
- Trafficking.
- Sexual slavery.
- Erotic captivity.
- Player-controlled sexual coercion.
- Forced pregnancy/breeding themes.
- Non-consensual sexual content.

## Yellow-Zone Content

Allowed only with care, non-explicit framing, and non-erotic treatment:

- Captivity as non-sexual danger.
- Dark bargains.
- Corruption.
- Manipulation.
- Villain oppression.
- Trauma references.

Yellow-zone content should serve story, stakes, and consequences. It should not become fetishized or explicit.

## Green-Zone Content

Allowed in the mobile-safe mainline:

- Flirtation.
- Temptation.
- Romance.
- Fade-to-black.
- Betrayal.
- Rivalries.
- Cursed bargains.
- Dark fantasy consequences.
- Relationship tension.
- Moral pressure.

## Enforcement Expectations

Initial enforcement can be simple and testable:

- Prompt contract includes red/yellow/green guidance.
- Content linting checks authored packs for banned terms/patterns.
- AI outputs are parsed through a safety review layer before display or persistence.
- Persistent memory facts from AI are marked non-canonical until validated.
- Human NPC systems remain design-only until moderation exists.
