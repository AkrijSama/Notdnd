import { formatNow } from "../utils/helpers.js";

function providerOptions(state) {
  if (Array.isArray(state.aiProviders) && state.aiProviders.length > 0) {
    return state.aiProviders;
  }
  return [
    { key: "local", label: "Local Model", status: "ready", models: { gm: "local-gm-v1" } },
    { key: "chatgpt", label: "ChatGPT", status: "missing-api-key", models: { gm: "gpt-5-mini" } },
    { key: "grok", label: "Grok", status: "missing-api-key", models: { gm: "grok-4-fast-reasoning" } },
    { key: "gemini", label: "Gemini", status: "missing-api-key", models: { gm: "gemini-2.5-flash" } },
    { key: "placeholder", label: "Placeholder", status: "ready", models: { gm: "AI_GM_MODEL_VALUE" } }
  ];
}

function selectedCampaign(state) {
  return state.campaigns.find((campaign) => campaign.id === state.selectedCampaignId) || state.campaigns[0] || null;
}

function renderProviderStatus(provider) {
  const status = provider.status || "unknown";
  return `<div class="small"><strong>${provider.label}</strong>: ${status}${provider.apiKeyEnv ? ` | key env ${provider.apiKeyEnv}` : ""}</div>`;
}

function renderMemoryDocs(state) {
  const docs = state.gmMemoryDocsByCampaign?.[state.selectedCampaignId] || [];
  if (docs.length === 0) {
    return `<div class="small">No GM memory docs loaded yet.</div>`;
  }

  return docs
    .map(
      (doc) => `
        <article class="module-card">
          <div class="module-header">
            <h3>${doc.title}</h3>
            <span class="tag">${doc.key}.md</span>
          </div>
          <div class="small">${doc.path}</div>
          <textarea data-memory-doc="${doc.key}" rows="10">${doc.content}</textarea>
          <div class="inline">
            <button class="ghost" data-save-memory="${doc.key}">Save ${doc.key}.md</button>
            <span class="small">Updated ${new Date(doc.updatedAt || Date.now()).toLocaleString()}</span>
          </div>
        </article>
      `
    )
    .join("");
}

function renderMemorySearch(state) {
  const results = state.gmMemorySearchResults || [];
  return `
    <form id="gm-memory-search-form" class="field">
      <span>Smart Keyword Retrieval</span>
      <div class="inline">
        <input name="query" placeholder="Search plot device, NPC, scene, consequence..." style="flex:1; min-width: 220px;" />
        <button type="submit" class="ghost">Search Memory</button>
      </div>
    </form>
    <ul class="list">
      ${results.length === 0 ? `<li class="list-item">No retrieval results yet.</li>` : ""}
      ${results
        .map(
          (result) => `
            <li class="list-item">
              <div class="inline"><strong>${result.docKey}</strong><span class="tag">${result.heading}</span><span class="tag">score ${result.score}</span></div>
              <div class="small">${result.text}</div>
            </li>
          `
        )
        .join("")}
    </ul>
  `;
}

function renderPackageSnapshot(state) {
  const pkg = state.campaignPackagesByCampaign?.[state.selectedCampaignId] || {
    scenes: [],
    npcs: [],
    items: [],
    rules: [],
    starterOptions: []
  };

  return `
    <div class="kv-list">
      <div class="kv-item"><strong>Scenes:</strong> ${(pkg.scenes || []).slice(0, 4).map((scene) => scene.name).join(", ") || "None"}</div>
      <div class="kv-item"><strong>NPCs:</strong> ${(pkg.npcs || []).slice(0, 5).map((npc) => npc.name).join(", ") || "None"}</div>
      <div class="kv-item"><strong>Items:</strong> ${(pkg.items || []).slice(0, 5).map((item) => item.name).join(", ") || "None"}</div>
      <div class="kv-item"><strong>Rules:</strong> ${(pkg.rules || []).slice(0, 5).map((rule) => rule.name).join(", ") || "None"}</div>
      <div class="kv-item"><strong>Starter Options:</strong> ${(pkg.starterOptions || []).slice(0, 4).map((entry) => entry.className).join(", ") || "None"}</div>
    </div>
  `;
}

export function renderAiGmConsole(state) {
  const campaign = selectedCampaign(state);
  const settings = state.gmSettings || {};
  const providers = providerOptions(state);
  const currentProvider = providers.find((provider) => provider.key === settings.agentProvider) || providers[0];
  const lastMeta = state.gmLastResponseMeta;

  return `
    <section class="module-card">
      <div class="module-header">
        <h2>GM Runtime</h2>
        <span class="tag">Human assist + Agent GM + markdown memory</span>
      </div>

      <div class="grid-two">
        <article class="module-card">
          <h3>Mode + Provider</h3>
          <form id="gm-settings-form" class="field">
            <label class="field">
              <span>GM Mode</span>
              <select name="gmMode">
                <option value="human" ${settings.gmMode !== "agent" ? "selected" : ""}>Human GM</option>
                <option value="agent" ${settings.gmMode === "agent" ? "selected" : ""}>Agent GM</option>
              </select>
            </label>
            <input name="gmName" value="${settings.gmName || "Narrator Prime"}" placeholder="GM name" />
            <input name="gmStyle" value="${settings.gmStyle || "Cinematic Tactical"}" placeholder="GM style" />
            <input name="safetyProfile" value="${settings.safetyProfile || "Table-Friendly"}" placeholder="Safety profile" />
            <input name="primaryRulebook" value="${settings.primaryRulebook || "Core Rules SRD"}" placeholder="Primary rulebook" />
            <label class="field">
              <span>Agent Provider</span>
              <select name="agentProvider" id="agent-provider-select">
                ${providers.map((provider) => `<option value="${provider.key}" ${provider.key === settings.agentProvider ? "selected" : ""}>${provider.label}</option>`).join("")}
              </select>
            </label>
            <input name="agentModel" id="agent-model-input" value="${settings.agentModel || currentProvider?.models?.gm || ""}" placeholder="GM model" />
            <button type="submit">Apply Runtime Settings</button>
          </form>
          <div class="kv-item"><strong>Campaign:</strong> ${campaign?.name || "None"}</div>
          <div class="kv-item"><strong>Timestamp:</strong> ${formatNow()}</div>
          <div class="kv-item"><strong>Last GM Response:</strong> ${lastMeta ? `${lastMeta.mode} via ${lastMeta.provider}/${lastMeta.model}` : "None yet"}</div>
          <div class="kv-item"><strong>Package Snapshot:</strong>${renderPackageSnapshot(state)}</div>
        </article>

        <article class="module-card">
          <h3>${settings.gmMode === "agent" ? "Agent GM" : "Human GM Assist"}</h3>
          <div class="small" id="gm-runtime-status">Mode ${settings.gmMode === "agent" ? "Agent GM" : "Human GM"} ready.</div>
          <div class="chat">
            ${state.chatLog
              .slice(-20)
              .map((line) => `<div class="chat-line"><b>${line.speaker}:</b> ${line.text}</div>`)
              .join("")}
          </div>
          <form id="gm-chat-form" class="inline">
            <input name="message" placeholder="${settings.gmMode === "agent" ? "Prompt the Agent GM..." : "Ask for rulings, pacing help, or next-scene support..."}" style="flex:1; min-width: 220px;" />
            <button type="submit">${settings.gmMode === "agent" ? "Run Agent GM" : "Assist Human GM"}</button>
          </form>
          <div class="small">Nothing fails silently. Provider and API key errors are shown here immediately.</div>
          <div class="kv-list">
            ${providers.map(renderProviderStatus).join("")}
          </div>
        </article>
      </div>

      <div class="grid-two">
        <article class="module-card">
          <h3>GM Memory Docs</h3>
          <div class="small">Filesystem-backed markdown lives per campaign and is used by smart retrieval instead of loading the full document every time.</div>
          ${renderMemoryDocs(state)}
        </article>

        <article class="module-card">
          <h3>Retrieval + Media Queue</h3>
          ${renderMemorySearch(state)}
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
                    <div class="small">Provider ${job.providerName || "n/a"} | Model ${job.modelValue || "default"}</div>
                    <div class="small">Prompt: ${job.prompt}</div>
                    ${job.result?.error ? `<div class="small">Error: ${job.result.error}</div>` : ""}
                  </li>
                `
              )
              .join("")}
          </ul>
        </article>
      </div>
    </section>
  `;
}

export function bindAiGmConsole(root, store) {
  const state = store.getState();
  const settingsForm = root.querySelector("#gm-settings-form");
  const statusEl = root.querySelector("#gm-runtime-status");
  const providerSelect = root.querySelector("#agent-provider-select");
  const modelInput = root.querySelector("#agent-model-input");

  function setStatus(message) {
    if (statusEl) {
      statusEl.textContent = message;
    }
  }

  store.loadAiProviders().catch((error) => {
    setStatus(`Provider load failed: ${String(error.message || error)}`);
  });
  if (state.selectedCampaignId) {
    store.loadGmMemoryDocs(state.selectedCampaignId).catch((error) => {
      setStatus(`Memory doc load failed: ${String(error.message || error)}`);
    });
  }

  if (providerSelect && modelInput) {
    providerSelect.addEventListener("change", () => {
      const provider = (store.getState().aiProviders || []).find((entry) => entry.key === providerSelect.value);
      if (provider && !modelInput.value.trim()) {
        modelInput.value = provider.models?.gm || "";
      }
    });
  }

  if (settingsForm) {
    settingsForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const payload = new FormData(settingsForm);
      store.setGmSettings({
        gmMode: String(payload.get("gmMode") || "human"),
        gmName: String(payload.get("gmName") || ""),
        gmStyle: String(payload.get("gmStyle") || ""),
        safetyProfile: String(payload.get("safetyProfile") || ""),
        primaryRulebook: String(payload.get("primaryRulebook") || ""),
        agentProvider: String(payload.get("agentProvider") || "local"),
        agentModel: String(payload.get("agentModel") || "")
      });
      setStatus("GM runtime settings updated.");
    });
  }

  const chatForm = root.querySelector("#gm-chat-form");
  if (chatForm) {
    chatForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const payload = new FormData(chatForm);
      const message = String(payload.get("message") || "").trim();
      if (!message) {
        setStatus("Enter a message first.");
        return;
      }

      const nextState = store.getState();
      try {
        setStatus(`${nextState.gmSettings.gmMode === "agent" ? "Agent GM" : "Human GM assist"} is responding...`);
        const response = await store.requestGmResponse({
          message,
          mode: nextState.gmSettings.gmMode,
          provider: nextState.gmSettings.agentProvider,
          model: nextState.gmSettings.agentModel
        });
        setStatus(`${response.mode} response ready via ${response.result?.provider || "unknown"}/${response.result?.model || "default"}.`);
        chatForm.reset();
      } catch (error) {
        setStatus(`GM response failed: ${String(error.message || error)}`);
      }
    });
  }

  root.querySelectorAll("[data-save-memory]").forEach((button) => {
    button.addEventListener("click", async () => {
      const docKey = String(button.getAttribute("data-save-memory") || "");
      const textarea = root.querySelector(`[data-memory-doc="${docKey}"]`);
      if (!docKey || !textarea) {
        return;
      }
      try {
        setStatus(`Saving ${docKey}.md...`);
        await store.saveGmMemoryDoc({
          docKey,
          content: textarea.value
        });
        setStatus(`${docKey}.md saved.`);
      } catch (error) {
        setStatus(`Save failed for ${docKey}.md: ${String(error.message || error)}`);
      }
    });
  });

  const memorySearchForm = root.querySelector("#gm-memory-search-form");
  if (memorySearchForm) {
    memorySearchForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const payload = new FormData(memorySearchForm);
      const query = String(payload.get("query") || "").trim();
      if (!query) {
        setStatus("Enter keywords to search GM memory.");
        return;
      }
      try {
        setStatus("Searching GM memory...");
        const results = await store.searchGmMemory({ query });
        setStatus(`Retrieved ${results.length} matching memory section(s).`);
      } catch (error) {
        setStatus(`Memory search failed: ${String(error.message || error)}`);
      }
    });
  }

  root.querySelectorAll("[data-job-type]").forEach((button) => {
    button.addEventListener("click", () => {
      const type = String(button.getAttribute("data-job-type"));
      const nextState = store.getState();
      const campaign = selectedCampaign(nextState);
      const prompt = `${campaign?.name || "Campaign"}: ${type} generation for ${nextState.gmSettings.gmMode === "agent" ? "agent gm" : "human gm assist"}.`;
      store.queueAiJob({
        type,
        prompt,
        providerName: nextState.gmSettings.agentProvider,
        modelValue: nextState.gmSettings.agentModel
      });
      setStatus(`${type} job queued.`);
    });
  });
}
