import { formatNow, parseList } from "../utils/helpers.js";

function recentRollItems(state, campaignId) {
  const pool = state.recentRollsByCampaign?.[campaignId] || [];
  if (pool.length === 0) {
    return `<li class="list-item">No rolls yet.</li>`;
  }

  return pool
    .slice(0, 8)
    .map(
      (roll) => `
        <li class="list-item">
          <div class="inline"><strong>${roll.actor}</strong> <span class="tag">${roll.type}</span></div>
          <div class="small">${roll.label}: ${roll.expression} = ${roll.total}</div>
        </li>
      `
    )
    .join("");
}

function journalItems(state, campaignId) {
  const entries = state.journalsByCampaign?.[campaignId] || [];
  if (entries.length === 0) {
    return `<li class="list-item">No journal entries yet.</li>`;
  }

  return entries
    .slice(0, 8)
    .map(
      (entry) => `
        <li class="list-item">
          <div class="inline"><strong>${entry.title}</strong> <span class="tag">${entry.visibility}</span></div>
          <div class="small">${entry.body || "(empty)"}</div>
          <div>${(entry.tags || []).map((tag) => `<span class="tag">${tag}</span>`).join("")}</div>
        </li>
      `
    )
    .join("");
}

export function renderCommandCenter(state) {
  const selectedCampaign = state.campaigns.find((campaign) => campaign.id === state.selectedCampaignId) || state.campaigns[0];
  const readiness = selectedCampaign?.readiness || 0;
  const campaignId = selectedCampaign?.id;

  return `
    <section class="module-card">
      <div class="module-header">
        <h2>Command Center</h2>
        <span class="small">Updated ${formatNow()}</span>
      </div>
      <p class="small">Blueprint mode: the scaffolding mirrors Roll20 table controls + D&D Beyond content workflows in one workspace.</p>

      <div class="grid-two">
        <article class="module-card">
          <h3>Campaign Queue</h3>
          <ul class="list">
            ${state.campaigns
              .map(
                (campaign) => `
                <li class="list-item">
                  <div class="inline">
                    <strong>${campaign.name}</strong>
                    <span class="tag">${campaign.status}</span>
                  </div>
                  <div class="small">Setting: ${campaign.setting}</div>
                  <div class="small">Readiness: ${campaign.readiness || 0}% | Sessions: ${campaign.sessionCount || 0}</div>
                  <button class="ghost" data-action="select-campaign" data-campaign-id="${campaign.id}">Open</button>
                </li>
              `
              )
              .join("")}
          </ul>
        </article>

        <article class="module-card">
          <h3>Fast Start Pipeline</h3>
          <ol class="list">
            <li class="list-item">1) Upload homebrew sources</li>
            <li class="list-item">2) Auto-build compendium index</li>
            <li class="list-item">3) Generate session skeleton</li>
            <li class="list-item">4) Spawn VTT map + tokens</li>
            <li class="list-item">5) Activate AI GM voice/image assists</li>
          </ol>
          <button data-action="boost-readiness">Run Auto-Prep +15%</button>
        </article>
      </div>

      <div class="module-card">
        <div class="module-header">
          <h3>Current Campaign Pulse</h3>
          <span class="status-pill ${readiness < 60 ? "warn" : ""}">${selectedCampaign?.status || "None"}</span>
        </div>
        <div><strong>${selectedCampaign?.name || "No active campaign"}</strong></div>
        <div class="small">Party: ${(selectedCampaign?.players || []).join(", ") || "No players assigned"}</div>
        <div class="progress"><span style="width: ${readiness}%"></span></div>
      </div>

      <div class="grid-two">
        <article class="module-card">
          <h3>Dice & Combat Engine</h3>
          <form id="roll-form" class="inline">
            <input name="label" placeholder="Label (Perception)" />
            <input name="expression" placeholder="2d20kh1+5" required />
            <button class="ghost" type="submit">Roll</button>
          </form>
          <form id="check-form" class="inline">
            <input name="label" placeholder="Skill Check" />
            <input name="expression" placeholder="1d20+4" required />
            <input name="dc" type="number" min="1" max="40" value="15" required />
            <button class="ghost" type="submit">Check</button>
          </form>
          <form id="attack-form" class="inline">
            <input name="attacker" placeholder="Attacker" />
            <input name="target" placeholder="Target" />
            <input name="attackExpression" placeholder="1d20+6" required />
            <input name="targetAc" type="number" min="1" max="40" value="13" required />
            <input name="damageExpression" placeholder="1d8+4" required />
            <button class="ghost" type="submit">Attack</button>
          </form>
          <ul class="list" id="recent-rolls">
            ${recentRollItems(state, campaignId)}
          </ul>
        </article>

        <article class="module-card">
          <h3>Journal & Handouts</h3>
          <form id="journal-form" class="field">
            <input name="title" placeholder="Entry title" required />
            <textarea name="body" placeholder="Scene notes, clues, handout text..."></textarea>
            <input name="tags" placeholder="clue, session-7, npc" />
            <select name="visibility">
              <option value="party">party</option>
              <option value="gm">gm</option>
            </select>
            <button type="submit">Add Journal Entry</button>
          </form>
          <ul class="list">
            ${journalItems(state, campaignId)}
          </ul>
        </article>
      </div>
    </section>
  `;
}

export function bindCommandCenter(root, store) {
  root.querySelectorAll('[data-action="select-campaign"]').forEach((button) => {
    button.addEventListener("click", () => {
      const campaignId = button.getAttribute("data-campaign-id");
      store.setSelectedCampaign(campaignId);
    });
  });

  const boostBtn = root.querySelector('[data-action="boost-readiness"]');
  if (boostBtn) {
    boostBtn.addEventListener("click", () => {
      const selectedCampaignId = store.getState().selectedCampaignId;
      if (!selectedCampaignId) {
        return;
      }
      store.incrementCampaignReadiness(selectedCampaignId, 15);
      store.pushChatLine({ speaker: "System", text: "Auto-prep generated hooks, encounters, and map pins." });
    });
  }

  const rollForm = root.querySelector("#roll-form");
  if (rollForm) {
    rollForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const payload = new FormData(rollForm);
      try {
        await store.rollDice({
          label: String(payload.get("label") || "Roll"),
          expression: String(payload.get("expression") || "1d20")
        });
      } catch (error) {
        store.pushChatLine({ speaker: "System", text: `Roll failed: ${String(error.message || error)}` });
      }
    });
  }

  const checkForm = root.querySelector("#check-form");
  if (checkForm) {
    checkForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const payload = new FormData(checkForm);
      try {
        await store.resolveSkillCheck({
          label: String(payload.get("label") || "Skill Check"),
          expression: String(payload.get("expression") || "1d20"),
          dc: Number(payload.get("dc") || 10)
        });
      } catch (error) {
        store.pushChatLine({ speaker: "System", text: `Check failed: ${String(error.message || error)}` });
      }
    });
  }

  const attackForm = root.querySelector("#attack-form");
  if (attackForm) {
    attackForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const payload = new FormData(attackForm);
      try {
        await store.resolveAttack({
          attacker: String(payload.get("attacker") || "Attacker"),
          target: String(payload.get("target") || "Target"),
          attackExpression: String(payload.get("attackExpression") || "1d20+5"),
          targetAc: Number(payload.get("targetAc") || 12),
          damageExpression: String(payload.get("damageExpression") || "1d8+3")
        });
      } catch (error) {
        store.pushChatLine({ speaker: "System", text: `Attack failed: ${String(error.message || error)}` });
      }
    });
  }

  const journalForm = root.querySelector("#journal-form");
  if (journalForm) {
    journalForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const payload = new FormData(journalForm);
      try {
        await store.addJournalEntry({
          title: String(payload.get("title") || "Untitled"),
          body: String(payload.get("body") || ""),
          tags: parseList(payload.get("tags") || ""),
          visibility: String(payload.get("visibility") || "party")
        });
        journalForm.reset();
      } catch (error) {
        store.pushChatLine({ speaker: "System", text: `Journal failed: ${String(error.message || error)}` });
      }
    });
  }
}
