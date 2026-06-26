import { createApiClient } from "./api/client.js";
import { renderAiGmConsole, bindAiGmConsole } from "./components/aiGmConsole.js";
import { renderCampaignForge, bindCampaignForge } from "./components/campaignForge.js";
import { renderCharacterVault, bindCharacterVault } from "./components/characterVault.js";
import { renderCommandCenter, bindCommandCenter } from "./components/commandCenter.js";
import { renderCompendium, bindCompendium } from "./components/compendium.js";
import { renderHomebrewStudio, bindHomebrewStudio } from "./components/homebrewStudio.js";
import { renderOnboardingFlow, bindOnboardingFlow } from "./components/onboardingFlow.js";
import { ABILITIES, pointBuyCost, rollAbilityScores } from "../server/solo/dndData.js";
import { renderSidebar } from "./components/sidebar.js";
import { mountSoloSceneShell } from "./components/soloSceneShell.js";
import { renderTopbar } from "./components/topbar.js";
import { renderVttTable, bindVttTable } from "./components/vttTable.js";
import { createRealtimeClient } from "./realtime/client.js";
import { createStore } from "./state/store.js";

const apiClient = createApiClient("");
const store = createStore({ apiClient });

const uiState = {
  activeTab: "command",
  compendiumQuery: "",
  resumeRunId: null,
  soloRuns: [],
  apiHealthy: false,
  realtimeConnected: false,
  activeRealtimeCampaignId: null,
  showAuthPanel: false,
  showAccountMenu: false,
  authMode: "login",
  authMessage: "",
  campaignMembers: [],
  presenceUsers: [],
  cursorState: [],
  lockState: [],
  pendingDeleteCampaignId: null,
  onboarding: {
    step: "inactive",
    loading: false,
    thinking: false,
    error: "",
    campaignId: "",
    worldDef: {},
    worldPreview: null,
    characterName: "",
    archetype: "",
    backstorySnippet: "",
    messages: [],
    exchanges: 0
  }
};

const appRoot = document.querySelector("#app");
const soloRunIdFromUrl = new URLSearchParams(window.location.search).get("soloRunId");

const realtimeClient = createRealtimeClient({
  campaignId: "global",
  token: apiClient.getAuthToken(),
  onOpen() {
    uiState.realtimeConnected = true;
    scheduleRender();
  },
  onClose() {
    uiState.realtimeConnected = false;
    scheduleRender();
  },
  onStateSync(message) {
    store.applyAuthoritativeState(message.state);
  },
  onPresence(message) {
    uiState.presenceUsers = message.users || [];
    scheduleRender();
  },
  onCursors(message) {
    uiState.cursorState = message.cursors || [];
    scheduleRender();
  },
  onLocks(message) {
    uiState.lockState = message.locks || [];
    scheduleRender();
  },
  onError(message) {
    uiState.authMessage = message?.error || "Realtime error";
    scheduleRender();
  }
});

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Minimal header for the solo player's surfaces (home + login). Deliberately
// omits the 7-tab GM/multiplayer nav (renderTopbar) — solo players never see it.
// Keeps only the brand and the auth/account affordances that bindAppEvents wires.
function renderSoloHeader(user, accountMenuOpen = false) {
  return `
    <header class="topbar solo-topbar">
      <div class="brand">
        <h1>Notdnd</h1>
        <span>Solo AI RPG</span>
      </div>
      <div class="inline">
        <span class="small">${user ? `Signed in: ${escapeHtml(user.displayName)}` : "Not signed in"}</span>
        ${
          user
            ? `
              <div class="account-menu">
                <button class="ghost" data-action="toggle-account-menu" aria-haspopup="true" aria-expanded="${accountMenuOpen ? "true" : "false"}">Account ▾</button>
                ${
                  accountMenuOpen
                    ? `
                      <div class="account-dropdown" role="menu">
                        <button class="account-dropdown-item" role="menuitem" data-action="open-account">Account Settings</button>
                        <button class="account-dropdown-item" role="menuitem" data-action="logout">Sign Out</button>
                      </div>
                    `
                    : ""
                }
              </div>
            `
            : `<button class="ghost" data-action="toggle-auth">Sign In</button>`
        }
      </div>
    </header>
  `;
}

function renderSoloRunCard(run, { primary = false } = {}) {
  const worldName = run?.world?.name || "Untitled World";
  const charName = run?.player?.displayName || "Adventurer";
  const status = run?.status || "unknown";
  // Concluded runs (completed/abandoned) are read-only: greyed out, badged with
  // their outcome, and no Resume button (you cannot re-enter a closed run).
  const finished = status === "completed" || status === "abandoned";
  const badgeLabel = status === "completed" ? "Completed" : status === "abandoned" ? "Abandoned" : "";
  const outcome = run?.outcome && run.outcome !== status ? ` (${run.outcome})` : "";
  return `
    <article class="solo-home-run-card${primary ? " primary" : ""}${finished ? " finished" : ""}">
      <div class="solo-home-run-meta">
        <strong>${escapeHtml(worldName)}</strong>
        <span class="small">${escapeHtml(charName)} · ${escapeHtml(status)}${escapeHtml(outcome)}</span>
      </div>
      ${
        finished
          ? `<span class="solo-home-run-badge">${escapeHtml(badgeLabel)}</span>`
          : `<button data-action="open-run" data-run-id="${escapeHtml(run.runId)}">${primary ? "Continue your adventure" : "Resume"}</button>`
      }
    </article>
  `;
}

// The solo home screen: the post-login / post-exit destination for solo players.
// Replaces the 7-tab legacy shell. Shows a Continue card for the most recent
// active run, a Start a New Adventure button, and any past runs.
function renderSoloHome(state) {
  const runs = Array.isArray(uiState.soloRuns) ? uiState.soloRuns : [];
  const activeRuns = runs.filter((run) => run?.status === "active");
  const continueRun =
    activeRuns.find((run) => run.runId === uiState.resumeRunId) || activeRuns[0] || null;
  const pastRuns = runs.filter((run) => run !== continueRun);

  return `
    <main class="panel main solo-home-main">
      <section class="solo-home">
        <div class="solo-home-hero">
          <h2>Your adventures</h2>
          <p class="small">Step back into a world, or begin a new one.</p>
        </div>
        ${
          continueRun
            ? `<div class="solo-home-continue">${renderSoloRunCard(continueRun, { primary: true })}</div>`
            : ""
        }
        <div class="solo-home-start">
          <button data-action="start-new-adventure">Start a New Adventure</button>
        </div>
        ${
          pastRuns.length > 0
            ? `<section class="solo-home-past">
                 <h3>Past adventures</h3>
                 <div class="solo-home-run-list">
                   ${pastRuns.map((run) => renderSoloRunCard(run)).join("")}
                 </div>
               </section>`
            : ""
        }
      </section>
    </main>
  `;
}

function renderActiveTab(state) {
  switch (uiState.activeTab) {
    case "command":
      return renderCommandCenter(state, {
        pendingDeleteCampaignId: uiState.pendingDeleteCampaignId
      });
    case "forge":
      return renderCampaignForge(state);
    case "vtt":
      return renderVttTable(state, {
        presenceUsers: uiState.presenceUsers,
        cursorState: uiState.cursorState,
        lockState: uiState.lockState
      });
    case "characters":
      return renderCharacterVault(state);
    case "compendium":
      return renderCompendium(state, uiState.compendiumQuery);
    case "homebrew":
      return renderHomebrewStudio(state);
    case "ai":
      return renderAiGmConsole(state);
    default:
      return renderCommandCenter(state, {
        pendingDeleteCampaignId: uiState.pendingDeleteCampaignId
      });
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

function shouldShowOnboarding(state) {
  const user = state.auth?.user;
  if (!user) {
    return false;
  }
  if (uiState.onboarding.step === "completed") {
    return false;
  }
  if (["world", "world_preview", "character", "arrival"].includes(uiState.onboarding.step)) {
    return true;
  }
  return (state.campaigns || []).length === 0;
}

function patchOnboarding(patch) {
  uiState.onboarding = { ...uiState.onboarding, ...patch };
  scheduleRender();
}

// World-definition field handlers: chip selections re-render (to show the
// active state); free-text input does not (preserve caret), mirroring the
// character form's onFieldChange.
function onWorldFieldSelect(field, value) {
  uiState.onboarding.worldDef = { ...(uiState.onboarding.worldDef || {}), [field]: value };
  scheduleRender();
}
function onWorldFieldInput(field, value) {
  uiState.onboarding.worldDef = { ...(uiState.onboarding.worldDef || {}), [field]: value };
}

async function generateWorld() {
  patchOnboarding({ loading: true, error: "" });
  try {
    const response = await store.previewWorld(uiState.onboarding.worldDef || {});
    patchOnboarding({ loading: false, worldPreview: response.world, step: "world_preview" });
  } catch (error) {
    patchOnboarding({ loading: false, error: String(error?.message || error || "World generation failed.") });
  }
}

async function regenerateWorld() {
  patchOnboarding({ loading: true, error: "" });
  try {
    const response = await store.previewWorld(uiState.onboarding.worldDef || {});
    patchOnboarding({ loading: false, worldPreview: response.world });
  } catch (error) {
    patchOnboarding({ loading: false, error: String(error?.message || error || "World regeneration failed.") });
  }
}

// Bumped on every per-field regenerate so each request carries a fresh salt.
// The offline world generator is deterministic per (definition, salt); without
// a changing salt the regenerated value is byte-identical and the button looks
// dead. Combined with Date.now() for uniqueness across reloads.
let worldRegenSalt = 0;

async function regenerateWorldField(field) {
  patchOnboarding({ loading: true, error: "" });
  worldRegenSalt += 1;
  const salt = `${field}:${worldRegenSalt}:${Date.now()}`;
  try {
    const response = await store.regenerateWorldField({ definition: uiState.onboarding.worldDef || {}, field, salt });
    const world = { ...(uiState.onboarding.worldPreview || {}) };
    if (field === "description") {
      world.description = response.value;
    } else if (field === "startingLocationDescription") {
      world.startingLocation = { ...(world.startingLocation || {}), description: response.value };
    } else {
      world[field] = response.value;
      if (field === "startingLocationName") {
        world.startingLocation = { ...(world.startingLocation || {}), name: response.value };
      }
    }
    patchOnboarding({ loading: false, worldPreview: world });
  } catch (error) {
    patchOnboarding({ loading: false, error: String(error?.message || error || "Field regeneration failed.") });
  }
}

function defaultCharacterState() {
  return {
    step: 1,
    name: "",
    pronouns: "",
    portraitMode: "generate",
    race: "",
    characterClass: "",
    background: "",
    abilityMethod: "standard_array",
    baseAbilityScores: { strength: 15, dexterity: 14, constitution: 13, intelligence: 12, wisdom: 10, charisma: 8 },
    rolledScores: [],
    chosenSkills: []
  };
}

function confirmWorld() {
  patchOnboarding({ step: "character", error: "", character: defaultCharacterState() });
}

// ---- Character creation wizard handlers (Ticket 38) ----
function charStep(delta) {
  const c = uiState.onboarding.character || defaultCharacterState();
  uiState.onboarding.character = { ...c, step: Math.max(1, Math.min(6, (c.step || 1) + delta)) };
  scheduleRender();
}
function charField(field, value) {
  uiState.onboarding.character = { ...(uiState.onboarding.character || defaultCharacterState()), [field]: value };
  scheduleRender();
}
function charInput(field, value) {
  // text fields: update state without re-render so the caret is preserved
  uiState.onboarding.character = { ...(uiState.onboarding.character || defaultCharacterState()), [field]: value };
}
function charMethod(method) {
  const c = uiState.onboarding.character || defaultCharacterState();
  let baseAbilityScores = c.baseAbilityScores || {};
  let rolledScores = c.rolledScores || [];
  if (method === "standard_array") {
    baseAbilityScores = { strength: 15, dexterity: 14, constitution: 13, intelligence: 12, wisdom: 10, charisma: 8 };
  } else if (method === "point_buy") {
    baseAbilityScores = { strength: 8, dexterity: 8, constitution: 8, intelligence: 8, wisdom: 8, charisma: 8 };
  } else if (method === "roll") {
    baseAbilityScores = {};
    rolledScores = [];
  }
  uiState.onboarding.character = { ...c, abilityMethod: method, baseAbilityScores, rolledScores };
  scheduleRender();
}
function charAssign(ability, valueStr) {
  const c = uiState.onboarding.character || defaultCharacterState();
  const scores = { ...(c.baseAbilityScores || {}) };
  const value = valueStr === "" ? undefined : Number(valueStr);
  if (value != null) {
    // swap: if another ability already holds this value, give it our old one
    const other = ABILITIES.find((a) => a !== ability && scores[a] === value);
    if (other) {
      scores[other] = scores[ability];
    }
  }
  scores[ability] = value;
  uiState.onboarding.character = { ...c, baseAbilityScores: scores };
  scheduleRender();
}
function charPointBuy(spec) {
  const [ability, dir] = String(spec || "").split(":");
  if (!ABILITIES.includes(ability)) {
    return;
  }
  const c = uiState.onboarding.character || defaultCharacterState();
  const scores = { ...(c.baseAbilityScores || {}) };
  let value = scores[ability] ?? 8;
  if (dir === "inc" && value < 15) {
    value += 1;
  } else if (dir === "dec" && value > 8) {
    value -= 1;
  } else {
    return;
  }
  const candidate = { ...scores, [ability]: value };
  const used = ABILITIES.reduce((sum, a) => sum + (pointBuyCost(candidate[a] ?? 8) ?? 0), 0);
  if (used > 27) {
    return; // over budget; reject
  }
  uiState.onboarding.character = { ...c, baseAbilityScores: candidate };
  scheduleRender();
}
function charRoll() {
  const c = uiState.onboarding.character || defaultCharacterState();
  const rolled = rollAbilityScores();
  const baseAbilityScores = {};
  ABILITIES.forEach((a, i) => {
    baseAbilityScores[a] = rolled[i];
  });
  uiState.onboarding.character = { ...c, rolledScores: rolled, baseAbilityScores };
  scheduleRender();
}

async function enterWorld() {
  const c = uiState.onboarding.character || defaultCharacterState();
  // Defense-in-depth: the Review-step button is disabled when these are
  // missing, but never trust the UI gate alone. Surface what's still required.
  const missing = [];
  if (!(typeof c.name === "string" && c.name.trim().length > 0)) missing.push("a character name");
  if (!c.race) missing.push("a race");
  if (!c.characterClass) missing.push("a class");
  if (missing.length > 0) {
    patchOnboarding({ error: `To continue, please add: ${missing.join(", ")}.` });
    return;
  }
  patchOnboarding({ loading: true, error: "" });
  try {
    const response = await store.createWorldRun({
      world: uiState.onboarding.worldPreview || uiState.onboarding.worldDef || {},
      character: {
        name: c.name,
        pronouns: c.pronouns,
        race: c.race,
        characterClass: c.characterClass,
        background: c.background,
        baseAbilityScores: c.baseAbilityScores,
        chosenSkills: c.chosenSkills
      }
    });
    if (response?.runId) {
      window.location.search = `?soloRunId=${encodeURIComponent(response.runId)}`;
      return;
    }
    patchOnboarding({ loading: false, error: "World creation returned no run." });
  } catch (error) {
    patchOnboarding({ loading: false, error: String(error?.message || error || "Failed to enter the world.") });
  }
}

// Character submit -> create the run from the confirmed world + character, then
// drop straight into the solo scene. (Pass 4 replaces the simple form with the
// full 5e wizard; the world + character payload shape stays the same.)
async function startOnboarding(payload) {
  patchOnboarding({
    loading: true,
    error: "",
    characterName: payload.characterName,
    archetype: payload.archetype,
    backstorySnippet: payload.backstorySnippet
  });

  try {
    const response = await store.createWorldRun({
      world: uiState.onboarding.worldPreview || uiState.onboarding.worldDef || {},
      character: {
        name: payload.characterName,
        race: payload.race,
        characterClass: payload.characterClass,
        background: payload.background,
        baseAbilityScores: payload.baseAbilityScores,
        chosenSkills: payload.chosenSkills,
        pronouns: payload.pronouns
      }
    });
    if (response?.runId) {
      window.location.search = `?soloRunId=${encodeURIComponent(response.runId)}`;
      return;
    }
    patchOnboarding({ loading: false, error: "World creation returned no run." });
  } catch (error) {
    patchOnboarding({ loading: false, error: String(error?.message || error || "Failed to enter the world.") });
  }
}

async function sendOnboardingMessage(message) {
  const campaignId = uiState.onboarding.campaignId || store.getState().selectedCampaignId;
  if (!campaignId) {
    uiState.onboarding = {
      ...uiState.onboarding,
      error: "No onboarding campaign is active."
    };
    scheduleRender();
    return;
  }

  const nextMessages = [...uiState.onboarding.messages, { role: "user", text: message }];
  uiState.onboarding = {
    ...uiState.onboarding,
    messages: nextMessages,
    thinking: true,
    error: "",
    exchanges: Number(uiState.onboarding.exchanges || 0) + 1
  };
  scheduleRender();

  try {
    const response = await store.requestGmResponse({
      campaignId,
      message,
      mode: "companion",
      stream: true
    });

    const narrative = String(response.narrative || "").trim();
    uiState.onboarding = {
      ...uiState.onboarding,
      thinking: false,
      messages: narrative
        ? [...uiState.onboarding.messages, { role: "assistant", text: narrative }]
        : uiState.onboarding.messages
    };

    await store.loadGmMemoryDocs(campaignId);
  } catch (error) {
    uiState.onboarding = {
      ...uiState.onboarding,
      thinking: false,
      error: String(error?.message || error || "Companion response failed.")
    };
  }

  scheduleRender();
}

function openOnboardingCampaignDashboard() {
  uiState.onboarding = {
    ...uiState.onboarding,
    step: "completed",
    thinking: false,
    loading: false
  };
  uiState.activeTab = "command";
  scheduleRender();
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
    const nextState = store.getState();
    if ((nextState.campaigns || []).length === 0) {
      uiState.onboarding = {
        ...uiState.onboarding,
        step: "world",
        error: ""
      };
    } else {
      uiState.onboarding = {
        ...uiState.onboarding,
        step: "completed",
        loading: false,
        thinking: false,
        error: ""
      };
    }
    await loadCampaignMembers();
    uiState.authMessage = `Signed in as ${me.user.displayName}`;
    uiState.showAuthPanel = false;
    scheduleRender();
  } catch (error) {
    uiState.authMessage = String(error.message || error);
    scheduleRender();
  }
}

function bindAppEvents() {
  appRoot.querySelectorAll("[data-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      uiState.activeTab = String(button.getAttribute("data-tab"));
      scheduleRender();
    });
  });

  const toggleAuth = appRoot.querySelector("[data-action='toggle-auth']");
  if (toggleAuth) {
    toggleAuth.addEventListener("click", () => {
      uiState.showAuthPanel = !uiState.showAuthPanel;
      scheduleRender();
    });
  }

  const toggleAccountMenu = appRoot.querySelector("[data-action='toggle-account-menu']");
  if (toggleAccountMenu) {
    toggleAccountMenu.addEventListener("click", () => {
      uiState.showAccountMenu = !uiState.showAccountMenu;
      scheduleRender();
    });
  }

  const startAdventureBtn = appRoot.querySelector("[data-action='start-new-adventure']");
  if (startAdventureBtn) {
    startAdventureBtn.addEventListener("click", () => {
      uiState.onboarding = {
        ...uiState.onboarding,
        step: "world",
        worldDef: {},
        worldPreview: null,
        loading: false,
        error: ""
      };
      scheduleRender();
    });
  }

  appRoot.querySelectorAll("[data-action='open-run']").forEach((button) => {
    button.addEventListener("click", () => {
      const runId = button.getAttribute("data-run-id");
      if (runId) {
        window.location.search = `?soloRunId=${encodeURIComponent(runId)}`;
      }
    });
  });

  const resumeRunBtn = appRoot.querySelector("[data-action='resume-run']");
  if (resumeRunBtn) {
    resumeRunBtn.addEventListener("click", () => {
      if (uiState.resumeRunId) {
        window.location.search = `?soloRunId=${encodeURIComponent(uiState.resumeRunId)}`;
      }
    });
  }
  const dismissResumeBtn = appRoot.querySelector("[data-action='dismiss-resume']");
  if (dismissResumeBtn) {
    dismissResumeBtn.addEventListener("click", () => {
      uiState.resumeRunId = null;
      scheduleRender();
    });
  }

  const openAccountBtn = appRoot.querySelector("[data-action='open-account']");
  if (openAccountBtn) {
    openAccountBtn.addEventListener("click", () => {
      uiState.showAccountMenu = false;
      uiState.showAuthPanel = true;
      scheduleRender();
    });
  }

  const authLoginBtn = appRoot.querySelector("[data-action='auth-mode-login']");
  if (authLoginBtn) {
    authLoginBtn.addEventListener("click", () => {
      uiState.authMode = "login";
      scheduleRender();
    });
  }

  const authRegisterBtn = appRoot.querySelector("[data-action='auth-mode-register']");
  if (authRegisterBtn) {
    authRegisterBtn.addEventListener("click", () => {
      uiState.authMode = "register";
      scheduleRender();
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
        // ignore network/server errors; we still clear local auth below
      }
      // Guarantee the auth token is removed from localStorage even if the
      // server logout call failed before clearing it.
      apiClient.setAuthToken(null);
      realtimeClient.setToken("");
      uiState.campaignMembers = [];
      uiState.showAccountMenu = false;
      uiState.onboarding = {
        ...uiState.onboarding,
        step: "inactive",
        loading: false,
        thinking: false,
        error: "",
        messages: [],
        exchanges: 0,
        campaignId: ""
      };
      store.clearAuth();
      // Redirect to the login screen.
      uiState.activeTab = "command";
      uiState.showAuthPanel = true;
      uiState.authMode = "login";
      uiState.authMessage = "Signed out.";
      scheduleRender();
    });
  }

  const refreshMembersBtn = appRoot.querySelector("[data-action='refresh-members']");
  if (refreshMembersBtn) {
    refreshMembersBtn.addEventListener("click", async () => {
      await loadCampaignMembers();
      scheduleRender();
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
      scheduleRender();
    });
  }

  const activeModule = appRoot.querySelector("#active-module");
  if (!activeModule) {
    return;
  }

  switch (uiState.activeTab) {
    case "command":
      bindCommandCenter(activeModule, store, {
        onSetPendingDelete(campaignId) {
          uiState.pendingDeleteCampaignId = campaignId;
          if (campaignId === null) {
            uiState.onboarding.step = "completed";
          }
          scheduleRender();
        }
      });
      break;
    case "forge":
      bindCampaignForge(activeModule, store, {
        onLaunchToVtt() {
          uiState.activeTab = "vtt";
          scheduleRender();
        }
      });
      break;
    case "vtt":
      bindVttTable(activeModule, store, {
        realtimeClient,
        lockState: uiState.lockState
      });
      break;
    case "characters":
      bindCharacterVault(activeModule, store);
      break;
    case "compendium":
      bindCompendium(activeModule, (query) => {
        uiState.compendiumQuery = query;
        scheduleRender();
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
  if (soloRunIdFromUrl) {
    return;
  }

  const state = store.getState();
  const user = state.auth?.user;
  const onboardingVisible = shouldShowOnboarding(state);
  if (onboardingVisible && uiState.onboarding.step === "inactive") {
    uiState.onboarding.step = "world";
  }

  if (user && state.selectedCampaignId && state.selectedCampaignId !== uiState.activeRealtimeCampaignId) {
    uiState.activeRealtimeCampaignId = state.selectedCampaignId;
    realtimeClient.joinCampaign(state.selectedCampaignId);
  }

  const focusSnapshot = captureFocusSnapshot();

  // Solo players never see the 7-tab GM shell. Unauthenticated visitors get a
  // login screen; the auth panel is forced open so they can sign in without a
  // nav bar to toggle it.
  if (!user && !onboardingVisible) {
    uiState.showAuthPanel = true;
  }

  const authMessageHtml = uiState.authMessage
    ? `<section class="module-card"><div class="small">${uiState.authMessage}</div></section>`
    : "";

  const html = onboardingVisible
    ? `
      <div class="app-shell">
        ${renderSoloHeader(user, uiState.showAccountMenu)}
        ${authMessageHtml}
        ${renderAuthPanel(state)}
        <main class="panel main onboarding-main">
          <section id="onboarding-root">
            ${renderOnboardingFlow(uiState.onboarding)}
          </section>
        </main>
      </div>
    `
    : user
    ? `
      <div class="app-shell">
        ${renderSoloHeader(user, uiState.showAccountMenu)}
        ${authMessageHtml}
        ${renderAuthPanel(state)}
        ${renderSoloHome(state)}
      </div>
    `
    : `
      <div class="app-shell">
        ${renderSoloHeader(user, uiState.showAccountMenu)}
        ${authMessageHtml}
        <main class="panel main solo-home-main">
          <section class="module-card solo-login-card">
            <h2>Welcome to Notdnd</h2>
            <p class="small">Sign in to begin or continue your solo adventure.</p>
          </section>
          ${renderAuthPanel(state)}
        </main>
      </div>
    `;

  if (html === lastRenderedHtml) {
    return;
  }
  // Render-stability guard: never rebuild the DOM while the user is typing in a
  // text field. Periodic external renders (realtime presence + the ~1.2s WS
  // reconnect loop) would otherwise replace appRoot.innerHTML and clear input
  // focus/caret mid-keystroke (e.g. the world-generator World Name field). The
  // next render — after blur or a button/chip interaction — reconciles the view.
  if (isEditingTextField()) {
    return;
  }
  lastRenderedHtml = html;
  appRoot.innerHTML = html;

  bindAppEvents();

  if (onboardingVisible) {
    const onboardingRoot = appRoot.querySelector("#onboarding-root");
    if (onboardingRoot) {
      bindOnboardingFlow(onboardingRoot, {
        onStart: startOnboarding,
        onSendMessage: sendOnboardingMessage,
        onOpenDashboard: openOnboardingCampaignDashboard,
        onWorldField: onWorldFieldSelect,
        onWorldFieldInput,
        onGenerateWorld: generateWorld,
        onRegenerateWorld: regenerateWorld,
        onRegenerateField: regenerateWorldField,
        onConfirmWorld: confirmWorld,
        onCharStep: charStep,
        onCharField: charField,
        onCharInput: charInput,
        onCharMethod: charMethod,
        onCharAssign: charAssign,
        onCharPointBuy: charPointBuy,
        onCharRoll: charRoll,
        onCharEnter: enterWorld,
        onFieldChange(field, value) {
          uiState.onboarding[field] = value;
        }
      });
    }
  }

  restoreFocusSnapshot(focusSnapshot);
}

// True while the user is actively typing in a text input/textarea inside the
// app — used to suppress full re-renders that would clear focus/caret.
function isEditingTextField() {
  const el = document.activeElement;
  if (!el || el === document.body || !appRoot.contains(el)) {
    return false;
  }
  if (el.tagName === "TEXTAREA") {
    return true;
  }
  if (el.tagName === "INPUT") {
    const type = (el.getAttribute("type") || "text").toLowerCase();
    return ["text", "search", "email", "password", "number", "url", "tel", ""].includes(type);
  }
  return false;
}

function captureFocusSnapshot() {
  const active = document.activeElement;
  if (!active || active === document.body || !appRoot.contains(active)) {
    return null;
  }
  const name = active.getAttribute("name");
  const id = active.id || null;
  // World-generator / character-wizard inputs identify by data-* (no name/id).
  const dataKey = active.getAttribute("data-world-field") || active.getAttribute("data-cw-input") || null;
  if (!name && !id && !dataKey) {
    return null;
  }
  const isTextLike =
    active.tagName === "INPUT" || active.tagName === "TEXTAREA";
  return {
    name,
    id,
    dataKey,
    selectionStart: isTextLike ? active.selectionStart : null,
    selectionEnd: isTextLike ? active.selectionEnd : null
  };
}

function restoreFocusSnapshot(snapshot) {
  if (!snapshot) {
    return;
  }
  let target = null;
  if (snapshot.name) {
    target = appRoot.querySelector(`[name="${snapshot.name}"]`);
  }
  if (!target && snapshot.id) {
    target = appRoot.querySelector(`#${snapshot.id}`);
  }
  if (!target && snapshot.dataKey) {
    target =
      appRoot.querySelector(`[data-world-field="${snapshot.dataKey}"]`) ||
      appRoot.querySelector(`[data-cw-input="${snapshot.dataKey}"]`);
  }
  if (!target) {
    return;
  }
  try {
    target.focus({ preventScroll: true });
    if (
      snapshot.selectionStart !== null &&
      snapshot.selectionEnd !== null &&
      typeof target.setSelectionRange === "function"
    ) {
      target.setSelectionRange(snapshot.selectionStart, snapshot.selectionEnd);
    }
  } catch {
    // ignore focus restoration errors on detached or non-focusable nodes
  }
}

let lastRenderedHtml = "";
let renderScheduled = false;
function scheduleRender() {
  if (renderScheduled) {
    return;
  }
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    renderApp();
  });
}

store.subscribe(scheduleRender);

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

  realtimeClient.setToken(authenticated ? apiClient.getAuthToken() : "");
  await store.bootstrapRemote();
  if (authenticated) {
    await loadCampaignMembers();
    const campaigns = store.getState().campaigns || [];
    if (campaigns.length === 0) {
      // Zero campaigns (new OR existing account) -> start the world generator,
      // not the character wizard (which would skip world creation).
      uiState.onboarding.step = "world";
    } else {
      // If the player explicitly left a run, don't auto-resume it — offer a
      // "Continue your adventure" prompt on the home screen instead.
      let justExited = false;
      try {
        justExited = window.sessionStorage?.getItem("notdnd_exited_run") === "true";
        if (justExited) {
          window.sessionStorage.removeItem("notdnd_exited_run");
        }
      } catch {
        justExited = false;
      }
      try {
        const soloResponse = await apiClient.listSoloRuns();
        const allRuns = soloResponse?.runs || [];
        // Keep the full list so the solo home can show a Continue card plus any
        // past adventures.
        uiState.soloRuns = allRuns;
        const activeRuns = allRuns.filter((run) => run?.status === "active");
        if (activeRuns.length > 0) {
          const mostRecent = activeRuns[0];
          if (justExited) {
            // Explicit exit: land on the solo home with a Continue card instead
            // of auto-re-entering the run we just left.
            uiState.resumeRunId = mostRecent.runId;
          } else {
            window.location.search = `?soloRunId=${encodeURIComponent(mostRecent.runId)}`;
            return;
          }
        }
      } catch {
        // fall through to the solo home if solo-run listing fails
      }
    }
  }

  scheduleRender();
}

if (soloRunIdFromUrl) {
  mountSoloSceneShell(appRoot, {
    apiClient,
    runId: soloRunIdFromUrl
  });
} else {
  bootstrap();
}

window.addEventListener("beforeunload", () => {
  realtimeClient.close();
});
