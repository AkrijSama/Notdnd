import { formatNow } from "../utils/helpers.js";

export function renderCommandCenter(state) {
  const selectedCampaign = state.campaigns.find((campaign) => campaign.id === state.selectedCampaignId) || state.campaigns[0];
  const readiness = selectedCampaign?.readiness || 0;

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
}
