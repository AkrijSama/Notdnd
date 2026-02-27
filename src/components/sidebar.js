export function renderSidebar(state) {
  const selectedCampaign = state.campaigns.find((campaign) => campaign.id === state.selectedCampaignId) || state.campaigns[0];
  const readiness = selectedCampaign?.readiness || 0;

  return `
    <aside class="panel sidebar">
      <section>
        <h3>Live Control Tower</h3>
        <p class="small">Single place for campaign, VTT, compendium, and AI GM operations.</p>
      </section>

      <section class="metric-grid">
        <article class="metric">
          <div class="small">Campaigns</div>
          <div class="metric-value">${state.campaigns.length}</div>
        </article>
        <article class="metric">
          <div class="small">Books</div>
          <div class="metric-value">${state.books.length}</div>
        </article>
        <article class="metric">
          <div class="small">Characters</div>
          <div class="metric-value">${state.characters.length}</div>
        </article>
        <article class="metric">
          <div class="small">AI Jobs</div>
          <div class="metric-value">${state.aiJobs.length}</div>
        </article>
        <article class="metric">
          <div class="small">Journals</div>
          <div class="metric-value">${Object.values(state.journalsByCampaign || {}).reduce((sum, items) => sum + (items?.length || 0), 0)}</div>
        </article>
        <article class="metric">
          <div class="small">Recent Rolls</div>
          <div class="metric-value">${Object.values(state.recentRollsByCampaign || {}).reduce((sum, items) => sum + (items?.length || 0), 0)}</div>
        </article>
      </section>

      <section class="module-card">
        <div class="module-header">
          <h4>Selected Campaign</h4>
          <span class="status-pill ${readiness < 60 ? "warn" : ""}">${selectedCampaign?.status || "N/A"}</span>
        </div>
        <div>${selectedCampaign?.name || "No campaign selected"}</div>
        <div class="small">Readiness</div>
        <div class="progress"><span style="width: ${readiness}%"></span></div>
        <div class="small">${readiness}% ready for session</div>
      </section>

      <section>
        <div class="small">System posture</div>
        <div class="kv-list">
          <div class="kv-item"><strong>VTT Sync:</strong> Active</div>
          <div class="kv-item"><strong>Rules Index:</strong> Unified</div>
          <div class="kv-item"><strong>AI Copilot:</strong> Placeholder Models</div>
        </div>
      </section>
    </aside>
  `;
}
