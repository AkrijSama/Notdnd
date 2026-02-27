import { createApiClient } from "./api/client.js";
import { renderAiGmConsole, bindAiGmConsole } from "./components/aiGmConsole.js";
import { renderCampaignForge, bindCampaignForge } from "./components/campaignForge.js";
import { renderCharacterVault, bindCharacterVault } from "./components/characterVault.js";
import { renderCommandCenter, bindCommandCenter } from "./components/commandCenter.js";
import { renderCompendium, bindCompendium } from "./components/compendium.js";
import { renderHomebrewStudio, bindHomebrewStudio } from "./components/homebrewStudio.js";
import { renderSidebar } from "./components/sidebar.js";
import { renderTopbar } from "./components/topbar.js";
import { renderVttTable, bindVttTable } from "./components/vttTable.js";
import { createRealtimeClient } from "./realtime/client.js";
import { createStore } from "./state/store.js";

const apiClient = createApiClient("");
const store = createStore({ apiClient });

const uiState = {
  activeTab: "command",
  compendiumQuery: "",
  apiHealthy: false,
  realtimeConnected: false,
  activeRealtimeCampaignId: null
};

const appRoot = document.querySelector("#app");

const realtimeClient = createRealtimeClient({
  campaignId: "global",
  onOpen() {
    uiState.realtimeConnected = true;
    renderApp();
  },
  onClose() {
    uiState.realtimeConnected = false;
    renderApp();
  },
  onStateChanged() {
    store.refreshFromServer();
  }
});

function renderActiveTab(state) {
  switch (uiState.activeTab) {
    case "command":
      return renderCommandCenter(state);
    case "forge":
      return renderCampaignForge(state);
    case "vtt":
      return renderVttTable(state);
    case "characters":
      return renderCharacterVault(state);
    case "compendium":
      return renderCompendium(state, uiState.compendiumQuery);
    case "homebrew":
      return renderHomebrewStudio(state);
    case "ai":
      return renderAiGmConsole(state);
    default:
      return renderCommandCenter(state);
  }
}

function bindAppEvents() {
  appRoot.querySelectorAll("[data-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      uiState.activeTab = String(button.getAttribute("data-tab"));
      renderApp();
    });
  });

  const activeModule = appRoot.querySelector("#active-module");
  if (!activeModule) {
    return;
  }

  switch (uiState.activeTab) {
    case "command":
      bindCommandCenter(activeModule, store);
      break;
    case "forge":
      bindCampaignForge(activeModule, store, {
        onLaunchToVtt() {
          uiState.activeTab = "vtt";
          renderApp();
        }
      });
      break;
    case "vtt":
      bindVttTable(activeModule, store);
      break;
    case "characters":
      bindCharacterVault(activeModule, store);
      break;
    case "compendium":
      bindCompendium(activeModule, (query) => {
        uiState.compendiumQuery = query;
        renderApp();
      });
      break;
    case "homebrew":
      bindHomebrewStudio(activeModule, store);
      break;
    case "ai":
      bindAiGmConsole(activeModule, store);
      break;
    default:
      break;
  }

  const resetButton = appRoot.querySelector("[data-action='reset-state']");
  if (resetButton) {
    resetButton.addEventListener("click", () => store.resetAll());
  }
}

function renderApp() {
  const state = store.getState();

  if (state.selectedCampaignId && state.selectedCampaignId !== uiState.activeRealtimeCampaignId) {
    uiState.activeRealtimeCampaignId = state.selectedCampaignId;
    realtimeClient.joinCampaign(state.selectedCampaignId);
  }

  appRoot.innerHTML = `
    <div class="app-shell">
      ${renderTopbar(uiState.activeTab)}
      <div class="layout">
        ${renderSidebar(state)}
        <main class="panel main">
          <section id="active-module">
            ${renderActiveTab(state)}
          </section>
          <section class="module-card">
            <div class="module-header">
              <h3>Scaffold Status</h3>
              <button class="ghost" data-action="reset-state">Reset Demo Data</button>
            </div>
            <div class="small">Backend API + SQLite schema + realtime collaboration + AI adapter layer are active in this scaffold.</div>
            <div class="footer-note">API: ${uiState.apiHealthy ? "Connected" : "Offline"} | Realtime: ${uiState.realtimeConnected ? "Connected" : "Disconnected"}</div>
          </section>
        </main>
      </div>
    </div>
  `;

  bindAppEvents();
}

store.subscribe(() => {
  renderApp();
});

async function bootstrap() {
  try {
    await apiClient.health();
    uiState.apiHealthy = true;
  } catch {
    uiState.apiHealthy = false;
  }

  await store.bootstrapRemote();
  renderApp();
}

bootstrap();

window.addEventListener("beforeunload", () => {
  realtimeClient.close();
});
