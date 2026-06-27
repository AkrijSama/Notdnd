import {
  ABILITIES,
  ABILITY_LABELS,
  BACKGROUNDS,
  CLASSES,
  RACES,
  STANDARD_ARRAY,
  POINT_BUY_BUDGET,
  abilityModifier,
  formatModifier,
  pointBuyCost
} from "../../server/solo/dndData.js";
import { buildCharacter } from "../../server/solo/characterBuild.js";

const ONBOARDING_LOADING_PHRASES = [
  "Bribing the innkeeper...",
  "Convincing goblins to relocate...",
  "Hiding the body...",
  "Forging your reputation...",
  "Arguing with the cartographer...",
  "Feeding the tavern cat...",
  "Pretending you know what you're doing...",
  "The Blight has no idea you're coming..."
];

// The onboarding "arrival" exchange is GM/narrator output, not a single named
// NPC. Label it generically so no specific character is baked into the UI.
const NARRATOR_LABEL = "Narrator";

const TONE_CHIPS = ["dark fantasy", "high fantasy", "grimdark", "sword and sorcery", "post-apocalyptic", "cosmic horror", "steampunk", "mythic"];
const LOCATION_TYPE_CHIPS = ["tavern", "city gate", "wilderness", "dungeon", "port", "market", "temple", "ruins", "camp", "crossroads"];
const ART_STYLE_OPTIONS = [
  { id: "illustrated", label: "Illustrated Dark Fantasy", blurb: "Painterly, dramatic, card-art" },
  { id: "anime", label: "Anime VN", blurb: "Clean line art, expressive faces" },
  { id: "cinematic", label: "Dark Cinematic", blurb: "Moody, filmic key art" }
];

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderChip(label, active, attr) {
  return `<button type="button" class="onb-chip ${active ? "active" : ""}" ${attr}>${esc(label)}</button>`;
}

function renderWorldStep(state) {
  const def = state.worldDef || {};
  const loading = Boolean(state.loading);
  const toneChips = TONE_CHIPS.map((tone) => renderChip(tone, def.tone === tone, `data-world-tone="${esc(tone)}"`)).join("");
  const locChips = LOCATION_TYPE_CHIPS.map((type) => renderChip(type, def.startingLocationType === type, `data-world-loctype="${esc(type)}"`)).join("");
  const artCards = ART_STYLE_OPTIONS.map(
    (option) => `
      <button type="button" class="onb-art-card ${(def.artStyle || "illustrated") === option.id ? "active" : ""}" data-world-artstyle="${option.id}">
        <div class="onb-art-prev onb-art-${option.id}"></div>
        <div class="onb-art-label">${esc(option.label)}</div>
        <div class="onb-art-blurb">${esc(option.blurb)}</div>
      </button>`
  ).join("");

  return `
    <section class="onboarding-shell onb-world">
      <header class="onboarding-header">
        <div class="tag">World Generator</div>
        <h2>Define Your World</h2>
        <p class="onb-disclaimer">Fields you leave blank will be imagined by the AI.</p>
      </header>

      <div class="onb-field">
        <label>World name</label>
        <input data-world-field="name" maxlength="80" placeholder="The Shattered Realm" value="${esc(def.name || "")}" ${loading ? "disabled" : ""} />
      </div>

      <div class="onb-field">
        <label>Tone / setting</label>
        <div class="onb-chips">${toneChips}</div>
        <input data-world-field="tone" maxlength="60" placeholder="…or type your own" value="${esc(def.tone || "")}" ${loading ? "disabled" : ""} />
      </div>

      <div class="onb-field">
        <label>Starting region / location name</label>
        <input data-world-field="startingLocationName" maxlength="80" placeholder="The Ashen Wastes" value="${esc(def.startingLocationName || "")}" ${loading ? "disabled" : ""} />
      </div>

      <div class="onb-field">
        <label>Starting location type</label>
        <div class="onb-chips">${locChips}</div>
      </div>

      <div class="onb-field">
        <label>One sentence of world flavor</label>
        <textarea data-world-field="flavor" maxlength="240" placeholder="A kingdom where magic was outlawed after the god-wars" ${loading ? "disabled" : ""}>${esc(def.flavor || "")}</textarea>
      </div>

      <div class="onb-field">
        <label>Art style</label>
        <div class="onb-art-grid">${artCards}</div>
      </div>

      <button class="onb-primary" data-action="generate-world" ${loading ? "disabled" : ""}>${loading ? "Generating…" : "Generate World"}</button>
      ${state.error ? `<div class="onboarding-error">${esc(state.error)}</div>` : ""}
    </section>
  `;
}

// ---------------------------------------------------------------------------
// Character creation wizard (Ticket 38) — 6 steps, rendered from dndData.
// ---------------------------------------------------------------------------
const WIZARD_STEPS = ["Identity", "Race", "Class", "Background", "Abilities", "Review"];
const STANDARD_ARRAY_DEFAULT = { strength: 15, dexterity: 14, constitution: 13, intelligence: 12, wisdom: 10, charisma: 8 };

function renderWizardProgress(step) {
  return `<div class="cw-progress">${WIZARD_STEPS.map(
    (label, i) => `<span class="cw-step ${i + 1 === step ? "active" : ""} ${i + 1 < step ? "done" : ""}">${i + 1}. ${esc(label)}</span>`
  ).join("")}</div>`;
}

// Shared mid-creation portrait preview (steps 1 Identity + 6 Review). Reads
// { portraitUri, portraitStatus } from the onboarding state. Never renders a
// blank box: it always shows the image, a spinner while first generating, the
// current image under a pulsing "Regenerating…" overlay while a race/class
// change generates a new one, the failed note, or an idle hint.
function renderPortraitPreview(portrait = {}, options = {}) {
  const variant = options.variant === "review" ? " onb-portrait-review" : "";
  const uri = typeof portrait.portraitUri === "string" ? portrait.portraitUri : "";
  const status = portrait.portraitStatus || "idle";
  const alt = `${esc(options.charName || "Character")} portrait`;
  // A new generation in flight while we still hold a prior image = regenerating.
  const regenerating = status === "generating" && Boolean(uri);
  if (uri) {
    return `<div class="onb-portrait-preview${variant}${regenerating ? " onb-portrait-regenerating" : ""}">
        <img class="onb-portrait-img" src="${esc(uri)}" alt="${alt}" />
        ${regenerating ? `<div class="onb-portrait-overlay"><span class="onb-portrait-spinner" aria-hidden="true"></span>Regenerating…</div>` : ""}
      </div>`;
  }
  if (status === "generating") {
    return `<div class="onb-portrait-preview${variant} onb-portrait-loading">
        <span class="onb-portrait-spinner" aria-hidden="true"></span>
        <small>Crafting your portrait… (~20s)</small>
      </div>`;
  }
  if (status === "failed") {
    return `<div class="onb-portrait-preview${variant} onb-portrait-loading">
        <small>Your portrait will be generated when you enter the world.</small>
      </div>`;
  }
  return `<div class="onb-portrait-preview${variant} onb-portrait-loading">
      <small>Pick a race and class to preview your portrait.</small>
    </div>`;
}

function renderCharIdentity(c, portrait = {}) {
  const mode = c.portraitMode || "generate";
  return `
    <div class="onb-identity">
      <div class="onb-identity-fields">
        <div class="onb-field"><label>Character name</label>
          <input data-cw-input="name" maxlength="60" placeholder="Ser Rowan Vale" value="${esc(c.name || "")}" /></div>
        <div class="onb-field"><label>Pronouns (optional)</label>
          <input data-cw-input="pronouns" maxlength="30" placeholder="they/them" value="${esc(c.pronouns || "")}" /></div>
        <div class="onb-field"><label>Portrait</label>
          <div class="onb-chips">
            ${renderChip("Let the GM imagine them", mode === "generate", 'data-cw-portraitmode="generate"')}
            ${renderChip("I'll upload my own", mode === "upload", 'data-cw-portraitmode="upload"')}
          </div>
          <small class="onb-hint">Your portrait is crafted from your race and class — it appears here as you choose them.</small>
        </div>
      </div>
      <div class="onb-identity-portrait">
        <div class="onb-kicker">Portrait preview</div>
        ${renderPortraitPreview(portrait, { charName: c.name, variant: "identity" })}
      </div>
    </div>`;
}

function renderCharRace(c) {
  return `<div class="cw-grid">${RACES.map((race) => {
    const bonuses = Object.entries(race.abilityBonuses).map(([a, b]) => `+${b} ${ABILITY_LABELS[a]}`).join(", ");
    return `<button type="button" class="cw-card ${c.race === race.name ? "active" : ""}" data-cw-race="${esc(race.name)}">
      <div class="cw-card-title">${esc(race.name)}</div>
      <div class="cw-card-meta">Speed ${race.speed} · ${esc(race.size)} · ${esc(bonuses)}</div>
      <div class="cw-card-traits">${esc(race.traits.join(" · "))}</div>
    </button>`;
  }).join("")}</div>`;
}

function renderCharClass(c) {
  return `<div class="cw-grid">${CLASSES.map((cls) => `
    <button type="button" class="cw-card ${c.characterClass === cls.name ? "active" : ""}" data-cw-class="${esc(cls.name)}">
      <div class="cw-card-title">${esc(cls.name)}</div>
      <div class="cw-card-meta">Hit die ${esc(cls.hitDie)} · Primary ${ABILITY_LABELS[cls.primaryAbility]}</div>
      <div class="cw-card-sub">${esc(cls.description)}</div>
      <div class="cw-card-traits">${esc(cls.features.join(" · "))}</div>
    </button>`).join("")}</div>`;
}

function renderCharBackground(c) {
  return `<div class="cw-grid">${BACKGROUNDS.map((bg) => `
    <button type="button" class="cw-card ${c.background === bg.name ? "active" : ""}" data-cw-background="${esc(bg.name)}">
      <div class="cw-card-title">${esc(bg.name)}</div>
      <div class="cw-card-meta">Skills: ${esc(bg.skillProficiencies.join(", "))}</div>
      <div class="cw-card-sub"><strong>${esc(bg.feature.name)}</strong> — ${esc(bg.feature.description)}</div>
    </button>`).join("")}</div>`;
}

function renderCharAbilities(c) {
  const method = c.abilityMethod || "standard_array";
  const scores = c.baseAbilityScores || {};
  const methodTabs = [
    ["standard_array", "Standard Array"],
    ["point_buy", "Point Buy"],
    ["roll", "Roll 4d6"]
  ].map(([id, label]) => renderChip(label, method === id, `data-cw-method="${id}"`)).join("");

  let editor = "";
  if (method === "point_buy") {
    const used = ABILITIES.reduce((sum, a) => sum + (pointBuyCost(scores[a] ?? 8) ?? 0), 0);
    const remaining = POINT_BUY_BUDGET - used;
    editor = `<div class="cw-remaining">Points remaining: <b>${remaining}</b> / ${POINT_BUY_BUDGET}</div>` +
      ABILITIES.map((a) => {
        const v = scores[a] ?? 8;
        const nextCost = v < 15 ? (pointBuyCost(v + 1) - pointBuyCost(v)) : Infinity;
        return `<div class="cw-ability-row"><span class="cw-ab">${ABILITY_LABELS[a]}</span>
          <button type="button" class="cw-step-btn" data-cw-pb="${a}:dec" ${v <= 8 ? "disabled" : ""}>−</button>
          <b class="cw-ab-val">${v}</b>
          <button type="button" class="cw-step-btn" data-cw-pb="${a}:inc" ${(v >= 15 || nextCost > remaining) ? "disabled" : ""}>+</button>
          <span class="cw-mod">${formatModifier(abilityModifier(v))}</span></div>`;
      }).join("");
  } else {
    const pool = method === "roll" ? (c.rolledScores || []) : STANDARD_ARRAY;
    const rollBtn = method === "roll"
      ? `<button type="button" class="ghost" data-cw-roll>${(c.rolledScores || []).length ? "Reroll" : "Roll 4d6 (drop lowest)"}</button>`
      : "";
    const poolNote = pool.length ? `<div class="cw-pool">Values: ${pool.join(", ")}</div>` : `<div class="cw-pool">Click Roll to generate your scores.</div>`;
    editor = `${rollBtn}${poolNote}` + ABILITIES.map((a) => {
      const cur = scores[a];
      const opts = [`<option value="">—</option>`, ...pool.map((v) => `<option value="${v}" ${cur === v ? "selected" : ""}>${v}</option>`)].join("");
      return `<div class="cw-ability-row"><span class="cw-ab">${ABILITY_LABELS[a]}</span>
        <select data-cw-assign="${a}" ${pool.length ? "" : "disabled"}>${opts}</select>
        <span class="cw-mod">${cur != null ? formatModifier(abilityModifier(cur)) : ""}</span></div>`;
    }).join("");
  }

  // Live derived stats from the current (partial) choices.
  const preview = buildCharacter({
    race: c.race,
    characterClass: c.characterClass,
    background: c.background,
    baseAbilityScores: scores
  });
  const derived = preview.derivedStats;
  return `
    <div class="onb-field"><label>Method</label><div class="onb-chips">${methodTabs}</div></div>
    <div class="cw-abilities">${editor}</div>
    <div class="cw-derived">
      <span><b>HP</b> ${derived.maxHp}</span>
      <span><b>AC</b> ${derived.armorClass}</span>
      <span><b>Speed</b> ${derived.speed}</span>
      <span><b>Init</b> ${formatModifier(derived.initiative)}</span>
      <span><b>Passive Perc.</b> ${derived.passivePerception}</span>
    </div>`;
}

function renderCharReview(c, portrait = {}) {
  const sheet = buildCharacter({
    name: c.name,
    pronouns: c.pronouns,
    race: c.race,
    characterClass: c.characterClass,
    background: c.background,
    baseAbilityScores: c.baseAbilityScores || {}
  });
  const ds = sheet.derivedStats;
  const abilityCells = ABILITIES.map((a) => `
    <div class="cw-ab-cell"><div class="cw-ab-key">${ABILITY_LABELS[a]}</div>
      <div class="cw-ab-score">${sheet.abilityScores.final[a]}</div>
      <div class="cw-ab-mod">${formatModifier(sheet.abilityModifiers[a])}</div></div>`).join("");
  const saves = sheet.savingThrows.map((s) => `<span class="${s.proficient ? "prof" : ""}">${ABILITY_LABELS[s.ability]} ${formatModifier(s.modifier)}${s.proficient ? " ●" : ""}</span>`).join("");
  const skills = sheet.skills.filter((s) => s.proficient).map((s) => `<span class="prof">${esc(s.name)} ${formatModifier(s.modifier)}</span>`).join("") || `<span class="small">No proficiencies</span>`;
  return `
    <div class="cw-review">
      <div class="cw-review-portrait">
        ${renderPortraitPreview(portrait, { charName: c.name, variant: "review" })}
        <div class="cw-review-name">${esc(sheet.name || "Unnamed")}</div>
        <div class="cw-review-sub">${esc([sheet.race, sheet.class, sheet.background].filter(Boolean).join(" · ") || "—")} · Level ${sheet.level}</div>
      </div>
      <div class="cw-ability-grid">${abilityCells}</div>
      <div class="cw-derived">
        <span><b>HP</b> ${ds.maxHp}</span><span><b>AC</b> ${ds.armorClass}</span><span><b>Speed</b> ${ds.speed}</span>
        <span><b>Init</b> ${formatModifier(ds.initiative)}</span><span><b>Passive</b> ${ds.passivePerception}</span><span><b>Prof</b> ${formatModifier(sheet.proficiencyBonus)}</span>
      </div>
      <div class="cw-review-block"><div class="onb-kicker">Saving Throws</div><div class="cw-review-row">${saves}</div></div>
      <div class="cw-review-block"><div class="onb-kicker">Skill Proficiencies</div><div class="cw-review-row">${skills}</div></div>
      <div class="cw-review-block"><div class="onb-kicker">Class Features</div><div class="cw-review-row">${(sheet.classFeatures || []).map((f) => `<span>${esc(f)}</span>`).join("") || "<span class='small'>—</span>"}</div></div>
      <div class="cw-review-block"><div class="onb-kicker">Racial Traits</div><div class="cw-review-row">${(sheet.racialTraits || []).map((t) => `<span>${esc(t)}</span>`).join("") || "<span class='small'>—</span>"}</div></div>
      <div class="cw-review-block"><div class="onb-kicker">Starting Equipment</div><div class="cw-review-row">${(sheet.startingEquipment || []).map((e) => `<span>${esc(e)}</span>`).join("") || "<span class='small'>—</span>"}</div></div>
    </div>`;
}

function renderCharacterWizard(state) {
  const c = state.character || {};
  const step = c.step || 1;
  const bodies = { 1: renderCharIdentity, 2: renderCharRace, 3: renderCharClass, 4: renderCharBackground, 5: renderCharAbilities, 6: renderCharReview };
  // Steps 1 (Identity) and 6 (Review) both show the live mid-creation portrait;
  // its status lives on the onboarding state, not the character object.
  const portrait = { portraitUri: state.draftPortraitUri, portraitStatus: state.draftPortraitStatus };
  const body =
    step === 1
      ? renderCharIdentity(c, portrait)
      : step === 6
        ? renderCharReview(c, portrait)
        : (bodies[step] || renderCharIdentity)(c);
  const isLast = step === 6;

  // Gate "Enter the World" on the three required character fields. Recomputed
  // every render, so the button re-enables live as the player fills fields in
  // (e.g. steps back to pick a race, returns to review). Back/nav are never
  // blocked — only the final submit.
  const missingRequirements = isLast
    ? [
        { ok: typeof c.name === "string" && c.name.trim().length > 0, label: "Enter a character name" },
        { ok: Boolean(c.race), label: "Choose a race" },
        { ok: Boolean(c.characterClass), label: "Choose a class" }
      ].filter((req) => !req.ok).map((req) => req.label)
    : [];
  const canEnter = missingRequirements.length === 0;

  const nav = `<div class="cw-nav">
    ${step > 1 ? `<button class="ghost" data-cw-back ${state.loading ? "disabled" : ""}>Back</button>` : "<span></span>"}
    ${isLast
      ? `<button class="onb-primary" data-cw-enter ${state.loading || !canEnter ? "disabled" : ""}>${state.loading ? "Entering…" : "Enter the World"}</button>`
      : `<button class="onb-primary" data-cw-next>Next</button>`}
  </div>`;
  return `
    <section class="onboarding-shell onb-world cw">
      <header class="onboarding-header"><div class="tag">Character Creation</div><h2>Create Your Character</h2></header>
      ${renderWizardProgress(step)}
      <div class="cw-body">${body}</div>
      ${state.error ? `<div class="onboarding-error">${esc(state.error)}</div>` : ""}
      ${
        isLast && !canEnter
          ? `<div class="cw-validation" role="status">To continue: ${missingRequirements.map(esc).join(" · ")}.</div>`
          : ""
      }
      ${nav}
    </section>`;
}

function renderWorldPreviewStep(state) {
  const world = state.worldPreview || {};
  const loading = Boolean(state.loading);
  const location = world.startingLocation || { name: world.startingLocationName, description: "" };
  return `
    <section class="onboarding-shell onb-world">
      <header class="onboarding-header">
        <div class="tag">World Preview</div>
        <h2>${esc(world.name || "Your World")}
          <button type="button" class="onb-regen" title="Regenerate name" data-world-regen-field="name" ${loading ? "disabled" : ""}>⟳</button>
        </h2>
      </header>

      <div class="onb-preview">
        <div class="onb-preview-block">
          <div class="onb-kicker">The World</div>
          <p>${esc(world.description || "")}</p>
          <button type="button" class="onb-regen-text" data-world-regen-field="description" ${loading ? "disabled" : ""}>⟳ Regenerate description</button>
        </div>
        <div class="onb-preview-block">
          <div class="onb-kicker">You begin at</div>
          <strong>${esc(location.name || "")}</strong>
          <p>${esc(location.description || "")}</p>
          <button type="button" class="onb-regen-text" data-world-regen-field="startingLocationDescription" ${loading ? "disabled" : ""}>⟳ Regenerate location</button>
        </div>
        <div class="onb-preview-meta">
          <span class="tag">${esc(world.tone || "")}</span>
          <span class="tag">${esc(world.startingLocationType || "")}</span>
          <span class="tag">${esc(world.artStyle || "")}</span>
        </div>
      </div>

      <div class="onb-actions">
        <button class="onb-primary" data-action="confirm-world" ${loading ? "disabled" : ""}>Looks good — Create my character</button>
        <button class="ghost" data-action="regenerate-world" ${loading ? "disabled" : ""}>Regenerate blanks</button>
      </div>
      ${state.error ? `<div class="onboarding-error">${esc(state.error)}</div>` : ""}
    </section>
  `;
}

function renderMessages(messages = []) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return `<div class="onboarding-empty">No messages yet.</div>`;
  }

  return messages
    .map((entry) => {
      const role = entry.role === "user" ? "user" : "assistant";
      return `<article class="onboarding-message ${role}">
        <div class="onboarding-message-role">${role === "user" ? "You" : NARRATOR_LABEL}</div>
        <div class="onboarding-message-text">${entry.text || ""}</div>
      </article>`;
    })
    .join("");
}

export function renderOnboardingFlow(onboardingState = {}) {
  const step = onboardingState.step || "character";
  const loading = Boolean(onboardingState.loading);
  const thinking = Boolean(onboardingState.thinking);
  const exchanges = Number(onboardingState.exchanges || 0);
  const error = String(onboardingState.error || "");

  if (step === "world") {
    return renderWorldStep(onboardingState);
  }

  if (step === "world_preview") {
    return renderWorldPreviewStep(onboardingState);
  }

  if (step === "character") {
    return renderCharacterWizard(onboardingState);
  }

  if (step === "arrival") {
    return `
      <section class="onboarding-shell">
        <header class="onboarding-header">
          <div class="tag">Solo Onboarding</div>
          <h2>The Arrival</h2>
          <p>The world responds to your words in real time. Speak naturally.</p>
        </header>

        <div class="onboarding-chat-log">
          ${renderMessages(onboardingState.messages || [])}
          ${thinking ? `<div class="onboarding-thinking">The world weighs your words...</div>` : ""}
        </div>

        <form id="onboarding-chat-form" class="onboarding-form">
          <label>
            <span>Your response</span>
            <input
              name="message"
              maxlength="600"
              placeholder="Reply, ask about Ashenmoor, or test the world's memory..."
              autocomplete="off"
              ${thinking ? "disabled" : ""}
              required
            />
          </label>
          <button type="submit" ${thinking ? "disabled" : ""}>Send</button>
        </form>

        ${exchanges >= 3 ? `
          <div class="onboarding-hint">
            <p>Want to invite friends to play? You can start a full session anytime.</p>
            <button class="ghost" data-action="onboarding-open-dashboard">Open Campaign Dashboard</button>
          </div>
        ` : ""}

        ${exchanges >= 5 ? `
          <div class="onboarding-memory-note">
            Everything you've said is remembered. Come back anytime to keep talking.
          </div>
        ` : ""}

        ${error ? `<div class="onboarding-error">${error}</div>` : ""}
      </section>
    `;
  }

  return `
    <section class="onboarding-shell">
      <header class="onboarding-header">
        <div class="tag">Solo Onboarding</div>
        <h2>Create Your Character</h2>
        <p>Five minutes from signup to your first real roleplay scene.</p>
      </header>

      <form id="onboarding-start-form" class="onboarding-form">
        <label>
          <span>Character name</span>
          <input
            name="characterName"
            maxlength="60"
            placeholder="e.g. Ser Rowan Vale"
            value="${onboardingState.characterName || ""}"
            ${loading ? "disabled" : ""}
            required
          />
        </label>
        <label>
          <span>What are you?</span>
          <input
            name="archetype"
            maxlength="120"
            placeholder="A disgraced knight, a hedge witch, a cunning thief..."
            value="${onboardingState.archetype || ""}"
            ${loading ? "disabled" : ""}
            required
          />
        </label>
        <label>
          <span>One sentence about your past</span>
          <textarea
            name="backstorySnippet"
            maxlength="240"
            placeholder="I fled the capital after..."
            ${loading ? "disabled" : ""}
            required
          >${onboardingState.backstorySnippet || ""}</textarea>
        </label>
        <button type="submit" ${loading ? "disabled" : ""}>Enter the World</button>
      </form>

      ${loading ? `
        <div class="onboarding-loading" data-onboarding-loading>
          <div class="onboarding-loading-phrase" data-onboarding-phrase>${ONBOARDING_LOADING_PHRASES[0]}</div>
          <div class="onboarding-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
            <div class="onboarding-progress-bar" data-onboarding-progress style="width:0%;"></div>
          </div>
        </div>
      ` : ""}
      ${error ? `<div class="onboarding-error">${error}</div>` : ""}
    </section>
  `;
}

function animateOnboardingLoading(root) {
  const container = root.querySelector("[data-onboarding-loading]");
  if (!container) {
    return;
  }

  const phraseEl = container.querySelector("[data-onboarding-phrase]");
  const barEl = container.querySelector("[data-onboarding-progress]");
  const progressEl = container.querySelector(".onboarding-progress");

  let phraseIndex = 0;
  if (phraseEl) {
    setInterval(() => {
      phraseIndex = (phraseIndex + 1) % ONBOARDING_LOADING_PHRASES.length;
      phraseEl.textContent = ONBOARDING_LOADING_PHRASES[phraseIndex];
    }, 600);
  }

  if (barEl) {
    let progress = 0;
    const tick = () => {
      // Ease in quickly, then crawl with a pause near 90% to feel like real work.
      const remaining = progress < 90 ? 90 - progress : 99 - progress;
      const step = Math.max(0.4, remaining * (progress < 90 ? 0.06 : 0.01));
      progress = Math.min(99, progress + step);
      barEl.style.width = `${progress}%`;
      if (progressEl) {
        progressEl.setAttribute("aria-valuenow", String(Math.round(progress)));
      }
    };
    tick();
    setInterval(tick, 120);
  }
}

export function bindOnboardingFlow(root, handlers = {}) {
  animateOnboardingLoading(root);

  // ---- World generator (Ticket 39) ----
  root.querySelectorAll("[data-world-tone]").forEach((button) => {
    button.addEventListener("click", () => handlers.onWorldField?.("tone", button.getAttribute("data-world-tone")));
  });
  root.querySelectorAll("[data-world-loctype]").forEach((button) => {
    button.addEventListener("click", () => handlers.onWorldField?.("startingLocationType", button.getAttribute("data-world-loctype")));
  });
  root.querySelectorAll("[data-world-artstyle]").forEach((button) => {
    button.addEventListener("click", () => handlers.onWorldField?.("artStyle", button.getAttribute("data-world-artstyle")));
  });
  root.querySelectorAll("[data-world-field]").forEach((field) => {
    if (typeof field.addEventListener === "function") {
      field.addEventListener("input", () => handlers.onWorldFieldInput?.(field.getAttribute("data-world-field"), field.value));
    }
  });
  const generateBtn = root.querySelector('[data-action="generate-world"]');
  if (generateBtn) {
    generateBtn.addEventListener("click", () => handlers.onGenerateWorld?.());
  }
  const confirmWorldBtn = root.querySelector('[data-action="confirm-world"]');
  if (confirmWorldBtn) {
    confirmWorldBtn.addEventListener("click", () => handlers.onConfirmWorld?.());
  }
  const regenerateWorldBtn = root.querySelector('[data-action="regenerate-world"]');
  if (regenerateWorldBtn) {
    regenerateWorldBtn.addEventListener("click", () => handlers.onRegenerateWorld?.());
  }
  root.querySelectorAll("[data-world-regen-field]").forEach((button) => {
    button.addEventListener("click", () => handlers.onRegenerateField?.(button.getAttribute("data-world-regen-field")));
  });

  // ---- Character creation wizard (Ticket 38) ----
  const cwBack = root.querySelector("[data-cw-back]");
  if (cwBack) {
    cwBack.addEventListener("click", () => handlers.onCharStep?.(-1));
  }
  const cwNext = root.querySelector("[data-cw-next]");
  if (cwNext) {
    cwNext.addEventListener("click", () => handlers.onCharStep?.(1));
  }
  const cwEnter = root.querySelector("[data-cw-enter]");
  if (cwEnter) {
    cwEnter.addEventListener("click", () => handlers.onCharEnter?.());
  }
  root.querySelectorAll("[data-cw-input]").forEach((field) => {
    if (typeof field.addEventListener === "function") {
      field.addEventListener("input", () => handlers.onCharInput?.(field.getAttribute("data-cw-input"), field.value));
    }
  });
  root.querySelectorAll("[data-cw-portraitmode]").forEach((button) => {
    button.addEventListener("click", () => handlers.onCharField?.("portraitMode", button.getAttribute("data-cw-portraitmode")));
  });
  root.querySelectorAll("[data-cw-race]").forEach((button) => {
    button.addEventListener("click", () => handlers.onCharField?.("race", button.getAttribute("data-cw-race")));
  });
  root.querySelectorAll("[data-cw-class]").forEach((button) => {
    button.addEventListener("click", () => handlers.onCharField?.("characterClass", button.getAttribute("data-cw-class")));
  });
  root.querySelectorAll("[data-cw-background]").forEach((button) => {
    button.addEventListener("click", () => handlers.onCharField?.("background", button.getAttribute("data-cw-background")));
  });
  root.querySelectorAll("[data-cw-method]").forEach((button) => {
    button.addEventListener("click", () => handlers.onCharMethod?.(button.getAttribute("data-cw-method")));
  });
  root.querySelectorAll("[data-cw-assign]").forEach((select) => {
    if (typeof select.addEventListener === "function") {
      select.addEventListener("change", () => handlers.onCharAssign?.(select.getAttribute("data-cw-assign"), select.value));
    }
  });
  root.querySelectorAll("[data-cw-pb]").forEach((button) => {
    button.addEventListener("click", () => handlers.onCharPointBuy?.(button.getAttribute("data-cw-pb")));
  });
  const cwRoll = root.querySelector("[data-cw-roll]");
  if (cwRoll) {
    cwRoll.addEventListener("click", () => handlers.onCharRoll?.());
  }

  const startForm = root.querySelector("#onboarding-start-form");
  if (startForm) {
    startForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const formData = new FormData(startForm);
      handlers.onStart?.({
        characterName: String(formData.get("characterName") || "").trim(),
        archetype: String(formData.get("archetype") || "").trim(),
        backstorySnippet: String(formData.get("backstorySnippet") || "").trim()
      });
    });

    if (typeof handlers.onFieldChange === "function") {
      for (const fieldName of ["characterName", "archetype", "backstorySnippet"]) {
        const field = startForm.querySelector(`[name="${fieldName}"]`);
        if (field) {
          field.addEventListener("input", () => {
            handlers.onFieldChange(fieldName, field.value);
          });
        }
      }
    }
  }

  const chatForm = root.querySelector("#onboarding-chat-form");
  if (chatForm) {
    chatForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const formData = new FormData(chatForm);
      const message = String(formData.get("message") || "").trim();
      if (!message) {
        return;
      }
      handlers.onSendMessage?.(message);
      chatForm.reset();
    });
  }

  const dashboardBtn = root.querySelector('[data-action="onboarding-open-dashboard"]');
  if (dashboardBtn) {
    dashboardBtn.addEventListener("click", () => {
      handlers.onOpenDashboard?.();
    });
  }
}
