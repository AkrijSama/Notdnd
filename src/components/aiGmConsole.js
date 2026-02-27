import { AI_SYSTEM_PROMPT_TEMPLATE, PLACEHOLDER_CONFIG } from "../data/placeholders.js";
import { formatNow } from "../utils/helpers.js";

function synthesizeGmReply(prompt, settings, campaignName) {
  const lower = prompt.toLowerCase();
  if (lower.includes("initiative")) {
    return `Initiative mode active. ${campaignName}: describe the battlefield, roll checks, and surface tactical prompts.`;
  }
  if (lower.includes("loot")) {
    return `${campaignName}: generate themed loot table using ${settings.primaryRulebook} constraints.`;
  }
  if (lower.includes("npc")) {
    return `${campaignName}: drafting NPC with motive, flaw, and leverage hook.`;
  }
  return `${settings.gmName}: framing next scene for ${campaignName}. Threat escalates, choice branches prepared.`;
}

export function renderAiGmConsole(state) {
  const selectedCampaign = state.campaigns.find((campaign) => campaign.id === state.selectedCampaignId) || state.campaigns[0];
  const settings = state.gmSettings;

  return `
    <section class="module-card">
      <div class="module-header">
        <h2>AI GM Console</h2>
        <span class="tag">Narration + image + voice placeholders</span>
      </div>

      <div class="grid-two">
        <article class="module-card">
          <h3>GM Runtime Settings</h3>
          <form id="gm-settings-form" class="field">
            <input name="gmName" value="${settings.gmName}" placeholder="GM name" />
            <input name="gmStyle" value="${settings.gmStyle}" placeholder="GM style" />
            <input name="safetyProfile" value="${settings.safetyProfile}" placeholder="Safety profile" />
            <input name="primaryRulebook" value="${settings.primaryRulebook}" placeholder="Primary rulebook" />
            <button type="submit">Apply Settings</button>
          </form>
          <div class="kv-item">
            <strong>System Prompt Template:</strong>
            <div class="small">${AI_SYSTEM_PROMPT_TEMPLATE}</div>
          </div>
          <div class="kv-item">
            <div><strong>Provider Placeholders</strong></div>
            <div class="small">GM: ${PLACEHOLDER_CONFIG.ai.gmProviderName} / ${PLACEHOLDER_CONFIG.ai.gmModelValue}</div>
            <div class="small">Image: ${PLACEHOLDER_CONFIG.ai.imageProviderName} / ${PLACEHOLDER_CONFIG.ai.imageModelValue}</div>
            <div class="small">Voice: ${PLACEHOLDER_CONFIG.ai.voiceProviderName} / ${PLACEHOLDER_CONFIG.ai.voiceModelValue}</div>
          </div>
        </article>

        <article class="module-card">
          <h3>Copilot Chat</h3>
          <div class="chat">
            ${state.chatLog
              .slice(-20)
              .map((line) => `<div class="chat-line"><b>${line.speaker}:</b> ${line.text}</div>`)
              .join("")}
          </div>
          <form id="gm-chat-form" class="inline">
            <input name="message" placeholder="Ask for scene framing, NPC reaction, encounter ruling..." style="flex:1; min-width: 220px;" />
            <button type="submit">Send</button>
          </form>
        </article>
      </div>

      <div class="grid-two">
        <article class="module-card">
          <h3>Media Generation Queue</h3>
          <div class="grid-two">
            <label class="field">
              <span>Provider</span>
              <select id="ai-provider">
                <option value="placeholder">placeholder</option>
                <option value="local-mock">local-mock</option>
                <option value="openai-compatible">openai-compatible</option>
              </select>
            </label>
            <label class="field">
              <span>Model</span>
              <input id="ai-model" placeholder="MODEL_VALUE_PLACEHOLDER" />
            </label>
          </div>
          <div class="inline">
            <button class="alt" data-job-type="image">Queue Scene Image</button>
            <button data-job-type="voice">Queue Voice Line</button>
          </div>
          <ul class="list">
            ${state.aiJobs.length === 0 ? `<li class="list-item">No jobs queued.</li>` : ""}
            ${state.aiJobs
              .slice(0, 10)
              .map(
                (job) => `
                  <li class="list-item">
                    <div class="inline">
                      <strong>${job.type.toUpperCase()}</strong>
                      <span class="tag">${job.status}</span>
                    </div>
                    <div class="small">Prompt: ${job.prompt}</div>
                  </li>
                `
              )
              .join("")}
          </ul>
        </article>

        <article class="module-card">
          <h3>Session Assist Snapshot</h3>
          <div class="kv-list">
            <div class="kv-item"><strong>Campaign:</strong> ${selectedCampaign?.name || "None"}</div>
            <div class="kv-item"><strong>Timestamp:</strong> ${formatNow()}</div>
            <div class="kv-item"><strong>Narration Mode:</strong> ${settings.gmStyle}</div>
            <div class="kv-item"><strong>Safety:</strong> ${settings.safetyProfile}</div>
          </div>
        </article>
      </div>
    </section>
  `;
}

export function bindAiGmConsole(root, store) {
  const settingsForm = root.querySelector("#gm-settings-form");
  if (settingsForm) {
    settingsForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const payload = new FormData(settingsForm);
      store.setGmSettings({
        gmName: String(payload.get("gmName") || ""),
        gmStyle: String(payload.get("gmStyle") || ""),
        safetyProfile: String(payload.get("safetyProfile") || ""),
        primaryRulebook: String(payload.get("primaryRulebook") || "")
      });
      store.pushChatLine({ speaker: "System", text: "GM runtime settings updated." });
    });
  }

  const chatForm = root.querySelector("#gm-chat-form");
  if (chatForm) {
    chatForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const payload = new FormData(chatForm);
      const message = String(payload.get("message") || "").trim();
      if (!message) {
        return;
      }
      const state = store.getState();
      const selectedCampaign = state.campaigns.find((campaign) => campaign.id === state.selectedCampaignId) || state.campaigns[0];
      store.pushChatLine({ speaker: "User", text: message });
      const reply = synthesizeGmReply(message, state.gmSettings, selectedCampaign?.name || "Current Campaign");
      store.pushChatLine({ speaker: state.gmSettings.gmName || "AI GM", text: reply });
      chatForm.reset();
    });
  }

  root.querySelectorAll("[data-job-type]").forEach((button) => {
    button.addEventListener("click", () => {
      const type = String(button.getAttribute("data-job-type"));
      const state = store.getState();
      const selectedCampaign = state.campaigns.find((campaign) => campaign.id === state.selectedCampaignId) || state.campaigns[0];
      const prompt = `${selectedCampaign?.name || "Campaign"}: ${type} generation placeholder prompt.`;
      const providerName = String(root.querySelector("#ai-provider")?.value || "placeholder");
      const modelValue = String(root.querySelector("#ai-model")?.value || "");
      store.queueAiJob({ type, prompt, providerName, modelValue });
    });
  });
}
