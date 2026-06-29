import { createApiClient } from "./api/client.js";
import { renderAiGmConsole, bindAiGmConsole } from "./components/aiGmConsole.js";
import { renderCampaignForge, bindCampaignForge } from "./components/campaignForge.js";
import { renderCharacterVault, bindCharacterVault } from "./components/characterVault.js";
import { renderCommandCenter, bindCommandCenter } from "./components/commandCenter.js";
import { renderCompendium, bindCompendium } from "./components/compendium.js";
import { renderHomebrewStudio, bindHomebrewStudio } from "./components/homebrewStudio.js";
import { renderHomebrewManager, bindHomebrewManager, homebrewDraftToItem, itemToDraft } from "./components/homebrewManager.js";
import { renderOnboardingFlow, bindOnboardingFlow } from "./components/onboardingFlow.js";
import { ABILITIES, pointBuyCost, rollAbilityScores } from "../server/solo/dndData.js";
import { renderSidebar } from "./components/sidebar.js";
import {
  mountSoloSceneShell,
  soloThemeVarString,
  normalizeSkin,
  normalizeFontSet,
  renderSoloThemeSwitcher,
  readSoloThemePref,
  writeSoloThemePref,
  SOLO_SKIN_STORAGE_KEY,
  SOLO_FONT_STORAGE_KEY
} from "./components/soloSceneShell.js";
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
  soloRunPendingDelete: null,
  // runId currently in inline-rename mode on the home screen (null = none).
  soloRunPendingRename: null,
  apiHealthy: false,
  realtimeConnected: false,
  activeRealtimeCampaignId: null,
  showAuthPanel: false,
  showAccountMenu: false,
  // Manual custom homebrew content (user-authored). customContentItems = the raw
  // stored items (for the manager); customContent = the SRD-shaped catalogs the
  // character creator + build consume. showHomebrew toggles the manager view.
  customContentItems: [],
  customContent: { races: [], classes: [], backgrounds: [] },
  showHomebrew: false,
  homebrew: { type: "race", draft: {}, editingId: null, error: "", saving: false },
  // App-wide skin/font theme for the home + onboarding surfaces. Shares the same
  // persisted keys as the in-run solo shell, so a choice made anywhere applies
  // everywhere. Reads are guarded (privacy browsers throw on localStorage).
  skin: normalizeSkin(readSoloThemePref(SOLO_SKIN_STORAGE_KEY, "ashen")),
  fontSet: normalizeFontSet(readSoloThemePref(SOLO_FONT_STORAGE_KEY, "tome")),
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

// "2 hours ago" / "yesterday" / "3 days ago" from an ISO timestamp. Used for the
// home cards' last-played line so players can tell which campaign is freshest.
// Returns "" for an unparseable/empty value so the caller can omit the line.
function relativeTime(iso) {
  const then = Date.parse(iso || "");
  if (!Number.isFinite(then)) {
    return "";
  }
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months} month${months === 1 ? "" : "s"} ago`;
  const years = Math.round(months / 12);
  return `${years} year${years === 1 ? "" : "s"} ago`;
}

// The default home-card title when the player hasn't renamed a run:
// "<Character> — <World>". Falls back gracefully on sparse runs.
function defaultRunTitle(run) {
  const charName = run?.player?.displayName || "Adventurer";
  const worldName = run?.world?.name || "Untitled World";
  return `${charName} — ${worldName}`;
}

// The shown title: a player-chosen `run.title` if present, else the default.
function runDisplayTitle(run) {
  const custom = typeof run?.title === "string" ? run.title.trim() : "";
  return custom || defaultRunTitle(run);
}

// Minimal header for the solo player's surfaces (home + login). Deliberately
// omits the 7-tab GM/multiplayer nav (renderTopbar) — solo players never see it.
// Keeps only the brand and the auth/account affordances that bindAppEvents wires.
function renderSoloHeader(user, accountMenuOpen = false, skin = "ashen", fontSet = "tome") {
  return `
    <header class="topbar solo-topbar">
      <div class="brand">
        <h1>Inkborne</h1>
        <span>AI RPG</span>
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
                      <div class="account-dropdown account-dropdown--wide" role="menu">
                        <button class="account-dropdown-item" role="menuitem" data-action="open-account">Account Settings</button>
                        <button class="account-dropdown-item" role="menuitem" data-action="open-homebrew">Manage Homebrew</button>
                        <div class="account-dropdown-appearance">
                          <span class="account-dropdown-kicker">Appearance</span>
                          ${renderSoloThemeSwitcher(skin, fontSet)}
                        </div>
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
  const runId = run?.runId || "";
  const status = run?.status || "unknown";
  // completed/abandoned runs are concluded — still re-openable (Continue loads
  // the scene at its final state to review), but badged so it's clear they're done.
  const finished = status === "completed" || status === "abandoned";
  const statusLabel = status === "completed" ? "Completed" : status === "abandoned" ? "Abandoned" : "Active";
  const outcome = run?.outcome && run.outcome !== status ? ` (${run.outcome})` : "";

  const title = runDisplayTitle(run);

  // Character line: "Name · Race Class · Lv N" — built from whatever is present.
  const charName = run?.player?.displayName || "Adventurer";
  const race = typeof run?.player?.race === "string" ? run.player.race.trim() : "";
  const klass = typeof run?.player?.characterClass === "string" ? run.player.characterClass.trim() : "";
  const level = Number.isFinite(Number(run?.player?.level)) ? Number(run.player.level) : null;
  const archetype = [race, klass].filter(Boolean).join(" ");
  const charBits = [charName, archetype, level !== null ? `Lv ${level}` : ""].filter(Boolean).join(" · ");

  // Where they are + what they're chasing.
  const locName = run?.locations?.[run?.currentLocationId]?.name || "";
  const quest = run?.quests?.quest_main || (run?.quests ? Object.values(run.quests)[0] : null) || null;
  const objective = typeof quest?.objective === "string" ? quest.objective.trim() : "";
  const turns = Array.isArray(run?.timeline) ? run.timeline.length : 0;
  const lastPlayed = relativeTime(run?.updatedAt) || relativeTime(run?.createdAt);

  const confirming = runId && uiState.soloRunPendingDelete === runId;
  const renaming = runId && uiState.soloRunPendingRename === runId;
  const continueLabel = finished ? "Review" : primary ? "Continue your adventure" : "Continue";

  // Inline rename takes over the card body when active, so the player edits in place.
  if (renaming) {
    return `
    <article class="solo-home-run-card${primary ? " primary" : ""}${finished ? " finished" : ""}">
      <form class="solo-home-run-rename" data-action="submit-rename-run" data-run-id="${escapeHtml(runId)}">
        <label class="solo-home-run-rename-label" for="rename-${escapeHtml(runId)}">Campaign name</label>
        <input id="rename-${escapeHtml(runId)}" class="solo-home-run-rename-input" name="title" type="text"
               maxlength="80" value="${escapeHtml(title)}" placeholder="${escapeHtml(defaultRunTitle(run))}"
               aria-label="Campaign name" autocomplete="off" />
        <div class="solo-home-run-rename-actions">
          <button type="submit" class="solo-home-run-rename-save" data-action="save-rename-run" data-run-id="${escapeHtml(runId)}">Save</button>
          <button type="button" class="solo-home-run-rename-cancel" data-action="cancel-rename-run" data-run-id="${escapeHtml(runId)}">Cancel</button>
        </div>
      </form>
    </article>`;
  }

  return `
    <article class="solo-home-run-card${primary ? " primary" : ""}${finished ? " finished" : ""}">
      <div class="solo-home-run-meta">
        <div class="solo-home-run-titlerow">
          <strong class="solo-home-run-title">${escapeHtml(title)}</strong>
          <span class="solo-home-run-status solo-home-run-status--${escapeHtml(status)}">${escapeHtml(statusLabel)}${escapeHtml(outcome)}</span>
        </div>
        <span class="small solo-home-run-char">${escapeHtml(charBits)}</span>
        ${locName ? `<span class="small solo-home-run-where">📍 ${escapeHtml(locName)}</span>` : ""}
        ${objective ? `<span class="small solo-home-run-quest">${quest?.title ? `<em>${escapeHtml(quest.title)}:</em> ` : ""}${escapeHtml(objective)}</span>` : ""}
        <span class="small solo-home-run-footnote">${lastPlayed ? `Last played ${escapeHtml(lastPlayed)}` : ""}${lastPlayed && turns ? " · " : ""}${turns ? `${turns} turn${turns === 1 ? "" : "s"}` : ""}</span>
      </div>
      ${
        confirming
          ? `<div class="solo-home-run-actions solo-home-run-actions--confirm">
               <span class="solo-home-run-confirm" role="alertdialog" aria-label="Confirm delete">
                 <span class="solo-home-run-confirm-text">Delete “${escapeHtml(title)}”? This can't be undone.</span>
                 <button class="solo-home-run-delete-confirm" data-action="confirm-delete-run" data-run-id="${escapeHtml(runId)}">Delete</button>
                 <button class="solo-home-run-delete-cancel" data-action="cancel-delete-run" data-run-id="${escapeHtml(runId)}">Cancel</button>
               </span>
             </div>`
          : `<div class="solo-home-run-actions">
               <button class="solo-home-run-continue" data-action="open-run" data-run-id="${escapeHtml(runId)}">${continueLabel}</button>
               <div class="solo-home-run-secondary">
                 <button class="solo-home-run-rename-btn" data-action="request-rename-run" data-run-id="${escapeHtml(runId)}" aria-label="Rename “${escapeHtml(title)}”">Rename</button>
                 <button class="solo-home-run-delete" data-action="request-delete-run" data-run-id="${escapeHtml(runId)}" aria-label="Delete “${escapeHtml(title)}”">Delete</button>
               </div>
             </div>`
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

  // The home is a ZONE/GRID dashboard, not a lone column. The primary play column
  // (.solo-home) keeps its current readable width; on wide/ultrawide viewports the
  // reserved zones below FRAME the otherwise-empty leather so the space reads as
  // "a dashboard with room to grow" rather than a narrow column floating in black.
  // These zones are decorative placeholders for future modules (featured worlds,
  // dispatches/news, story templates) — aria-hidden, and collapsed on narrow
  // screens (see .solo-home-zone display rules in styles.css). No real content yet.
  return `
    <main class="panel main solo-home-main">
      <div class="solo-home-dashboard">
        <aside class="solo-home-zone solo-home-zone-rail solo-home-zone-left" aria-hidden="true">
          <span class="solo-home-zone-kicker">Featured Worlds</span>
          <span class="solo-home-zone-note">Curated worlds to drop straight into — coming soon.</span>
        </aside>
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
                   <h3>Saved campaigns</h3>
                   <div class="solo-home-run-list">
                     ${pastRuns.map((run) => renderSoloRunCard(run)).join("")}
                   </div>
                 </section>`
              : ""
          }
        </section>
        <aside class="solo-home-zone solo-home-zone-rail solo-home-zone-right" aria-hidden="true">
          <span class="solo-home-zone-kicker">Dispatches</span>
          <span class="solo-home-zone-note">Release notes and world news — coming soon.</span>
        </aside>
        <div class="solo-home-zone solo-home-zone-shelf" aria-hidden="true">
          <span class="solo-home-zone-kicker">Story Templates</span>
          <span class="solo-home-zone-note">Ready-made premises and one-shots to spin up fast — coming soon.</span>
        </div>
      </div>
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

// ---- Custom homebrew content ----
// Loads the user's manually-authored content. buildContent is the SRD-shaped
// catalog the character creator + build use; items is the raw list (manager).
async function loadCustomContent() {
  try {
    const res = await apiClient.listCustomHomebrew();
    uiState.customContentItems = Array.isArray(res?.items) ? res.items : [];
    uiState.customContent = res?.buildContent || { races: [], classes: [], backgrounds: [] };
  } catch {
    uiState.customContentItems = [];
    uiState.customContent = { races: [], classes: [], backgrounds: [] };
  }
}

function openHomebrew() {
  uiState.showHomebrew = true;
  uiState.showAccountMenu = false;
  uiState.homebrew = { type: "race", draft: {}, editingId: null, error: "", saving: false };
  scheduleRender();
}
function closeHomebrew() {
  uiState.showHomebrew = false;
  scheduleRender();
}
function hbType(type) {
  uiState.homebrew = { ...uiState.homebrew, type, draft: {}, editingId: null, error: "" };
  scheduleRender();
}
function hbField(key, value) {
  uiState.homebrew = { ...uiState.homebrew, draft: { ...(uiState.homebrew.draft || {}), [key]: value } };
  // No re-render on free-text input (preserve caret); state is read on submit.
}
function hbCancelEdit() {
  uiState.homebrew = { ...uiState.homebrew, draft: {}, editingId: null, error: "" };
  scheduleRender();
}
async function hbSubmit() {
  const hb = uiState.homebrew;
  if (hb.saving) {
    return;
  }
  const item = homebrewDraftToItem(hb.type, hb.draft || {});
  uiState.homebrew = { ...hb, saving: true, error: "" };
  scheduleRender();
  try {
    await apiClient.createCustomHomebrew(item);
    // Edit = replace: the new item is created, then the original is removed.
    if (hb.editingId) {
      try {
        await apiClient.deleteCustomHomebrew(hb.editingId);
      } catch {
        // best-effort; the new copy is already stored
      }
    }
    await loadCustomContent();
    uiState.homebrew = { type: hb.type, draft: {}, editingId: null, error: "", saving: false };
  } catch (error) {
    uiState.homebrew = { ...uiState.homebrew, saving: false, error: String(error?.message || error || "Could not save custom content.") };
  }
  scheduleRender();
}
async function hbDelete(id) {
  try {
    await apiClient.deleteCustomHomebrew(id);
    await loadCustomContent();
    if (uiState.homebrew.editingId === id) {
      uiState.homebrew = { ...uiState.homebrew, draft: {}, editingId: null };
    }
  } catch (error) {
    uiState.homebrew = { ...uiState.homebrew, error: String(error?.message || error || "Could not delete.") };
  }
  scheduleRender();
}
function hbEdit(id) {
  const item = (uiState.customContentItems || []).find((entry) => entry.id === id);
  if (!item) {
    return;
  }
  uiState.homebrew = { type: item.type, draft: itemToDraft(item), editingId: id, error: "", saving: false };
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
  const step = Math.max(1, Math.min(6, (c.step || 1) + delta));
  uiState.onboarding.character = { ...c, step };
  // Safety net: ensure the draft portrait is requested by the time the player
  // reaches the Review step, even if the field-change trigger was missed or a
  // prior attempt failed. maybeRequestDraftPortrait is idempotent — it only
  // fires when race + class are set and this combo hasn't already been requested
  // (a failure clears the key, so this re-attempts), so it never double-requests
  // a successful or in-flight portrait.
  if (step === 6) {
    maybeRequestDraftPortrait();
  }
  scheduleRender();
}
function charField(field, value) {
  uiState.onboarding.character = { ...(uiState.onboarding.character || defaultCharacterState()), [field]: value };
  // Race/class/background drive the portrait. Once both race AND class are set,
  // (re)generate the draft portrait so it's ready by the Review step. Debounced
  // 500ms so rapidly flipping through race/class doesn't fire a request per click.
  scheduleDraftPortrait();
  scheduleRender();
}

let draftPortraitDebounceTimer = null;
function scheduleDraftPortrait() {
  if (draftPortraitDebounceTimer) {
    clearTimeout(draftPortraitDebounceTimer);
  }
  draftPortraitDebounceTimer = setTimeout(() => {
    draftPortraitDebounceTimer = null;
    maybeRequestDraftPortrait();
  }, 500);
}

// ---- Mid-creation (draft) portrait generation ----
// Generates a portrait before a run exists, keyed server-side by the character
// fields. Re-requests only when the visual inputs (race/class/background)
// actually change, so it never regenerates on every click/keystroke.
function stopDraftPortraitPoll() {
  if (uiState.onboarding.draftPortraitPollTimer) {
    clearTimeout(uiState.onboarding.draftPortraitPollTimer);
    uiState.onboarding.draftPortraitPollTimer = null;
  }
}

function startDraftPortraitPoll(draftId, key) {
  stopDraftPortraitPoll();
  let attempts = 0;
  const tick = async () => {
    attempts += 1;
    if (uiState.onboarding.draftPortraitKey !== key) {
      return; // superseded by a newer character combo
    }
    try {
      const res = await apiClient.getDraftPortrait(draftId);
      if (uiState.onboarding.draftPortraitKey !== key) {
        return;
      }
      if (res?.status === "generated" && res.uri) {
        uiState.onboarding.draftPortraitUri = res.uri;
        uiState.onboarding.draftPortraitStatus = "generated";
        uiState.onboarding.portraitEditPending = false;
        recordPortraitVersion(draftId, res.uri); // version history (gen / redo / edit)
        scheduleRender();
        return; // done — stop polling
      }
      if (res?.status === "failed") {
        uiState.onboarding.draftPortraitStatus = "failed";
        uiState.onboarding.portraitEditPending = false;
        // Clear the key so the combo can be retried (e.g. on returning to the
        // Review step) instead of sticking on "failed" forever.
        uiState.onboarding.draftPortraitKey = null;
        scheduleRender();
        return;
      }
    } catch {
      // transient — keep polling within the attempt budget
    }
    if (attempts < 20) {
      uiState.onboarding.draftPortraitPollTimer = setTimeout(tick, 3000);
    } else {
      uiState.onboarding.draftPortraitStatus = "failed";
      uiState.onboarding.portraitEditPending = false;
      uiState.onboarding.draftPortraitKey = null; // allow a retry after a timeout
      scheduleRender();
    }
  };
  uiState.onboarding.draftPortraitPollTimer = setTimeout(tick, 3000);
}

async function maybeRequestDraftPortrait() {
  const c = uiState.onboarding.character || {};
  if (!c.race || !c.characterClass) {
    return; // need both race + class before a meaningful portrait
  }
  // Key on the visual-driving fields plus the redo nonce, so a Redo (which bumps
  // the nonce) re-fires this for the same race/class instead of being skipped.
  const nonce = uiState.onboarding.draftPortraitNonce || 0;
  const key = `${c.race}|${c.characterClass}|${c.background || ""}|${nonce}`;
  if (key === uiState.onboarding.draftPortraitKey) {
    return; // already requested for this exact combo
  }
  uiState.onboarding.draftPortraitKey = key;
  uiState.onboarding.draftPortraitStatus = "generating";
  // A freshly-generating portrait is not yet accepted: the player must explicitly
  // lock it (FIX G), and any race/class/redo change un-accepts the prior one.
  uiState.onboarding.draftPortraitAccepted = false;
  // Keep any existing portraitUri: while a race/class change regenerates, the
  // preview shows the CURRENT image under a pulsing "Regenerating…" overlay
  // (status "generating" + a uri present), so the box is never blank. The new
  // image replaces it when the poll reports "generated".
  uiState.onboarding.draftPortraitId = null;
  stopDraftPortraitPoll();
  scheduleRender();

  const world = uiState.onboarding.worldPreview || uiState.onboarding.worldDef || {};
  try {
    const res = await apiClient.requestDraftPortrait({
      character: {
        name: c.name,
        race: c.race,
        characterClass: c.characterClass,
        background: c.background,
        pronouns: c.pronouns
      },
      world: { tone: world.tone, artStyle: world.artStyle, name: world.name },
      nonce
    });
    if (uiState.onboarding.draftPortraitKey !== key) {
      return; // combo changed while awaiting — drop this response
    }
    applyPortraitEntitlement(res?.entitlement); // surfaces "N edits left" after gen
    if (res?.draftId) {
      uiState.onboarding.draftPortraitId = res.draftId;
      startDraftPortraitPoll(res.draftId, key);
    } else {
      // No draftId returned (e.g. image quota reached for a free user). Don't hang
      // on the "generating" spinner forever — surface a clear status and clear the
      // key so it can be retried (on reaching Review, on Redo, or after upgrade).
      uiState.onboarding.draftPortraitStatus = res?.status === "quota_reached" ? "quota" : "failed";
      uiState.onboarding.draftPortraitKey = null;
      scheduleRender();
    }
  } catch {
    if (uiState.onboarding.draftPortraitKey === key) {
      uiState.onboarding.draftPortraitStatus = "failed";
      // Clear the key so a stale-server 404 or transient network error can be
      // retried (e.g. on reaching the Review step) rather than sticking.
      uiState.onboarding.draftPortraitKey = null;
      scheduleRender();
    }
  }
}

// Reroll the draft portrait with a fresh seed: bump the nonce (which changes the
// request key + the server-side id/seed) and re-request immediately. The current
// image stays under a "Regenerating…" overlay until the new one lands.
function redoDraftPortrait() {
  const c = uiState.onboarding.character || {};
  if (!c.race || !c.characterClass) {
    return; // nothing to reroll until there's a portrait to reroll
  }
  // A reroll un-accepts the current portrait: the new image must be accepted in
  // its own right (FIX G).
  uiState.onboarding.draftPortraitAccepted = false;
  uiState.onboarding.draftPortraitNonce = (uiState.onboarding.draftPortraitNonce || 0) + 1;
  maybeRequestDraftPortrait();
}

// FIX G: explicit accept. The portrait is not treated as final until the player
// locks it; Redo stays available on every portrait until this is clicked. The
// accepted portrait is the current draftPortraitId, which enterWorld carries
// into the run.
function acceptDraftPortrait() {
  if (!uiState.onboarding.draftPortraitUri) {
    return; // nothing to accept yet
  }
  uiState.onboarding.draftPortraitAccepted = true;
  scheduleRender();
}

// ---- Conversational portrait editor (version history + entitlement gate) ----
// Folds the daily image-quota (entitlements.canGenerateImage, surfaced on every
// portrait response) into onboarding state so the UI can show "N edits left" and
// a soft-upgrade prompt. unlimited === remaining null (paid / BYOK).
function applyPortraitEntitlement(ent) {
  if (!ent || typeof ent !== "object") {
    return;
  }
  const remaining = ent.image && typeof ent.image.remaining !== "undefined"
    ? ent.image.remaining
    : (typeof ent.imageQuotaRemaining === "number" ? ent.imageQuotaRemaining : null);
  uiState.onboarding.portraitEntitlement = {
    unlimited: ent.unlimited === true || remaining === null,
    remaining: typeof remaining === "number" ? remaining : null,
    tier: ent.tier || null
  };
}

// Record every generated portrait as a version (deduped by uri) so the player can
// always revert. The poll calls this on each "generated" — covers first gen,
// Redo, and edits alike.
function recordPortraitVersion(id, uri) {
  if (!uri) {
    return;
  }
  const list = uiState.onboarding.portraitVersions || [];
  if (list.some((v) => v.uri === uri)) {
    return;
  }
  uiState.onboarding.portraitVersions = [...list, { id: id || `v${list.length + 1}`, uri }];
}

// Returns true when the daily image quota is spent (and not unlimited) — the
// editor soft-gates locally before spending a network call.
function portraitQuotaExhausted() {
  const ent = uiState.onboarding.portraitEntitlement;
  return Boolean(ent) && ent.unlimited !== true && typeof ent.remaining === "number" && ent.remaining <= 0;
}

function portraitEditInput(value) {
  // Mirror charInput: update the draft without a re-render so the caret holds.
  uiState.onboarding.portraitEditDraft = String(value || "");
}

// Apply ONE conversational tweak to the CURRENT portrait. Bumps the nonce (fresh
// draftId), un-accepts, and polls the new version through the SAME pipeline as a
// generation. Respects the entitlement gate; a spent quota shows the soft-upgrade
// prompt instead of a broken call.
async function submitPortraitEdit(rawInstruction) {
  const instruction = String(rawInstruction || uiState.onboarding.portraitEditDraft || "").trim();
  const sourceUri = uiState.onboarding.draftPortraitUri;
  if (!instruction || !sourceUri || uiState.onboarding.portraitEditPending) {
    return;
  }
  if (portraitQuotaExhausted()) {
    uiState.onboarding.portraitEditError = "quota";
    scheduleRender();
    return;
  }
  const c = uiState.onboarding.character || {};
  const world = uiState.onboarding.worldPreview || uiState.onboarding.worldDef || {};
  uiState.onboarding.draftPortraitNonce = (uiState.onboarding.draftPortraitNonce || 0) + 1;
  const nonce = uiState.onboarding.draftPortraitNonce;
  // A dedicated key so the edit's poll is not dropped as "superseded" and a later
  // race/class change still re-keys cleanly.
  const key = `${c.race}|${c.characterClass}|${c.background || ""}|edit:${nonce}`;
  uiState.onboarding.draftPortraitKey = key;
  uiState.onboarding.draftPortraitStatus = "generating"; // current image stays under the overlay
  uiState.onboarding.draftPortraitAccepted = false; // an edit un-accepts (must re-accept)
  uiState.onboarding.draftPortraitId = null;
  uiState.onboarding.portraitEditPending = true;
  uiState.onboarding.portraitEditError = "";
  stopDraftPortraitPoll();
  scheduleRender();
  try {
    const res = await apiClient.editDraftPortrait({
      character: { name: c.name, race: c.race, characterClass: c.characterClass, background: c.background, pronouns: c.pronouns },
      world: { tone: world.tone, artStyle: world.artStyle, name: world.name },
      instruction,
      sourceImageUrl: sourceUri,
      nonce
    });
    if (uiState.onboarding.draftPortraitKey !== key) {
      return; // superseded by a newer action
    }
    applyPortraitEntitlement(res?.entitlement);
    if (res?.status === "quota_reached") {
      uiState.onboarding.portraitEditPending = false;
      uiState.onboarding.portraitEditError = "quota";
      uiState.onboarding.draftPortraitStatus = "generated"; // keep the current portrait
      uiState.onboarding.draftPortraitKey = null;
      scheduleRender();
      return;
    }
    if (res?.draftId) {
      uiState.onboarding.portraitConsistentEdit = res.consistentEdit === true;
      uiState.onboarding.portraitEditDraft = "";
      uiState.onboarding.draftPortraitId = res.draftId;
      startDraftPortraitPoll(res.draftId, key); // poll clears pending + records the version
    } else {
      uiState.onboarding.portraitEditPending = false;
      uiState.onboarding.portraitEditError = "failed";
      uiState.onboarding.draftPortraitStatus = "generated";
      uiState.onboarding.draftPortraitKey = null;
      scheduleRender();
    }
  } catch {
    if (uiState.onboarding.draftPortraitKey === key) {
      uiState.onboarding.portraitEditPending = false;
      uiState.onboarding.portraitEditError = "failed";
      uiState.onboarding.draftPortraitStatus = "generated";
      uiState.onboarding.draftPortraitKey = null;
      scheduleRender();
    }
  }
}

// Click a thumbnail to revert: the chosen version becomes the current portrait
// (and the one Accept will carry into the run). It un-accepts so the player
// re-confirms the choice (preserves FIX G accept-is-terminal semantics).
function revertPortraitVersion(id) {
  const version = (uiState.onboarding.portraitVersions || []).find((v) => v.id === id);
  if (!version) {
    return;
  }
  stopDraftPortraitPoll();
  uiState.onboarding.draftPortraitUri = version.uri;
  uiState.onboarding.draftPortraitId = version.id;
  uiState.onboarding.draftPortraitStatus = "generated";
  uiState.onboarding.draftPortraitAccepted = false;
  uiState.onboarding.draftPortraitKey = null;
  uiState.onboarding.portraitEditPending = false;
  uiState.onboarding.portraitEditError = "";
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
      },
      // Carry the portrait generated during creation into the new run.
      draftPortraitId: uiState.onboarding.draftPortraitId || null
    });
    if (response?.runId) {
      stopDraftPortraitPoll();
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

  // Appearance: skin + font selection from the account dropdown. Persisted (same
  // keys the in-run shell uses) so the choice applies app-wide. The menu is left
  // open after a pick so the change is visible and multiple can be tried.
  appRoot.querySelectorAll("[data-solo-skin]").forEach((button) => {
    button.addEventListener("click", () => {
      uiState.skin = normalizeSkin(button.getAttribute("data-solo-skin"));
      writeSoloThemePref(SOLO_SKIN_STORAGE_KEY, uiState.skin);
      scheduleRender();
    });
  });
  appRoot.querySelectorAll("[data-solo-font]").forEach((button) => {
    button.addEventListener("click", () => {
      uiState.fontSet = normalizeFontSet(button.getAttribute("data-solo-font"));
      writeSoloThemePref(SOLO_FONT_STORAGE_KEY, uiState.fontSet);
      scheduleRender();
    });
  });

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

  // Inline rename: Rename flips the card into an edit field; Save persists the
  // title to the run (survives reload) and updates the in-memory list; Cancel
  // backs out. Entering rename mode clears any pending delete on that card.
  appRoot.querySelectorAll("[data-action='request-rename-run']").forEach((button) => {
    button.addEventListener("click", () => {
      uiState.soloRunPendingRename = button.getAttribute("data-run-id") || null;
      uiState.soloRunPendingDelete = null;
      scheduleRender();
      // Focus + select the field once it has rendered, so typing replaces the title.
      if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(() => {
          const input = appRoot.querySelector(".solo-home-run-rename-input");
          if (input) {
            input.focus();
            if (typeof input.select === "function") input.select();
          }
        });
      }
    });
  });
  appRoot.querySelectorAll("[data-action='cancel-rename-run']").forEach((button) => {
    button.addEventListener("click", () => {
      uiState.soloRunPendingRename = null;
      scheduleRender();
    });
  });
  appRoot.querySelectorAll("[data-action='submit-rename-run']").forEach((form) => {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const runId = form.getAttribute("data-run-id");
      const input = form.querySelector(".solo-home-run-rename-input");
      if (!runId || !input) {
        return;
      }
      const title = String(input.value || "").trim();
      input.disabled = true;
      try {
        const response = await apiClient.renameSoloRun(runId, title);
        // Mirror the persisted title into the in-memory list so the re-render
        // shows it immediately (server normalizes/clears; trust its echo).
        const persisted = typeof response?.run?.title === "string" ? response.run.title : "";
        uiState.soloRuns = (uiState.soloRuns || []).map((run) =>
          run?.runId === runId ? { ...run, title: persisted } : run
        );
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error("Failed to rename solo run", error);
        input.disabled = false;
      } finally {
        uiState.soloRunPendingRename = null;
        scheduleRender();
      }
    });
  });

  // Past-adventure delete: a Delete button flips the card into an inline confirm
  // state (no browser dialog); Cancel backs out; Confirm calls the API, drops the
  // run from uiState.soloRuns, and re-renders.
  appRoot.querySelectorAll("[data-action='request-delete-run']").forEach((button) => {
    button.addEventListener("click", () => {
      uiState.soloRunPendingDelete = button.getAttribute("data-run-id") || null;
      scheduleRender();
    });
  });
  appRoot.querySelectorAll("[data-action='cancel-delete-run']").forEach((button) => {
    button.addEventListener("click", () => {
      uiState.soloRunPendingDelete = null;
      scheduleRender();
    });
  });
  appRoot.querySelectorAll("[data-action='confirm-delete-run']").forEach((button) => {
    button.addEventListener("click", async () => {
      const runId = button.getAttribute("data-run-id");
      if (!runId) {
        return;
      }
      button.disabled = true;
      try {
        await apiClient.deleteSoloRun(runId);
        uiState.soloRuns = (uiState.soloRuns || []).filter((run) => run?.runId !== runId);
        if (uiState.resumeRunId === runId) {
          uiState.resumeRunId = null;
        }
      } catch (error) {
        // Keep the run on failure; nothing destructive happened server-side.
        // eslint-disable-next-line no-console
        console.error("Failed to delete solo run", error);
      } finally {
        uiState.soloRunPendingDelete = null;
        scheduleRender();
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

  const openHomebrewBtn = appRoot.querySelector("[data-action='open-homebrew']");
  if (openHomebrewBtn) {
    openHomebrewBtn.addEventListener("click", () => openHomebrew());
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

  // Make the user's custom homebrew available to the character creator render.
  uiState.onboarding.customContent = uiState.customContent;

  const html = (user && uiState.showHomebrew)
    ? `
      <div class="app-shell" data-app-themed style="${soloThemeVarString(uiState.skin, uiState.fontSet)}">
        ${renderSoloHeader(user, uiState.showAccountMenu, uiState.skin, uiState.fontSet)}
        ${authMessageHtml}
        ${renderHomebrewManager(uiState)}
      </div>
    `
    : onboardingVisible
    ? `
      <div class="app-shell" data-app-themed style="${soloThemeVarString(uiState.skin, uiState.fontSet)}">
        ${renderSoloHeader(user, uiState.showAccountMenu, uiState.skin, uiState.fontSet)}
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
      <div class="app-shell" data-app-themed style="${soloThemeVarString(uiState.skin, uiState.fontSet)}">
        ${renderSoloHeader(user, uiState.showAccountMenu, uiState.skin, uiState.fontSet)}
        ${authMessageHtml}
        ${renderAuthPanel(state)}
        ${renderSoloHome(state)}
      </div>
    `
    : `
      <div class="app-shell" data-app-themed style="${soloThemeVarString(uiState.skin, uiState.fontSet)}">
        ${renderSoloHeader(user, uiState.showAccountMenu, uiState.skin, uiState.fontSet)}
        ${authMessageHtml}
        <main class="panel main solo-home-main">
          <section class="module-card solo-login-card">
            <h2>Welcome to Inkborne</h2>
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

  if (user && uiState.showHomebrew) {
    bindHomebrewManager(appRoot, {
      onType: hbType,
      onField: hbField,
      onSubmit: hbSubmit,
      onCancelEdit: hbCancelEdit,
      onEdit: hbEdit,
      onDelete: hbDelete,
      onClose: closeHomebrew
    });
  }

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
        onPortraitRedo: redoDraftPortrait,
        onPortraitAccept: acceptDraftPortrait,
        onPortraitEdit: submitPortraitEdit,
        onPortraitEditInput: portraitEditInput,
        onPortraitRevert: revertPortraitVersion,
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
        await loadCustomContent();
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
