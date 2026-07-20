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
import { renderWorldCreator, bindWorldCreator } from "./worldCreator.js";

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
// NOTE: the "starting location type" picker was removed from the sandbox flow —
// sandbox defaults to forest-ruins (engine-side); modules/campaigns carry their
// own start. (Leaving startingLocationType blank lets generateWorld apply the
// default.) Module authoring lives in campaignForge.js and is unaffected.
const ART_STYLE_OPTIONS = [
  { id: "illustrated", label: "Illustrated Dark Fantasy", blurb: "Painterly, dramatic, card-art", sample: "/public/assets/art-illustrated.jpg" },
  { id: "anime", label: "Anime VN", blurb: "Clean line art, expressive faces", sample: "/public/assets/art-anime.jpg" },
  { id: "cinematic", label: "Dark Cinematic", blurb: "Moody, filmic key art", sample: "/public/assets/art-cinematic.jpg" }
];

// The art-style picker (style-lock law: offered at CREATION for every world, authored
// or custom). It moved off the world landing (now card-led) into the character wizard's
// review step, so the player still chooses a visual register before entering.
function renderArtStylePicker(def = {}) {
  const artCards = ART_STYLE_OPTIONS.map(
    (option) => `
      <button type="button" class="onb-art-card ${(def.artStyle || "illustrated") === option.id ? "active" : ""}" data-world-artstyle="${option.id}">
        <div class="onb-art-prev onb-art-${option.id}">${option.sample ? `<img class="onb-art-sample" src="${esc(option.sample)}" alt="${esc(option.label)} sample" loading="lazy" />` : ""}</div>
        <div class="onb-art-label">${esc(option.label)}</div>
        <div class="onb-art-blurb">${esc(option.blurb)}</div>
      </button>`
  ).join("");
  return `
    <div class="onb-field onb-art-field">
      <label>Art style</label>
      <div class="onb-art-grid" data-onb-art-picker>${artCards}</div>
    </div>`;
}

// The sandbox-vs-guided play-mode choice for a CUSTOM world (authored worlds are set).
// Moved off the landing into the wizard review alongside the art picker.
function renderStartModePicker(def = {}) {
  return `
    <div class="onb-field onb-mode-field">
      <label>How do you want to play?</label>
      <div class="onb-chips">
        ${renderChip("Open sandbox: a pure open world; your goals are your own", (def.startMode || "sandbox") === "sandbox", `data-world-mode="sandbox"`)}
        ${renderChip("Guided adventure: a main quest, work to take on, and a destination", def.startMode === "guided", `data-world-mode="guided"`)}
      </div>
    </div>`;
}

// World-select cards (owner spec): image-led, PLAYER-FACING copy only — no
// system jargon on this screen. The card component is the investment; per-world
// art + copy are DATA (swap art/hook per world here, not in code). Art is
// PLACEHOLDER key art from the committed static assets — nothing is generated.
export const WORLD_SELECT_CARDS = [
  {
    scenarioId: "babel",
    title: "Babel",
    hook: "Wake in a strange land. Answer the call. Climb.",
    art: "/public/assets/art-illustrated.jpg"
  },
  {
    scenarioId: "",
    title: "Custom World",
    hook: "A world imagined for you.",
    art: "/public/assets/art-cinematic.jpg"
  }
];

function renderWorldCard(card, active) {
  return `
    <button type="button" class="onb-world-card ${active ? "active" : ""}" data-world-scenario="${esc(card.scenarioId)}" aria-pressed="${active ? "true" : "false"}">
      <img class="onb-world-card-art" src="${esc(card.art)}" alt="" loading="lazy" />
      <span class="onb-world-card-body">
        <span class="onb-world-card-title">${esc(card.title)}</span>
        <span class="onb-world-card-hook">${esc(card.hook)}</span>
      </span>
    </button>`;
}

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

// A user-created world card (the Worlds law: "Yours"). Selecting it carries a
// userWorldId (not a scenarioId) into character creation.
function renderUserWorldCard(card, active) {
  return `
    <button type="button" class="onb-world-card onb-world-card-user ${active ? "active" : ""}" data-world-userworld="${esc(card.userWorldId)}" aria-pressed="${active ? "true" : "false"}">
      ${card.art ? `<img class="onb-world-card-art" src="${esc(card.art)}" alt="" loading="lazy" />` : `<span class="onb-world-card-art onb-world-card-art-empty" aria-hidden="true">✦</span>`}
      <span class="onb-world-card-body">
        <span class="onb-world-card-title">${esc(card.title)}</span>
        <span class="onb-world-card-hook">${esc(card.hook || "A world you made.")}</span>
        <span class="onb-world-card-badge">Yours</span>
      </span>
    </button>`;
}

function renderWorldStep(state) {
  const def = state.worldDef || {};
  // CARD-LED LANDING (onboarding-rework, now due since worlds are multiple): the
  // first screen IS the world cards. Picking a ready-made world goes STRAIGHT to
  // character creation; the "Custom World" card opens the creation wizard. There is
  // no intermediate "Generate/Continue" button — the card is the entry. The legacy
  // inline worldgen form (name/tone/flavor/art) is replaced by that wizard.
  return `
    <section class="onboarding-shell onb-world">
      <header class="onboarding-header">
        <div class="tag">A World Awaits</div>
        <h2>Choose Your World</h2>
        <p class="onb-disclaimer">Pick a world to step into, or imagine one of your own.</p>
      </header>

      <div class="onb-field onb-featured-world">
        <div class="onb-world-cards">
          ${WORLD_SELECT_CARDS.map((card) => renderWorldCard(card, (def.scenarioId || "") === card.scenarioId)).join("")}
          ${(Array.isArray(state.userWorlds) ? state.userWorlds : []).map((w) => renderUserWorldCard(w, def.userWorldId === w.userWorldId)).join("")}
        </div>
      </div>
      ${state.error ? `<div class="onboarding-error">${esc(state.error)}</div>` : ""}
    </section>
  `;
}

// ---------------------------------------------------------------------------
// Character creation wizard (Ticket 38) — 6 steps, rendered from dndData.
// ---------------------------------------------------------------------------
const WIZARD_STEPS = ["Identity", "Race", "Class", "Background", "Abilities", "Review"];
const STANDARD_ARRAY_DEFAULT = { strength: 15, dexterity: 14, constitution: 13, intelligence: 12, wisdom: 10, charisma: 8 };

const AUTHORED_WIZARD_STEPS = ["Identity", "Origin", "Review"];
const AUTHORED_WIZARD_SEQ = [1, 2, 6];

function renderWizardProgress(step, authored = false) {
  const labels = authored ? AUTHORED_WIZARD_STEPS : WIZARD_STEPS;
  const seq = authored ? AUTHORED_WIZARD_SEQ : [1, 2, 3, 4, 5, 6];
  const activeIdx = seq.indexOf(step);
  return `<div class="cw-progress">${labels.map(
    (label, i) => `<span class="cw-step ${i === activeIdx ? "active" : ""} ${activeIdx !== -1 && i < activeIdx ? "done" : ""}">${i + 1}. ${esc(label)}</span>`
  ).join("")}</div>`;
}

// Authored-world creation panels — the world book owns the origin (race/class-
// equivalent); there is no 5e race pick, class, ability point-buy, AC, or Speed.
const AUTHORED_ORIGIN_INFO = {
  babel: {
    name: "The Beckoned",
    feat: "The STATUS WINDOW",
    stats: "STR · DEX · VIT · SPIRIT · INT · LUCK",
    blurb: "You wake on the fringe of the Green Static, granted a WINDOW that does not lie. In this world capability comes from your origin and what you earn in play. There are no classes, no armor class, and no ability point-buy. Your rank begins UNASSESSED and rises as you gain skills."
  }
};

function renderAuthoredOrigin(c, scenarioId) {
  const o = AUTHORED_ORIGIN_INFO[scenarioId];
  if (!o) {
    return `<div class="cw-grid"><div class="cw-card active"><div class="cw-card-title">Origin assigned by the story</div><div class="cw-card-sub">This authored world grants your origin in play.</div></div></div>`;
  }
  return `
    <div class="cw-authored-origin">
      <div class="cw-card active" style="cursor:default">
        <div class="cw-card-title">${esc(o.name)}</div>
        <div class="cw-card-meta">Origin feat: ${esc(o.feat)} · ${esc(o.stats)}</div>
        <div class="cw-card-sub">${esc(o.blurb)}</div>
      </div>
      <p class="onb-disclaimer">This is the world's reserved origin for you, nothing to choose here. Continue to review and enter.</p>
    </div>`;
}

function renderAuthoredReview(c, portrait = {}, scenarioId = "") {
  const o = AUTHORED_ORIGIN_INFO[scenarioId] || {};
  return `
    <div class="cw-review cw-review--authored">
      <div class="cw-review-portrait">
        ${renderPortraitPreview(portrait, { charName: c.name, variant: "review" })}
        <div class="cw-review-name">${esc(c.name || "Unnamed")}</div>
        <div class="cw-review-sub">${esc(o.name || c.origin || "Origin")}${o.feat ? ` · ${esc(o.feat)}` : ""}</div>
        ${renderPortraitEditor(portrait)}
      </div>
      <div class="cw-review-block">
        <div class="onb-kicker">Your origin</div>
        <p>${esc(o.blurb || "Your capabilities are granted by the world and earned in play.")}</p>
      </div>
    </div>`;
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
  const accepted = portrait.accepted === true;
  const alt = `${esc(options.charName || "Character")} portrait`;
  // A new generation in flight while we still hold a prior image = regenerating.
  const regenerating = status === "generating" && Boolean(uri);
  // Redo (reroll with a fresh seed) is offered once a portrait exists or a prior
  // attempt failed; disabled while a generation is already in flight.
  const canRedo = Boolean(uri) || status === "failed" || status === "quota";
  const redoBtn = canRedo
    ? `<button type="button" class="onb-portrait-redo" data-cw-portrait-redo ${regenerating ? "disabled" : ""} aria-label="Redo portrait">↻ Redo</button>`
    : "";
  if (uri) {
    // FIX G: the player keeps rerolling until they explicitly accept. Once locked,
    // a confirmation badge shows but Redo stays available so they can still change
    // it. The accept control / badge sits bottom-left, mirroring the bottom-right
    // Redo (inline-positioned so no separate stylesheet change is needed).
    const acceptCorner = "position:absolute;left:8px;bottom:8px;z-index:2;padding:5px 12px;border-radius:8px;font-size:12px;";
    const acceptControl = accepted
      ? `<span class="onb-portrait-accepted" aria-live="polite" style="${acceptCorner}background:rgba(127,175,96,0.22);border:1px solid #5f7f3f;color:var(--ink,#ece1c7);">✓ Using this portrait</span>`
      : `<button type="button" class="onb-portrait-accept" data-cw-portrait-accept ${regenerating ? "disabled" : ""} style="${acceptCorner}">Use this portrait</button>`;
    return `<div class="onb-portrait-preview${variant}${regenerating ? " onb-portrait-regenerating" : ""}${accepted ? " onb-portrait-locked" : ""}">
        <img class="onb-portrait-img" src="${esc(uri)}" alt="${alt}" />
        ${regenerating ? `<div class="onb-portrait-overlay"><span class="onb-portrait-spinner" aria-hidden="true"></span>Regenerating…</div>` : ""}
        ${acceptControl}
        ${redoBtn}
      </div>`;
  }
  if (status === "generating") {
    // MODE-AWARE (item 4c): the upload path briefly hits "generating" while the
    // file POSTs — an uploading player must not read "crafting" (they gave us an
    // image; we're not generating one).
    const generatingCaption = options.portraitMode === "upload"
      ? "Uploading your portrait…"
      : "Crafting your portrait… (~20s)";
    return `<div class="onb-portrait-preview${variant} onb-portrait-loading">
        <span class="onb-portrait-spinner" aria-hidden="true"></span>
        <small>${generatingCaption}</small>
      </div>`;
  }
  if (status === "quota") {
    return `<div class="onb-portrait-preview${variant} onb-portrait-loading">
        <small>You've used today's portrait generations. Your portrait will be created when you enter the world.</small>
        ${redoBtn}
      </div>`;
  }
  if (status === "failed") {
    // FORENSICS (2026-07-19): show WHY it failed (the classified reason), not a bare retry.
    const failReason = esc(portrait.failReason || "Portrait generation didn't complete. Try again.");
    return `<div class="onb-portrait-preview${variant} onb-portrait-loading">
        <small class="onb-portrait-failreason">${failReason}</small>
        ${redoBtn}
      </div>`;
  }
  // Item 5 (bucket-2): the idle caption is MODE-AWARE — upload mode must never
  // show generation-flavored copy.
  return `<div class="onb-portrait-preview${variant} onb-portrait-loading">
      <small>${options.portraitMode === "upload" ? "Your uploaded image will be your portrait." : "Pick a race and class to preview your portrait."}</small>
    </div>`;
}

// Conversational portrait editor: a chat-style "describe a change" input applied
// to the CURRENT portrait, a thumbnail version-history strip (click to revert),
// and an entitlement-gated "N edits left" counter that becomes a soft-upgrade
// prompt when the daily image quota is spent. Renders only once a portrait
// exists. Leather-tome styled (:root tokens). Reusable beyond the creator.
function renderPortraitEditor(portrait = {}) {
  const uri = typeof portrait.portraitUri === "string" ? portrait.portraitUri : "";
  if (!uri) {
    return ""; // nothing to refine until a portrait exists
  }
  const ent = portrait.entitlement || null;
  const pending = portrait.editPending === true;
  const versions = Array.isArray(portrait.versions) ? portrait.versions : [];
  const draft = typeof portrait.editDraft === "string" ? portrait.editDraft : "";
  const unlimited = Boolean(ent && ent.unlimited);
  const remaining = ent && typeof ent.remaining === "number" ? ent.remaining : null;
  const exhausted = Boolean(ent) && !unlimited && typeof remaining === "number" && remaining <= 0;
  const quotaPrompt = exhausted || portrait.editError === "quota";

  let counter = "";
  if (unlimited) {
    counter = "Unlimited refinements";
  } else if (typeof remaining === "number") {
    counter = `${remaining} edit${remaining === 1 ? "" : "s"} left today`;
  }

  const versionStrip = versions.length > 1
    ? `<div class="onb-portrait-versions" role="list" aria-label="Portrait versions">
        ${versions
          .map(
            (v, i) =>
              `<button type="button" role="listitem" class="onb-portrait-version${v.uri === uri ? " is-current" : ""}" data-cw-portrait-revert="${esc(v.id)}" title="Version ${i + 1}" aria-label="Revert to version ${i + 1}">
                <img src="${esc(v.uri)}" alt="Portrait version ${i + 1}" loading="lazy" />
              </button>`
          )
          .join("")}
      </div>`
    : "";

  const disabled = pending || quotaPrompt ? "disabled" : "";
  const inputRow = `
    <div class="onb-portrait-edit-row">
      <input type="text" class="onb-portrait-edit-input" data-cw-portrait-edit-input
        placeholder="Describe a change: “longer hair”, “a scar over the left eye”…"
        value="${esc(draft)}" ${disabled} aria-label="Describe a change to the portrait" />
      <button type="button" class="onb-portrait-edit-send" data-cw-portrait-edit-send ${disabled}>${pending ? "Applying…" : "Apply"}</button>
    </div>`;

  let foot = "";
  if (quotaPrompt) {
    // Soft-upgrade — the editor and the monetization gate are the same surface.
    foot = `<div class="onb-portrait-upgrade" role="status">
        <strong>You've used today's portrait refinements.</strong>
        <span>Upgrade for unlimited portrait refinement.</span>
      </div>`;
  } else if (portrait.editError === "failed") {
    foot = `<div class="onb-portrait-edit-error" role="status">That edit didn't complete. Try rephrasing.</div>`;
  } else if (portrait.consistentEdit === false && versions.length > 1) {
    // Honest about the degraded path when no funded edit key is configured.
    foot = `<div class="onb-portrait-edit-hint">Edits regenerate the portrait with your change folded in.</div>`;
  }

  return `
    <div class="onb-portrait-editor">
      <div class="onb-portrait-editor-head">
        <span class="onb-kicker">Refine your portrait</span>
        ${counter ? `<span class="onb-portrait-edits-left${exhausted ? " is-spent" : ""}">${esc(counter)}</span>` : ""}
      </div>
      ${versionStrip}
      ${inputRow}
      ${foot}
    </div>`;
}

// Client-side validation for the "I'll upload my own" portrait path (owner
// spec: png/jpg/webp, 5MB cap, visible error on reject). Pure — takes the
// file's {name,type,size}; exported for tests.
export const PORTRAIT_UPLOAD_MAX_BYTES = 5 * 1024 * 1024;
const PORTRAIT_UPLOAD_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
export function validatePortraitUpload(file) {
  if (!file) {
    return { ok: false, error: "Choose an image file first." };
  }
  const type = String(file.type || "").toLowerCase();
  if (!PORTRAIT_UPLOAD_TYPES.has(type)) {
    return { ok: false, error: "That file type isn't supported. Use a PNG, JPG, or WEBP image." };
  }
  if (Number(file.size) > PORTRAIT_UPLOAD_MAX_BYTES) {
    return { ok: false, error: "That image is over the 5MB limit. Pick a smaller file." };
  }
  return { ok: true };
}

function renderCharIdentity(c, portrait = {}) {
  const mode = c.portraitMode || "generate";
  const uploadError = typeof portrait.uploadError === "string" ? portrait.uploadError : "";
  return `
    <div class="onb-identity">
      <div class="onb-identity-fields">
        <div class="onb-field"><label>Character name</label>
          <input data-cw-input="name" maxlength="60" placeholder="Ser Rowan Vale" value="${esc(c.name || "")}" /></div>
        ${(() => {
          // Declared pronouns: a REQUIRED He/She/They/Custom choice; defaults to
          // the owner default (he/him) so it is always committed. Gender derives
          // from it and is the SOLE portrait gender token (identity-as-state).
          const pron = c.pronouns || "he/him";
          const presets = ["he/him", "she/her", "they/them"];
          const isCustom = c.pronounsMode === "custom" || (Boolean(c.pronouns) && !presets.includes(c.pronouns));
          return `<div class="onb-field"><label>Pronouns</label>
          <div class="onb-chips">
            ${[["he/him", "He/him"], ["she/her", "She/her"], ["they/them", "They/them"]]
              .map(([v, l]) => renderChip(l, !isCustom && pron === v, `data-cw-pronouns="${v}"`))
              .join("")}
            ${renderChip("Custom", isCustom, 'data-cw-pronouns="custom"')}
          </div>
          ${isCustom ? `<input data-cw-input="pronouns" maxlength="30" placeholder="xe/xem" value="${esc(c.pronouns || "")}" />` : ""}
        </div>`;
        })()}
        ${(() => {
          // Declared BUILD / body type: a REQUIRED choice, defaults to Average
          // (Average renders NEUTRAL — no build token). Committed on the character
          // record; the SOLE source of the build token across every render lane,
          // and settable later from the character tab (identity-as-state).
          const presets = ["slim", "average", "athletic", "muscular", "heavyset"];
          const bt = (c.bodyType || "average").toLowerCase();
          const isCustom = c.bodyTypeMode === "custom" || (Boolean(c.bodyType) && !presets.includes(bt));
          return `<div class="onb-field"><label>Build</label>
          <div class="onb-chips">
            ${[["slim", "Slim"], ["average", "Average"], ["athletic", "Athletic"], ["muscular", "Muscular"], ["heavyset", "Heavyset"]]
              .map(([v, l]) => renderChip(l, !isCustom && bt === v, `data-cw-bodytype="${v}"`))
              .join("")}
            ${renderChip("Custom", isCustom, 'data-cw-bodytype="custom"')}
          </div>
          ${isCustom ? `<input data-cw-input="bodyType" maxlength="40" placeholder="e.g. lean and wiry" value="${esc(c.bodyType || "")}" />` : ""}
        </div>`;
        })()}
        <div class="onb-field"><label>Portrait</label>
          <div class="onb-chips">
            ${renderChip("Let the GM imagine them", mode === "generate", 'data-cw-portraitmode="generate"')}
            ${renderChip("I'll upload my own", mode === "upload", 'data-cw-portraitmode="upload"')}
          </div>
          ${
            mode === "upload"
              ? `<label class="onb-upload">
                   <input type="file" data-cw-portrait-file accept="image/png,image/jpeg,image/webp" />
                   <span>Choose an image (PNG, JPG, or WEBP · up to 5MB)</span>
                 </label>
                 ${uploadError ? `<small class="onb-upload-error" role="alert">${esc(uploadError)}</small>` : ""}
                 <small class="onb-hint">Your uploaded image will be your portrait.</small>`
              : `<small class="onb-hint">Your portrait is crafted from your race and class. It appears here as you choose them.</small>`
          }
        </div>
      </div>
      <div class="onb-identity-portrait">
        <div class="onb-kicker">Portrait preview</div>
        ${renderPortraitPreview(portrait, { charName: c.name, variant: "identity", portraitMode: mode })}
      </div>
    </div>`;
}

// "Homebrew" badge on custom (user-authored) option cards.
const HOMEBREW_TAG = `<span class="cw-homebrew-tag">Homebrew</span>`;

function raceCard(race, active, isCustom) {
  const bonuses = Object.entries(race.abilityBonuses || {}).map(([a, b]) => `+${b} ${ABILITY_LABELS[a] || a}`).join(", ");
  return `<button type="button" class="cw-card ${active ? "active" : ""}${isCustom ? " cw-card--homebrew" : ""}" data-cw-race="${esc(race.name)}">
      <div class="cw-card-title">${esc(race.name)}${isCustom ? ` ${HOMEBREW_TAG}` : ""}</div>
      <div class="cw-card-meta">Speed ${race.speed} · ${esc(race.size)} · ${esc(bonuses)}</div>
      <div class="cw-card-traits">${esc((race.traits || []).join(" · "))}</div>
    </button>`;
}

function classCard(cls, active, isCustom) {
  return `<button type="button" class="cw-card ${active ? "active" : ""}${isCustom ? " cw-card--homebrew" : ""}" data-cw-class="${esc(cls.name)}">
      <div class="cw-card-title">${esc(cls.name)}${isCustom ? ` ${HOMEBREW_TAG}` : ""}</div>
      <div class="cw-card-meta">Hit die ${esc(cls.hitDie)} · Primary ${ABILITY_LABELS[cls.primaryAbility] || cls.primaryAbility}</div>
      ${cls.description ? `<div class="cw-card-sub">${esc(cls.description)}</div>` : ""}
      <div class="cw-card-traits">${esc((cls.features || []).join(" · "))}</div>
    </button>`;
}

function backgroundCard(bg, active, isCustom) {
  return `<button type="button" class="cw-card ${active ? "active" : ""}${isCustom ? " cw-card--homebrew" : ""}" data-cw-background="${esc(bg.name)}">
      <div class="cw-card-title">${esc(bg.name)}${isCustom ? ` ${HOMEBREW_TAG}` : ""}</div>
      <div class="cw-card-meta">Skills: ${esc((bg.skillProficiencies || []).join(", "))}</div>
      <div class="cw-card-sub"><strong>${esc(bg.feature?.name || "")}</strong>${bg.feature?.description ? `: ${esc(bg.feature.description)}` : ""}</div>
    </button>`;
}

function renderCharRace(c, customRaces = []) {
  const srd = RACES.map((race) => raceCard(race, c.race === race.name, false)).join("");
  const custom = (Array.isArray(customRaces) ? customRaces : []).map((race) => raceCard(race, c.race === race.name, true)).join("");
  return `<div class="cw-grid">${srd}${custom}</div>`;
}

function renderCharClass(c, customClasses = []) {
  const srd = CLASSES.map((cls) => classCard(cls, c.characterClass === cls.name, false)).join("");
  const custom = (Array.isArray(customClasses) ? customClasses : []).map((cls) => classCard(cls, c.characterClass === cls.name, true)).join("");
  return `<div class="cw-grid">${srd}${custom}</div>`;
}

function renderCharBackground(c, customBackgrounds = []) {
  const srd = BACKGROUNDS.map((bg) => backgroundCard(bg, c.background === bg.name, false)).join("");
  const custom = (Array.isArray(customBackgrounds) ? customBackgrounds : []).map((bg) => backgroundCard(bg, c.background === bg.name, true)).join("");
  return `<div class="cw-grid">${srd}${custom}</div>`;
}

function renderCharAbilities(c, customContent = {}) {
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
      const opts = [`<option value="">·</option>`, ...pool.map((v) => `<option value="${v}" ${cur === v ? "selected" : ""}>${v}</option>`)].join("");
      return `<div class="cw-ability-row"><span class="cw-ab">${ABILITY_LABELS[a]}</span>
        <select data-cw-assign="${a}" ${pool.length ? "" : "disabled"}>${opts}</select>
        <span class="cw-mod">${cur != null ? formatModifier(abilityModifier(cur)) : ""}</span></div>`;
    }).join("");
  }

  // Live derived stats from the current (partial) choices, including custom content.
  const preview = buildCharacter({
    race: c.race,
    characterClass: c.characterClass,
    background: c.background,
    baseAbilityScores: scores
  }, { customContent });
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

function renderCharReview(c, portrait = {}, customContent = {}) {
  const sheet = buildCharacter({
    name: c.name,
    pronouns: c.pronouns,
    race: c.race,
    characterClass: c.characterClass,
    background: c.background,
    baseAbilityScores: c.baseAbilityScores || {}
  }, { customContent });
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
        <div class="cw-review-sub">${esc([sheet.race, sheet.class, sheet.background].filter(Boolean).join(" · ") || "·")} · Level ${sheet.level}</div>
        ${renderPortraitEditor(portrait)}
      </div>
      <div class="cw-ability-grid">${abilityCells}</div>
      <div class="cw-derived">
        <span><b>HP</b> ${ds.maxHp}</span><span><b>AC</b> ${ds.armorClass}</span><span><b>Speed</b> ${ds.speed}</span>
        <span><b>Init</b> ${formatModifier(ds.initiative)}</span><span><b>Passive</b> ${ds.passivePerception}</span><span><b>Prof</b> ${formatModifier(sheet.proficiencyBonus)}</span>
      </div>
      <div class="cw-review-block"><div class="onb-kicker">Saving Throws</div><div class="cw-review-row">${saves}</div></div>
      <div class="cw-review-block"><div class="onb-kicker">Skill Proficiencies</div><div class="cw-review-row">${skills}</div></div>
      <div class="cw-review-block"><div class="onb-kicker">Class Features</div><div class="cw-review-row">${(sheet.classFeatures || []).map((f) => `<span>${esc(f)}</span>`).join("") || "<span class='small'>·</span>"}</div></div>
      <div class="cw-review-block"><div class="onb-kicker">Racial Traits</div><div class="cw-review-row">${(sheet.racialTraits || []).map((t) => `<span>${esc(t)}</span>`).join("") || "<span class='small'>·</span>"}</div></div>
      <div class="cw-review-block"><div class="onb-kicker">Starting Equipment</div><div class="cw-review-row">${(sheet.startingEquipment || []).map((e) => `<span>${esc(e)}</span>`).join("") || "<span class='small'>·</span>"}</div></div>
    </div>`;
}

function renderCharacterWizard(state) {
  const c = state.character || {};
  const step = c.step || 1;
  // Steps 1 (Identity) and 6 (Review) both show the live mid-creation portrait;
  // its status lives on the onboarding state, not the character object.
  const portrait = {
    portraitUri: state.draftPortraitUri,
    portraitStatus: state.draftPortraitStatus,
    accepted: state.draftPortraitAccepted === true,
    // Conversational editor: version history + the entitlement-gated edit count.
    versions: Array.isArray(state.portraitVersions) ? state.portraitVersions : [],
    entitlement: state.portraitEntitlement || null,
    editDraft: typeof state.portraitEditDraft === "string" ? state.portraitEditDraft : "",
    editPending: state.portraitEditPending === true,
    editError: state.portraitEditError || "",
    consistentEdit: state.portraitConsistentEdit === true,
    // Upload-my-own path: the visible client-side validation error.
    uploadError: typeof state.portraitUploadError === "string" ? state.portraitUploadError : "",
    // FORENSICS: the classified reason a generation failed (server-provided).
    failReason: typeof state.portraitFailReason === "string" ? state.portraitFailReason : ""
  };
  // SRD-shaped custom content catalogs (from the user's homebrew); additive to SRD.
  const custom = state.customContent || {};
  // Authored worlds run a trimmed wizard (Identity → Origin → Review): the origin
  // is the world book's, not a 5e race/class, so the 5e Race/Class/Background/
  // Abilities steps (and their Speed/AC/ability-buy surfacing) never render.
  const authored = Boolean(state.worldDef?.scenarioId);
  const scenarioId = state.worldDef?.scenarioId || "";
  let body;
  if (authored) {
    if (step === 2) {
      body = renderAuthoredOrigin(c, scenarioId);
    } else if (step === 6) {
      body = renderAuthoredReview(c, portrait, scenarioId);
    } else {
      body = renderCharIdentity(c, portrait);
    }
  } else if (step === 2) {
    body = renderCharRace(c, custom.races);
  } else if (step === 3) {
    body = renderCharClass(c, custom.classes);
  } else if (step === 4) {
    body = renderCharBackground(c, custom.backgrounds);
  } else if (step === 5) {
    body = renderCharAbilities(c, custom);
  } else if (step === 6) {
    body = renderCharReview(c, portrait, custom);
  } else {
    body = renderCharIdentity(c, portrait);
  }
  const isLast = step === 6;
  // Style-lock law: the art-style picker rides the Review step (the last choice before
  // entering) for EVERY world — the card-led landing no longer carries it. A custom
  // world also picks its play mode (sandbox vs guided) here; authored worlds are set.
  if (isLast) {
    body += renderArtStylePicker(state.worldDef);
    if (!authored) body += renderStartModePicker(state.worldDef);
  }

  // Gate "Enter the World" on the three required character fields. Recomputed
  // every render, so the button re-enables live as the player fills fields in
  // (e.g. steps back to pick a race, returns to review). Back/nav are never
  // blocked — only the final submit.
  const missingRequirements = isLast
    ? [
        { ok: typeof c.name === "string" && c.name.trim().length > 0, label: "Enter a character name" },
        { ok: typeof c.pronouns === "string" && c.pronouns.trim().length > 0, label: "Choose pronouns" },
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
      ${renderWizardProgress(step, authored)}
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
        <button class="onb-primary" data-action="confirm-world" ${loading ? "disabled" : ""}>Looks good, create my character</button>
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

  if (step === "world_create") {
    return renderWorldCreator(onboardingState.worldCreator || {});
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
              placeholder="Reply, ask about your world, or test its memory..."
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

  // ---- Custom World creator (additive; no-ops unless the world_create step rendered) ----
  bindWorldCreator(root, handlers);

  // ---- World generator (Ticket 39) ----
  root.querySelectorAll("[data-world-tone]").forEach((button) => {
    button.addEventListener("click", () => handlers.onWorldField?.("tone", button.getAttribute("data-world-tone")));
  });
  root.querySelectorAll("[data-world-artstyle]").forEach((button) => {
    button.addEventListener("click", () => handlers.onWorldField?.("artStyle", button.getAttribute("data-world-artstyle")));
  });
  root.querySelectorAll("[data-world-mode]").forEach((button) => {
    button.addEventListener("click", () => handlers.onWorldField?.("startMode", button.getAttribute("data-world-mode")));
  });
  // Featured authored-world picker (e.g. Babel). Selecting one sets worldDef.scenarioId,
  // which the world-run POST forwards (and forces mode:"campaign"). "" clears it back
  // to a custom AI-generated world.
  root.querySelectorAll("[data-world-scenario]").forEach((button) => {
    button.addEventListener("click", () => handlers.onWorldField?.("scenarioId", button.getAttribute("data-world-scenario")));
  });
  // A user's own world card → straight into character creation for that world.
  root.querySelectorAll("[data-world-userworld]").forEach((button) => {
    button.addEventListener("click", () => handlers.onSelectUserWorld?.(button.getAttribute("data-world-userworld")));
  });
  // Library-first world-card art (art-plumbing item 3): consult the curated
  // library for a rated "keep" for this world and swap the static placeholder in
  // when one exists. Zero keeps (or any error) -> the committed static art stays
  // (zero behavior change until the owner rates a keep). Custom worlds (empty
  // scenarioId) have no library world to look up, so they are skipped.
  root.querySelectorAll("[data-world-scenario]").forEach((button) => {
    const world = button.getAttribute("data-world-scenario");
    const img = button.querySelector(".onb-world-card-art");
    if (!world || !img || typeof fetch !== "function") {
      return;
    }
    fetch(`/api/art/library?world=${encodeURIComponent(world)}&kind=world-card`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data && typeof data.uri === "string" && data.uri) {
          img.src = data.uri;
        }
      })
      .catch(() => { /* keep the static placeholder on any error */ });
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
  root.querySelectorAll("[data-cw-pronouns]").forEach((button) => {
    button.addEventListener("click", () => handlers.onCharPronouns?.(button.getAttribute("data-cw-pronouns")));
  });
  root.querySelectorAll("[data-cw-bodytype]").forEach((button) => {
    button.addEventListener("click", () => handlers.onCharBodyType?.(button.getAttribute("data-cw-bodytype")));
  });
  // Upload-my-own portrait: hand the chosen File to the app (validation +
  // upload live in main.js so errors surface in the preview state).
  root.querySelectorAll("[data-cw-portrait-file]").forEach((input) => {
    if (typeof input.addEventListener === "function") {
      input.addEventListener("change", (event) => handlers.onPortraitFile?.(event?.target?.files?.[0] || null));
    }
  });
  root.querySelectorAll("[data-cw-portrait-redo]").forEach((button) => {
    button.addEventListener("click", () => handlers.onPortraitRedo?.());
  });
  root.querySelectorAll("[data-cw-portrait-accept]").forEach((button) => {
    button.addEventListener("click", () => handlers.onPortraitAccept?.());
  });
  // Conversational portrait editor: chat input (Enter / Apply submits the tweak),
  // and the version-history thumbnails (click to revert to an earlier portrait).
  const portraitEditField = root.querySelectorAll("[data-cw-portrait-edit-input]")[0] || null;
  const submitPortraitEdit = () => handlers.onPortraitEdit?.(portraitEditField ? portraitEditField.value : "");
  root.querySelectorAll("[data-cw-portrait-edit-send]").forEach((button) => {
    button.addEventListener("click", submitPortraitEdit);
  });
  if (portraitEditField && typeof portraitEditField.addEventListener === "function") {
    portraitEditField.addEventListener("input", () => handlers.onPortraitEditInput?.(portraitEditField.value));
    portraitEditField.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        submitPortraitEdit();
      }
    });
  }
  root.querySelectorAll("[data-cw-portrait-revert]").forEach((button) => {
    button.addEventListener("click", () => handlers.onPortraitRevert?.(button.getAttribute("data-cw-portrait-revert")));
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

}
