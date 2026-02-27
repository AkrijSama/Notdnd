import { parseList, titleCase } from "../utils/helpers.js";

function renderEntityList(title, values) {
  const items = (values || []).slice(0, 6);
  return `
    <div class="kv-item">
      <strong>${title} (${values.length})</strong>
      <div class="small">${items.length > 0 ? items.join(", ") : "None extracted"}</div>
    </div>
  `;
}

function renderQuickstartReview(parsed) {
  if (!parsed) {
    return `<div class="small">No parse run yet. Click <strong>Parse & Review</strong>.</div>`;
  }

  const summary = parsed.summary || {};
  const confidence = parsed.confidence || { score: 0, band: "low", warnings: [] };
  const diagnostics = parsed.diagnostics || [];

  return `
    <div class="kv-list">
      <div class="kv-item"><strong>Confidence:</strong> ${confidence.score}/100 (${confidence.band})</div>
      <div class="kv-item"><strong>Documents:</strong> ${summary.documents || 0} | Books: ${summary.books || 0}</div>
      <div class="kv-item"><strong>Extracted:</strong> ${summary.classes || 0} classes, ${summary.monsters || 0} monsters, ${summary.spells || 0} spells</div>
      ${renderEntityList("Classes", parsed.entities?.classes || [])}
      ${renderEntityList("Monsters", parsed.entities?.monsters || [])}
      ${renderEntityList("Spells", parsed.entities?.spells || [])}
      ${renderEntityList("NPCs", parsed.entities?.npcs || [])}
      ${renderEntityList("Locations", parsed.entities?.locations || [])}
      <div class="kv-item"><strong>Warnings:</strong> ${(confidence.warnings || []).length > 0 ? confidence.warnings.join(" | ") : "None"}</div>
      <div class="kv-item"><strong>Diagnostics:</strong> ${diagnostics
        .map((entry) => `${entry.name}: ${entry.status}${entry.canonical ? " (canonical)" : ""}`)
        .join(" | ")}</div>
    </div>
  `;
}

export function renderCampaignForge(state) {
  return `
    <section class="module-card">
      <div class="module-header">
        <h2>Campaign Forge</h2>
        <span class="tag">D&D Beyond style builder + Roll20 handoff</span>
      </div>

      <div class="grid-two">
        <form class="module-card" id="campaign-form">
          <h3>Ready-in-Minutes Wizard</h3>

          <label class="field">
            <span>Campaign Name</span>
            <input required name="name" placeholder="Stormhold Reclamation" />
          </label>

          <label class="field">
            <span>Setting</span>
            <input required name="setting" placeholder="Eberron Noir" />
          </label>

          <label class="field">
            <span>Players (comma-separated)</span>
            <input name="players" placeholder="Kai, Rune, Tessa" />
          </label>

          <label class="field">
            <span>Primary Source Book</span>
            <select required name="bookId">
              ${state.books.map((book) => `<option value="${book.id}">${book.title} (${book.type})</option>`).join("")}
            </select>
          </label>

          <div class="inline">
            <button type="submit">Create Campaign</button>
            <button class="ghost" type="button" data-action="generate-template">Generate Starter Template</button>
          </div>
        </form>

        <article class="module-card">
          <h3>Blueprint Mechanics</h3>
          <ul class="list">
            <li class="list-item">Rules + homebrew books in one compendium graph.</li>
            <li class="list-item">Character sheets linked to VTT tokens and initiative.</li>
            <li class="list-item">Encounter + map templates auto-attached to campaign arc.</li>
            <li class="list-item">AI GM can narrate, adjudicate, and generate scene media.</li>
          </ul>

          <div class="kv-list">
            <div class="kv-item"><strong>Token Sync:</strong> Character -> VTT pawn mapping placeholder</div>
            <div class="kv-item"><strong>Rules Engine:</strong> Ability checks + action economy scaffolding</div>
            <div class="kv-item"><strong>Session Bootstrap:</strong> Hook, objective, encounter, loot seed</div>
          </div>
        </article>
      </div>

      <form class="module-card" id="quickstart-form">
        <div class="module-header">
          <h3>5-Minute Homebrew Quickstart</h3>
          <span class="tag">Upload -> Parse Review -> Generate -> Launch VTT</span>
        </div>

        <div class="grid-two">
          <label class="field">
            <span>Campaign Name</span>
            <input name="quickName" required placeholder="Iron Reef Emergency Session" />
          </label>
          <label class="field">
            <span>Setting</span>
            <input name="quickSetting" required placeholder="Storm-wracked archipelago" />
          </label>
        </div>

        <label class="field">
          <span>Players (comma-separated)</span>
          <input name="quickPlayers" placeholder="Kai, Rune, Tessa" />
        </label>

        <label class="field">
          <span>Homebrew Files</span>
          <input id="quickstart-files" type="file" accept=".md,.txt,.json" multiple required />
        </label>

        <div class="inline">
          <button class="ghost" type="button" id="quickstart-parse">Parse & Review</button>
          <button class="alt" type="submit" id="quickstart-submit" disabled>Build & Launch VTT Room</button>
          <span class="small" id="quickstart-status">Run parse first, review confidence, then launch.</span>
        </div>

        <article class="module-card" id="quickstart-review">
          ${renderQuickstartReview(null)}
        </article>
      </form>
    </section>
  `;
}

export function bindCampaignForge(root, store, { onLaunchToVtt } = {}) {
  const form = root.querySelector("#campaign-form");
  if (form) {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const payload = new FormData(form);
      const name = titleCase(payload.get("name"));
      const setting = titleCase(payload.get("setting"));
      const players = parseList(payload.get("players") || "");
      const bookId = String(payload.get("bookId") || "");

      const campaign = store.createCampaign({
        name,
        setting,
        players,
        bookIds: [bookId]
      });

      store.pushChatLine({ speaker: "System", text: `${campaign.name} created with quickstart assets.` });
      form.reset();
    });
  }

  const templateButton = root.querySelector('[data-action="generate-template"]');
  if (templateButton) {
    templateButton.addEventListener("click", () => {
      const selectedCampaignId = store.getState().selectedCampaignId;
      if (!selectedCampaignId) {
        return;
      }
      store.incrementCampaignReadiness(selectedCampaignId, 20);
      store.addEncounter({
        name: "Auto-Generated Starter Clash",
        difficulty: "Easy",
        monsters: ["2x Placeholder Bandit", "1x Placeholder Mage"],
        xpBudget: 300
      });
      store.pushChatLine({
        speaker: "System",
        text: "Starter template generated: opening scene, quest giver, and first encounter added."
      });
    });
  }

  const quickstartForm = root.querySelector("#quickstart-form");
  if (!quickstartForm) {
    return;
  }

  const parseButton = root.querySelector("#quickstart-parse");
  const submitButton = root.querySelector("#quickstart-submit");
  const statusEl = root.querySelector("#quickstart-status");
  const filesInput = root.querySelector("#quickstart-files");
  const reviewEl = root.querySelector("#quickstart-review");

  let parsedPreview = null;
  let serializedFiles = [];

  function setStatus(message) {
    if (statusEl) {
      statusEl.textContent = message;
    }
  }

  function setReview(parsed) {
    if (reviewEl) {
      reviewEl.innerHTML = renderQuickstartReview(parsed);
    }
  }

  async function serializeSelectedFiles() {
    const files = Array.from(filesInput?.files || []);
    return Promise.all(
      files.map(async (file) => ({
        name: file.name,
        content: await file.text()
      }))
    );
  }

  async function runParseReview() {
    const files = Array.from(filesInput?.files || []);
    if (files.length === 0) {
      setStatus("Add at least one homebrew file before parsing.");
      submitButton.disabled = true;
      return null;
    }

    parseButton.disabled = true;
    setStatus("Parsing homebrew files...");

    try {
      serializedFiles = await serializeSelectedFiles();
      const response = await store.parseQuickstartFiles({
        files: serializedFiles
      });
      parsedPreview = response.parsed;
      setReview(parsedPreview);

      const confidence = parsedPreview?.confidence || { score: 0, band: "low" };
      setStatus(`Parse complete. Confidence ${confidence.score}/100 (${confidence.band}).`);
      submitButton.disabled = false;
      return parsedPreview;
    } catch (error) {
      parsedPreview = null;
      submitButton.disabled = true;
      setReview(null);
      setStatus(`Parse failed: ${String(error.message || error)}`);
      return null;
    } finally {
      parseButton.disabled = false;
    }
  }

  parseButton?.addEventListener("click", async () => {
    await runParseReview();
  });

  quickstartForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    submitButton.disabled = true;

    try {
      if (!parsedPreview) {
        const parsed = await runParseReview();
        if (!parsed) {
          return;
        }
      }

      const payload = new FormData(quickstartForm);
      const campaignName = titleCase(payload.get("quickName"));
      const setting = titleCase(payload.get("quickSetting"));
      const players = parseList(payload.get("quickPlayers") || "");

      setStatus("Generating campaign package and launching VTT...");

      const response = await store.buildQuickstartCampaign({
        campaignName,
        setting,
        players,
        files: serializedFiles,
        parsed: parsedPreview
      });

      const launch = response?.launch;
      const summary = response?.parsed?.summary || parsedPreview?.summary || {};
      setStatus(`Launched. Parsed ${summary.documents || 0} file(s), ${summary.monsters || 0} monsters, ${summary.spells || 0} spells.`);
      onLaunchToVtt?.(launch);
    } catch (error) {
      setStatus(`Quickstart failed: ${String(error.message || error)}`);
    } finally {
      submitButton.disabled = false;
    }
  });
}
