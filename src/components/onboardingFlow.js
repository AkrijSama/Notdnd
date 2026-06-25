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
