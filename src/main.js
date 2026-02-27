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
  activeRealtimeCampaignId: null,
  showAuthPanel: false,
  authMode: "login",
  authMessage: "",
  campaignMembers: []
};

const appRoot = document.querySelector("#app");

const realtimeClient = createRealtimeClient({
  campaignId: "global",
  token: apiClient.getAuthToken(),
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
  },
  onError(message) {
    uiState.authMessage = message?.error || "Realtime error";
    renderApp();
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

function renderAuthPanel(state) {
  const user = state.auth?.user;
  if (!uiState.showAuthPanel) {
    return "";
  }

  if (user) {
    return `
      <section class="module-card">
        <div class="module-header">
          <h3>Account</h3>
          <span class="tag">Authenticated</span>
        </div>
        <div class="small">${user.displayName} (${user.email})</div>
        <div class="inline">
          <button class="ghost" data-action="refresh-members">Refresh Campaign Members</button>
          <button data-action="logout">Logout</button>
        </div>
        <form id="member-invite-form" class="inline">
          <input name="email" placeholder="member@email.com" required />
          <select name="role">
            <option value="viewer">viewer</option>
            <option value="player">player</option>
            <option value="editor">editor</option>
            <option value="gm">gm</option>
          </select>
          <button type="submit" class="ghost">Invite/Add</button>
        </form>
        <ul class="list">
          ${uiState.campaignMembers
            .map(
              (entry) =>
                `<li class="list-item"><strong>${entry.user.displayName}</strong> <span class="tag">${entry.role}</span> <span class="small">${entry.user.email}</span></li>`
            )
            .join("")}
        </ul>
      </section>
    `;
  }

  return `
    <section class="module-card">
      <div class="module-header">
        <h3>Authentication Required</h3>
        <span class="tag">Secure Collaboration</span>
      </div>
      <div class="inline">
        <button class="ghost" data-action="auth-mode-login">Login</button>
        <button class="ghost" data-action="auth-mode-register">Register</button>
      </div>
      <form id="auth-form" class="field">
        <input name="displayName" placeholder="Display Name (register only)" ${uiState.authMode === "register" ? "" : "style='display:none;'"} />
        <input name="email" type="email" placeholder="email" required />
        <input name="password" type="password" placeholder="password (min 8 chars)" required />
        <button type="submit">${uiState.authMode === "register" ? "Create account" : "Login"}</button>
      </form>
      <div class="small">Default bootstrap account: demo@notdnd.local / demo1234</div>
    </section>
  `;
}

async function loadCampaignMembers() {
  const state = store.getState();
  const campaignId = state.selectedCampaignId;
  if (!campaignId || !state.auth?.user) {
    uiState.campaignMembers = [];
    return;
  }

  try {
    const response = await apiClient.listCampaignMembers(campaignId);
    uiState.campaignMembers = response.members || [];
  } catch {
    uiState.campaignMembers = [];
  }
}

async function handleAuthSubmit(form) {
  const payload = new FormData(form);
  const email = String(payload.get("email") || "").trim();
  const password = String(payload.get("password") || "");
  const displayName = String(payload.get("displayName") || "").trim();

  try {
    if (uiState.authMode === "register") {
      await apiClient.register({ email, password, displayName });
    } else {
      await apiClient.login({ email, password });
    }

    const me = await apiClient.me();
    realtimeClient.setToken(apiClient.getAuthToken());
    await store.bootstrapRemote();
    await loadCampaignMembers();
    uiState.authMessage = `Signed in as ${me.user.displayName}`;
    uiState.showAuthPanel = false;
    renderApp();
  } catch (error) {
    uiState.authMessage = String(error.message || error);
    renderApp();
  }
}

function bindAppEvents() {
  appRoot.querySelectorAll("[data-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      uiState.activeTab = String(button.getAttribute("data-tab"));
      renderApp();
    });
  });

  const toggleAuth = appRoot.querySelector("[data-action='toggle-auth']");
  if (toggleAuth) {
    toggleAuth.addEventListener("click", () => {
      uiState.showAuthPanel = !uiState.showAuthPanel;
      renderApp();
    });
  }

  const authLoginBtn = appRoot.querySelector("[data-action='auth-mode-login']");
  if (authLoginBtn) {
    authLoginBtn.addEventListener("click", () => {
      uiState.authMode = "login";
      renderApp();
    });
  }

  const authRegisterBtn = appRoot.querySelector("[data-action='auth-mode-register']");
  if (authRegisterBtn) {
    authRegisterBtn.addEventListener("click", () => {
      uiState.authMode = "register";
      renderApp();
    });
  }

  const authForm = appRoot.querySelector("#auth-form");
  if (authForm) {
    authForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      await handleAuthSubmit(authForm);
    });
  }

  const logoutBtn = appRoot.querySelector("[data-action='logout']");
  if (logoutBtn) {
    logoutBtn.addEventListener("click", async () => {
      try {
        await apiClient.logout();
      } catch {
        // ignore
      }
      realtimeClient.setToken("");
      uiState.campaignMembers = [];
      store.clearAuth();
      uiState.authMessage = "Logged out.";
      renderApp();
    });
  }

  const refreshMembersBtn = appRoot.querySelector("[data-action='refresh-members']");
  if (refreshMembersBtn) {
    refreshMembersBtn.addEventListener("click", async () => {
      await loadCampaignMembers();
      renderApp();
    });
  }

  const inviteForm = appRoot.querySelector("#member-invite-form");
  if (inviteForm) {
    inviteForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const payload = new FormData(inviteForm);
      const email = String(payload.get("email") || "").trim();
      const role = String(payload.get("role") || "viewer");
      const campaignId = store.getState().selectedCampaignId;
      if (!campaignId) {
        return;
      }
      try {
        await apiClient.addCampaignMember({ campaignId, email, role });
        await loadCampaignMembers();
        uiState.authMessage = `Member added: ${email} (${role})`;
      } catch (error) {
        uiState.authMessage = `Invite failed: ${String(error.message || error)}`;
      }
      renderApp();
    });
  }

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
  const user = state.auth?.user;

  if (user && state.selectedCampaignId && state.selectedCampaignId !== uiState.activeRealtimeCampaignId) {
    uiState.activeRealtimeCampaignId = state.selectedCampaignId;
    realtimeClient.joinCampaign(state.selectedCampaignId);
  }

  appRoot.innerHTML = `
    <div class="app-shell">
      ${renderTopbar(uiState.activeTab, user)}
      ${uiState.authMessage ? `<section class="module-card"><div class="small">${uiState.authMessage}</div></section>` : ""}
      ${renderAuthPanel(state)}
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
            <div class="small">Secure auth + permissions + versioned sync + realtime collaboration + AI adapters are active.</div>
            <div class="footer-note">API: ${uiState.apiHealthy ? "Connected" : "Offline"} | Realtime: ${uiState.realtimeConnected ? "Connected" : "Disconnected"} | State v${state.stateVersion ?? 0}</div>
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

  let authenticated = false;
  try {
    const me = await apiClient.me();
    authenticated = Boolean(me?.user);
  } catch {
    authenticated = false;
  }

  if (!authenticated) {
    try {
      await apiClient.login({ email: "demo@notdnd.local", password: "demo1234" });
      authenticated = true;
      uiState.authMessage = "Signed in with bootstrap demo account.";
    } catch {
      authenticated = false;
    }
  }

  realtimeClient.setToken(authenticated ? apiClient.getAuthToken() : "");
  await store.bootstrapRemote();
  if (authenticated) {
    await loadCampaignMembers();
  }

  renderApp();
}

bootstrap();

window.addEventListener("beforeunload", () => {
  realtimeClient.close();
});
