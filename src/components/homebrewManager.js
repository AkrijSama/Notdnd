// Manage Homebrew: forms to manually author custom races, classes, backgrounds,
// subclasses, and feats (no source PDF), plus a list of the user's existing
// content with edit/delete. The server validates + sanitizes on save; this
// component just shapes the form values into the API payload.

import { ABILITIES, ABILITY_LABELS } from "../../server/solo/dndData.js";

const TYPE_LABELS = {
  race: "Race",
  class: "Class",
  background: "Background",
  subclass: "Subclass",
  feat: "Feat"
};
const HOMEBREW_TYPES = ["race", "class", "background", "subclass", "feat"];
const HIT_DICE = ["d4", "d6", "d8", "d10", "d12"];

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---- form value parsing (form draft -> API item payload) ------------------

function csv(text) {
  return String(text || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function lines(text) {
  return String(text || "")
    .split(/\n+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

// "Name: description" per line -> [{ name, description }].
function linesToNamed(text) {
  return lines(text).map((line) => {
    const idx = line.indexOf(":");
    if (idx === -1) {
      return { name: line, description: "" };
    }
    return { name: line.slice(0, idx).trim(), description: line.slice(idx + 1).trim() };
  });
}

/**
 * Converts the string-keyed form draft into the item payload shape the server's
 * validateCustomItem expects. Pure.
 */
export function homebrewDraftToItem(type, draft = {}) {
  const d = draft || {};
  const base = { type, name: d.name || "" };
  if (type === "race") {
    const abilityBonuses = {};
    for (const ability of ABILITIES) {
      const n = Math.trunc(Number(d[`ab_${ability}`]));
      if (Number.isFinite(n) && n !== 0) {
        abilityBonuses[ability] = n;
      }
    }
    return {
      ...base,
      abilityBonuses,
      size: d.size || "Medium",
      speed: Number(d.speed) || 30,
      traits: linesToNamed(d.traits),
      languages: csv(d.languages)
    };
  }
  if (type === "class") {
    return {
      ...base,
      hitDie: d.hitDie || "d8",
      primaryAbility: d.primaryAbility || "strength",
      savingThrows: csv(d.savingThrows).map((s) => s.toLowerCase()),
      armorProficiencies: csv(d.armorProficiencies),
      weaponProficiencies: csv(d.weaponProficiencies),
      skillCount: Number(d.skillCount) || 2,
      skillList: csv(d.skillList),
      startingEquipment: lines(d.startingEquipment),
      features: linesToNamed(d.features)
    };
  }
  if (type === "background") {
    return {
      ...base,
      skillProficiencies: csv(d.skillProficiencies),
      toolProficiencies: csv(d.toolProficiencies),
      languages: csv(d.languages),
      startingEquipment: lines(d.startingEquipment),
      feature: { name: d.featureName || "", description: d.featureDescription || "" }
    };
  }
  if (type === "subclass") {
    return { ...base, parentClass: d.parentClass || "", features: linesToNamed(d.features) };
  }
  // feat
  return { ...base, prerequisite: d.prerequisite || "", description: d.description || "", mechanicalEffect: d.effect || "" };
}

// ---- rendering ------------------------------------------------------------

function field(label, key, value, { placeholder = "", textarea = false, hint = "" } = {}) {
  const input = textarea
    ? `<textarea class="hb-input" data-hb-field="${key}" placeholder="${esc(placeholder)}">${esc(value || "")}</textarea>`
    : `<input class="hb-input" data-hb-field="${key}" value="${esc(value || "")}" placeholder="${esc(placeholder)}" />`;
  return `<label class="hb-label"><span>${esc(label)}</span>${input}${hint ? `<small class="hb-hint">${esc(hint)}</small>` : ""}</label>`;
}

function renderForm(type, draft) {
  const d = draft || {};
  if (type === "race") {
    const abilityInputs = ABILITIES.map(
      (a) => `<label class="hb-ability"><span>${esc(ABILITY_LABELS[a])}</span>
        <input class="hb-input hb-num" type="number" data-hb-field="ab_${a}" value="${esc(d[`ab_${a}`] || "")}" placeholder="0" /></label>`
    ).join("");
    return `
      ${field("Name", "name", d.name, { placeholder: "Stoneborn" })}
      <div class="hb-field-group"><span class="hb-group-label">Ability Score Increases</span><div class="hb-ability-grid">${abilityInputs}</div></div>
      ${field("Size", "size", d.size, { placeholder: "Medium" })}
      ${field("Speed", "speed", d.speed, { placeholder: "30" })}
      ${field("Traits (one per line, \"Name: description\")", "traits", d.traits, { textarea: true, placeholder: "Darkvision: See 60ft in the dark." })}
      ${field("Languages (comma-separated)", "languages", d.languages, { placeholder: "Common, Terran" })}
    `;
  }
  if (type === "class") {
    const hitDieOpts = HIT_DICE.map((hd) => `<option value="${hd}" ${(d.hitDie || "d8") === hd ? "selected" : ""}>${hd}</option>`).join("");
    const abilityOpts = ABILITIES.map((a) => `<option value="${a}" ${(d.primaryAbility || "strength") === a ? "selected" : ""}>${esc(ABILITY_LABELS[a])}</option>`).join("");
    return `
      ${field("Name", "name", d.name, { placeholder: "Warden" })}
      <label class="hb-label"><span>Hit Die</span><select class="hb-input" data-hb-field="hitDie">${hitDieOpts}</select></label>
      <label class="hb-label"><span>Primary Ability</span><select class="hb-input" data-hb-field="primaryAbility">${abilityOpts}</select></label>
      ${field("Saving Throw Proficiencies (comma, e.g. constitution, strength)", "savingThrows", d.savingThrows, { placeholder: "constitution, strength" })}
      ${field("Armor Proficiencies (comma)", "armorProficiencies", d.armorProficiencies, { placeholder: "Light armor, Shields" })}
      ${field("Weapon Proficiencies (comma)", "weaponProficiencies", d.weaponProficiencies, { placeholder: "Simple weapons" })}
      ${field("Skill Choices (count)", "skillCount", d.skillCount, { placeholder: "2" })}
      ${field("Skill List (comma)", "skillList", d.skillList, { placeholder: "Athletics, Nature, Survival" })}
      ${field("Starting Equipment (one per line)", "startingEquipment", d.startingEquipment, { textarea: true, placeholder: "Spear\\nShield" })}
      ${field("Level-1 Features (one per line, \"Name: description\")", "features", d.features, { textarea: true, placeholder: "Bark Skin: +1 AC while unarmored." })}
    `;
  }
  if (type === "background") {
    return `
      ${field("Name", "name", d.name, { placeholder: "Tomb Robber" })}
      ${field("Skill Proficiencies (comma)", "skillProficiencies", d.skillProficiencies, { placeholder: "Stealth, Investigation" })}
      ${field("Tool Proficiencies (comma)", "toolProficiencies", d.toolProficiencies, { placeholder: "Thieves' tools" })}
      ${field("Languages (comma)", "languages", d.languages, { placeholder: "One of your choice" })}
      ${field("Starting Equipment (one per line)", "startingEquipment", d.startingEquipment, { textarea: true, placeholder: "Crowbar\\nLantern" })}
      ${field("Feature Name", "featureName", d.featureName, { placeholder: "Grave Sense" })}
      ${field("Feature Description", "featureDescription", d.featureDescription, { textarea: true, placeholder: "You feel where the dead were laid." })}
    `;
  }
  if (type === "subclass") {
    return `
      ${field("Parent Class", "parentClass", d.parentClass, { placeholder: "Druid" })}
      ${field("Name", "name", d.name, { placeholder: "Circle of the Storm" })}
      ${field("Features (one per line, \"Name: description\")", "features", d.features, { textarea: true, placeholder: "Thunderstep: Teleport 30ft as a bonus action." })}
    `;
  }
  // feat
  return `
    ${field("Name", "name", d.name, { placeholder: "Ironhide" })}
    ${field("Prerequisite", "prerequisite", d.prerequisite, { placeholder: "Constitution 13 or higher" })}
    ${field("Description", "description", d.description, { textarea: true, placeholder: "Your skin hardens like bark." })}
    ${field("Mechanical Effect", "effect", d.effect, { placeholder: "+1 AC" })}
  `;
}

function summarizeItem(item) {
  if (item.type === "race") {
    const bonuses = Object.entries(item.abilityBonuses || {}).map(([a, b]) => `+${b} ${ABILITY_LABELS[a] || a}`).join(", ");
    return `Speed ${item.speed} · ${esc(item.size || "Medium")}${bonuses ? ` · ${esc(bonuses)}` : ""}`;
  }
  if (item.type === "class") {
    return `Hit die ${esc(item.hitDie || "")} · Primary ${esc(ABILITY_LABELS[item.primaryAbility] || item.primaryAbility || "")}`;
  }
  if (item.type === "background") {
    return `${esc((item.skillProficiencies || []).join(", "))}${item.feature?.name ? ` · ${esc(item.feature.name)}` : ""}`;
  }
  if (item.type === "subclass") {
    return `Parent: ${esc(item.parentClass || "")}`;
  }
  return esc(item.prerequisite ? `Prereq: ${item.prerequisite}` : "Feat");
}

function renderItemList(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return `<p class="hb-empty">No custom content yet. Create your first homebrew on the left.</p>`;
  }
  return HOMEBREW_TYPES.map((type) => {
    const group = items.filter((item) => item.type === type);
    if (group.length === 0) {
      return "";
    }
    const cards = group
      .map(
        (item) => `
        <div class="hb-item">
          <div class="hb-item-main">
            <strong>${esc(item.name)}</strong>
            <span class="hb-item-summary">${summarizeItem(item)}</span>
          </div>
          <div class="hb-item-actions">
            <button type="button" class="ghost hb-edit" data-hb-edit="${esc(item.id)}">Edit</button>
            <button type="button" class="ghost hb-delete" data-hb-delete="${esc(item.id)}">Delete</button>
          </div>
        </div>`
      )
      .join("");
    return `<div class="hb-group"><h4>${esc(TYPE_LABELS[type])}s</h4>${cards}</div>`;
  }).join("");
}

export function renderHomebrewManager(state = {}) {
  const hb = state.homebrew || {};
  const type = HOMEBREW_TYPES.includes(hb.type) ? hb.type : "race";
  const tabs = HOMEBREW_TYPES.map(
    (t) => `<button type="button" class="hb-tab ${t === type ? "active" : ""}" data-hb-type="${t}">${esc(TYPE_LABELS[t])}</button>`
  ).join("");
  const editing = Boolean(hb.editingId);

  return `
    <main class="panel main hb-main">
      <section class="hb-shell">
        <header class="hb-header">
          <div>
            <div class="tag">Homebrew</div>
            <h2>Manage Custom Content</h2>
            <p class="hb-sub">Author your own races, classes, backgrounds, subclasses, and feats — no source document needed. They appear in the character creator alongside the SRD options.</p>
          </div>
          <button type="button" class="ghost" data-hb-close>Done</button>
        </header>
        <div class="hb-body">
          <div class="hb-form-col">
            <div class="hb-tabs">${tabs}</div>
            <form class="hb-form" data-hb-form>
              ${renderForm(type, hb.draft)}
              ${hb.error ? `<div class="hb-error" role="alert">${esc(hb.error)}</div>` : ""}
              <div class="hb-form-actions">
                <button type="submit" class="onb-primary hb-submit" data-hb-submit ${hb.saving ? "disabled" : ""}>${hb.saving ? "Saving…" : editing ? "Save changes" : `Create ${TYPE_LABELS[type]}`}</button>
                ${editing ? `<button type="button" class="ghost" data-hb-cancel>Cancel edit</button>` : ""}
              </div>
            </form>
          </div>
          <div class="hb-list-col">
            <h3>Your Custom Content</h3>
            ${renderItemList(state.customContentItems || [])}
          </div>
        </div>
      </section>
    </main>
  `;
}

export function bindHomebrewManager(root, handlers = {}) {
  if (!root || typeof root.querySelectorAll !== "function") {
    return;
  }
  root.querySelectorAll("[data-hb-type]").forEach((button) => {
    button.addEventListener("click", () => handlers.onType?.(button.getAttribute("data-hb-type")));
  });
  root.querySelectorAll("[data-hb-field]").forEach((input) => {
    const key = input.getAttribute("data-hb-field");
    const evt = input.tagName === "SELECT" ? "change" : "input";
    input.addEventListener(evt, () => handlers.onField?.(key, input.value));
  });
  const form = root.querySelector("[data-hb-form]");
  if (form) {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      handlers.onSubmit?.();
    });
  }
  root.querySelectorAll("[data-hb-cancel]").forEach((button) => {
    button.addEventListener("click", () => handlers.onCancelEdit?.());
  });
  root.querySelectorAll("[data-hb-edit]").forEach((button) => {
    button.addEventListener("click", () => handlers.onEdit?.(button.getAttribute("data-hb-edit")));
  });
  root.querySelectorAll("[data-hb-delete]").forEach((button) => {
    button.addEventListener("click", () => handlers.onDelete?.(button.getAttribute("data-hb-delete")));
  });
  const close = root.querySelector("[data-hb-close]");
  if (close) {
    close.addEventListener("click", () => handlers.onClose?.());
  }
}

// Converts a stored item back into the string-keyed form draft (for editing).
export function itemToDraft(item = {}) {
  const d = { name: item.name || "" };
  if (item.type === "race") {
    for (const ability of ABILITIES) {
      const v = item.abilityBonuses?.[ability];
      if (v) {
        d[`ab_${ability}`] = String(v);
      }
    }
    d.size = item.size || "";
    d.speed = item.speed != null ? String(item.speed) : "";
    d.traits = (item.traits || []).map((t) => (t.description ? `${t.name}: ${t.description}` : t.name)).join("\n");
    d.languages = (item.languages || []).join(", ");
  } else if (item.type === "class") {
    d.hitDie = item.hitDie || "d8";
    d.primaryAbility = item.primaryAbility || "strength";
    d.savingThrows = (item.savingThrows || []).join(", ");
    d.armorProficiencies = (item.armorProficiencies || []).join(", ");
    d.weaponProficiencies = (item.weaponProficiencies || []).join(", ");
    d.skillCount = item.skillCount != null ? String(item.skillCount) : "";
    d.skillList = (item.skillList || []).join(", ");
    d.startingEquipment = (item.startingEquipment || []).join("\n");
    d.features = (item.features || []).map((f) => (f.description ? `${f.name}: ${f.description}` : f.name)).join("\n");
  } else if (item.type === "background") {
    d.skillProficiencies = (item.skillProficiencies || []).join(", ");
    d.toolProficiencies = (item.toolProficiencies || []).join(", ");
    d.languages = (item.languages || []).join(", ");
    d.startingEquipment = (item.equipment || []).join("\n");
    d.featureName = item.feature?.name || "";
    d.featureDescription = item.feature?.description || "";
  } else if (item.type === "subclass") {
    d.parentClass = item.parentClass || "";
    d.features = (item.features || []).map((f) => (f.description ? `${f.name}: ${f.description}` : f.name)).join("\n");
  } else if (item.type === "feat") {
    d.prerequisite = item.prerequisite || "";
    d.description = item.description || "";
    d.effect = item.effect || "";
  }
  return d;
}

export { HOMEBREW_TYPES };
