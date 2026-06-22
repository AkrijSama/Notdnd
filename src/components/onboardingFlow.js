function renderMessages(messages = []) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return `<div class="onboarding-empty">No messages yet.</div>`;
  }

  return messages
    .map((entry) => {
      const role = entry.role === "user" ? "user" : "assistant";
      return `<article class="onboarding-message ${role}">
        <div class="onboarding-message-role">${role === "user" ? "You" : "Mira"}</div>
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
          ${thinking ? `<div class="onboarding-thinking">Mira studies your words...</div>` : ""}
        </div>

        <form id="onboarding-chat-form" class="onboarding-form">
          <label>
            <span>Your response</span>
            <input
              name="message"
              maxlength="600"
              placeholder="Reply to Mira, ask about Ashenmoor, or test the world's memory..."
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

      ${loading ? `<div class="onboarding-thinking">The world is forming around you...</div>` : ""}
      ${error ? `<div class="onboarding-error">${error}</div>` : ""}
    </section>
  `;
}

export function bindOnboardingFlow(root, handlers = {}) {
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
