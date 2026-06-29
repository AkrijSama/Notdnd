import { completeSoloRun, fetchSoloGmScene, fetchSoloScene, postSoloAction, redoLocationImage, saveLocationImage, saveSoloBattleMap } from "./soloSceneApi.js";
import {
  DEFAULT_VISION_TILES,
  computeReachable,
  computeRevealed,
  isLegalMove,
  moveCost,
  tilesForSpeed
} from "./battleMapEngine.js";

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function typeLabel(value) {
  return String(value || "entity").replaceAll("_", " ");
}

function labelForAction(action = {}) {
  if (action.label) {
    return action.label;
  }
  if (action.type === "move" && action.toLocationId) {
    return `Move to ${action.toLocationId}`;
  }
  return typeLabel(action.type || "Action");
}

function titleCase(value) {
  return typeLabel(value)
    .split(" ")
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function renderEmpty(label) {
  return `<div class="solo-empty-state">${escapeHtml(label)}</div>`;
}

function renderTags(tags = []) {
  if (!Array.isArray(tags) || tags.length === 0) {
    return "";
  }
  return `<div class="solo-tag-row">${tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("")}</div>`;
}

function renderStats(stats = {}) {
  const entries = Object.entries(stats || {});
  if (entries.length === 0) {
    return renderEmpty("No stats available yet.");
  }
  return `
    <div class="solo-stat-grid">
      ${entries
        .map(
          ([key, value]) => `
            <div class="solo-stat">
              <span>${escapeHtml(typeLabel(key))}</span>
              <strong>${escapeHtml(value)}</strong>
            </div>
          `
        )
        .join("")}
    </div>
  `;
}

function renderCompactList(items, emptyLabel, renderItem) {
  if (!Array.isArray(items) || items.length === 0) {
    return renderEmpty(emptyLabel);
  }
  return `<div class="solo-compact-list">${items.map(renderItem).join("")}</div>`;
}

export function createMoveAction(scene, move) {
  return {
    type: "move",
    actorId: "player",
    fromLocationId: scene?.location?.locationId || null,
    toLocationId: move?.locationId || move?.toLocationId,
    direction: move?.direction || null
  };
}

export function createInspectAction(entity) {
  return {
    type: "inspect",
    actorId: "player",
    entityId: entity?.entityId
  };
}

export function createSearchAction() {
  return {
    type: "search",
    actorId: "player"
  };
}

export function createTalkAction(entityOrAction = {}) {
  return {
    type: "talk",
    actorId: "player",
    targetEntityId: entityOrAction.entityId || entityOrAction.targetEntityId
  };
}

export function createRestAction(action = {}) {
  return {
    type: "rest",
    actorId: "player",
    restType: action.restType || "short"
  };
}

export function createUseItemAction(itemOrAction = {}) {
  return {
    type: "use_item",
    actorId: "player",
    itemId: itemOrAction.itemId || null,
    targetEntityId: itemOrAction.targetEntityId || null,
    targetLocationId: itemOrAction.targetLocationId || null
  };
}

export function createAttemptAction(attempt = {}) {
  return {
    type: "attempt",
    actorId: "player",
    intent: attempt.intent || "",
    targetId: attempt.targetId || null
  };
}

export function renderSceneHeader(scene = {}, state = {}) {
  const location = scene.location || {};
  const time = scene.world?.time || scene.time || {};
  const timeLabel = [time.day !== undefined ? `Day ${time.day}` : "", time.tick !== undefined ? `Tick ${time.tick}` : ""]
    .filter(Boolean)
    .join(" / ");

  return `
    <header class="solo-scene-header">
      <div class="solo-scene-title">
        <div class="small">Solo Run ${escapeHtml(scene.runId || state.runId || "Unknown")}</div>
        <h2>${escapeHtml(location.name || "Unknown Location")}</h2>
      </div>
      <div class="solo-scene-badges">
        ${timeLabel ? `<span class="tag">${escapeHtml(timeLabel)}</span>` : ""}
        <span class="tag">${escapeHtml(scene.edition || "mainline")}</span>
      </div>
    </header>
  `;
}

export function renderGmStatusPanel(gmStatus = null, selectedMode = "placeholder") {
  const status = gmStatus || {
    mode: "placeholder",
    providerAttempted: false,
    providerName: "placeholder",
    providerKind: "placeholder",
    providerSucceeded: false,
    fallbackUsed: false,
    evaluationScore: null,
    warningCodes: [],
    narrationLength: null
  };
  const warnings = Array.isArray(status.warningCodes) ? status.warningCodes : [];
  const mode = status.mode || "placeholder";
  const providerLabel = [status.providerName, status.providerKind].filter(Boolean).join(" / ") || "placeholder";

  return `
    <div class="solo-gm-status-panel" data-gm-mode="${escapeHtml(mode)}">
      <div class="solo-gm-status-topline">
        <span class="tag">GM Mode: ${escapeHtml(titleCase(mode))}</span>
        ${status.fallbackUsed ? `<span class="tag danger">Fallback</span>` : ""}
        ${status.providerSucceeded ? `<span class="tag success">Provider OK</span>` : ""}
      </div>
      <div class="small">
        Provider: ${escapeHtml(providerLabel)}
        ${Number.isFinite(status.evaluationScore) ? ` / Eval ${escapeHtml(status.evaluationScore)}` : ""}
        ${Number.isFinite(status.narrationLength) ? ` / ${escapeHtml(status.narrationLength)} chars` : ""}
      </div>
      ${
        warnings.length
          ? `<div class="solo-tag-row">${warnings.map((warning) => `<span class="tag">${escapeHtml(warning)}</span>`).join("")}</div>`
          : ""
      }
      <div class="solo-gm-mode-toggle" role="group" aria-label="GM narration mode">
        <button
          class="ghost ${selectedMode === "placeholder" ? "selected" : ""}"
          data-solo-gm-mode="placeholder"
          type="button"
        >
          Placeholder
        </button>
        <button
          class="ghost ${selectedMode === "provider" ? "selected" : ""}"
          data-solo-gm-mode="provider"
          type="button"
        >
          Provider
        </button>
      </div>
    </div>
  `;
}

// World-entry opening: the AI-generated GM welcome, shown prominently at the top
// of the scene the first time the player enters (server gates scene.openingNarration
// to the opening moment). Styled as GM voice, distinct from the location copy.
export function renderSoloSceneOpening(openingNarration = "") {
  const text = typeof openingNarration === "string" ? openingNarration.trim() : "";
  if (!text) {
    return "";
  }
  const paragraphs = text
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);
  const body = (paragraphs.length ? paragraphs : [text]).map((part) => `<p>${escapeHtml(part)}</p>`).join("");
  return `
    <section class="solo-scene-opening" role="note" aria-label="Opening narration">
      <span class="solo-scene-opening-kicker">The GM sets the scene</span>
      ${body}
    </section>
  `;
}

// Soft, non-blocking upgrade prompt. Surfaced only for a free user (no BYOK)
// who is at/near their daily image quota or has hit the session cap. Gameplay is
// never blocked — this is a gentle nudge with a placeholder /pricing CTA. Reads
// the entitlement summary the /scene route attaches; returns "" when not
// applicable (paid/BYOK users, or a free user with quota to spare).
export function renderSoloUpgradePrompt(scene = {}) {
  const ent = scene && typeof scene.entitlement === "object" ? scene.entitlement : null;
  if (!ent || ent.tier !== "free" || ent.byok === true || ent.unlimited === true) {
    return "";
  }
  const remaining = ent.imageQuotaRemaining;
  const lowImages = typeof remaining === "number" && remaining <= 2;
  const sessionReached = ent.sessionLimitReached === true;
  if (!lowImages && !sessionReached) {
    return "";
  }
  const message = sessionReached
    ? "You've reached your free daily session limit — upgrade to Adventurer for unlimited play."
    : remaining <= 0
      ? "You've used your free images today — upgrade to Adventurer for unlimited portraits and scenes."
      : `Only ${remaining} free image${remaining === 1 ? "" : "s"} left today — upgrade to Adventurer for unlimited portraits and scenes.`;
  return `
    <aside class="solo-upgrade-prompt" role="note" aria-label="Upgrade prompt" data-solo-upgrade-prompt>
      <span class="solo-upgrade-prompt-msg">${escapeHtml(message)}</span>
      <a class="solo-upgrade-prompt-cta" href="/pricing" data-solo-upgrade-cta>Upgrade</a>
    </aside>
  `;
}

export function renderGmNarrationPanel(gmNarration = null, gmStatus = null, selectedMode = "placeholder", debug = false) {
  const narration = gmNarration?.narration || null;
  if (!narration) {
    return `
      <div class="solo-gm-placeholder">
        <span>Future GM Narration</span>
        <p>Scene narration will appear here later, generated from server truth and memory.</p>
        ${debug ? renderGmStatusPanel(gmStatus, selectedMode) : ""}
      </div>
    `;
  }

  return `
    <div class="solo-gm-placeholder solo-gm-narration">
      <span>${escapeHtml(narration.tone || "neutral")} GM Narration</span>
      <strong>${escapeHtml(narration.title || "Current Scene")}</strong>
      <p>${escapeHtml(narration.body || "")}</p>
      ${
        Array.isArray(narration.sensoryDetails) && narration.sensoryDetails.length
          ? `<div class="solo-tag-row">${narration.sensoryDetails
              .map((detail) => `<span class="tag">${escapeHtml(detail)}</span>`)
              .join("")}</div>`
          : ""
      }
      ${debug ? renderGmStatusPanel(gmStatus, selectedMode) : ""}
    </div>
  `;
}

export function renderLocationPanel(location = {}, gmNarration = null, gmStatus = null, selectedMode = "placeholder", debug = false, options = {}) {
  const imageLabel = location.imageAssetId ? `Image asset: ${location.imageAssetId}` : "No image assigned yet.";
  // Display-only: never surface the internal "placeholder" tag to the player.
  // The underlying location.tags data is left untouched.
  const visibleTags = Array.isArray(location.tags)
    ? location.tags.filter((tag) => String(tag).trim().toLowerCase() !== "placeholder")
    : location.tags;
  return `
    <section class="solo-location-card">
      <div class="solo-location-image" data-image-asset-id="${escapeHtml(location.imageAssetId || "")}">
        <div>
          <div class="solo-image-kicker">Location Image</div>
          <strong>${escapeHtml(imageLabel)}</strong>
        </div>
      </div>
      <div class="solo-location-copy">
        <div class="solo-section-kicker">Current Location</div>
        <h3>${escapeHtml(location.name || "Current Location")}</h3>
        <p>${escapeHtml(location.description || "No location description is available.")}</p>
        ${renderTags(visibleTags)}
        ${options.suppressGm ? "" : renderGmNarrationPanel(gmNarration, gmStatus, selectedMode, debug)}
      </div>
    </section>
  `;
}

export function renderMovementPanel(scene = {}) {
  const moves = Array.isArray(scene.availableMoves) ? scene.availableMoves : [];
  return `
    <section class="module-card solo-panel solo-exits-panel">
      <div class="module-header">
        <h3>Exits</h3>
        <span class="small">${moves.length} available</span>
      </div>
      <div class="solo-button-grid">
        ${
          moves.length
            ? moves
                .map(
                  (move) => `
                    <button
                      class="ghost solo-move-button"
                      data-solo-action="move"
                      data-location-id="${escapeHtml(move.locationId || move.toLocationId || "")}"
                      data-direction="${escapeHtml(move.direction || "")}"
                    >
                      <span>${escapeHtml(move.name || move.locationId || "Connected Location")}</span>
                      ${move.direction ? `<small>${escapeHtml(move.direction)}</small>` : ""}
                    </button>
                  `
                )
                .join("")
            : renderEmpty("No connected locations.")
        }
      </div>
    </section>
  `;
}

export function renderEntityCard(entity = {}, selectedEntityId = "") {
  const selected = entity.entityId && entity.entityId === selectedEntityId;
  const inspectable = entity.inspectable !== false;
  // Show an inline Talk button on every visible NPC card so dialogue can be
  // started directly from the Scene tab. We intentionally do NOT gate on
  // actionTypes here: not every NPC payload advertises "talk", and the server
  // resolves talkability (returning a graceful "nothing to say" result when an
  // NPC has no dialogue). Talk also remains available in the Actions tab.
  const canTalk = entity.entityType === "npc";
  return `
    <article
      class="solo-entity-card ${selected ? "selected" : ""} ${inspectable ? "inspectable" : ""}"
      data-entity-id="${escapeHtml(entity.entityId || "")}"
      data-inspectable="${inspectable ? "true" : "false"}"
      tabindex="${inspectable ? "0" : "-1"}"
    >
      <div class="solo-entity-topline">
        <strong>${escapeHtml(entity.displayName || entity.entityId || "Entity")}</strong>
        <span class="tag">${escapeHtml(typeLabel(entity.entityType))}</span>
      </div>
      <p class="small">${escapeHtml(entity.summary || "Inspectable server entity.")}</p>
      <div class="solo-entity-meta">
        <span>${escapeHtml(entity.imageAssetId ? "Image assigned" : "No image assigned")}</span>
        ${entity.relationshipId ? `<span>${escapeHtml(entity.relationshipId)}</span>` : ""}
      </div>
      <button
        class="ghost"
        data-solo-action="inspect"
        data-entity-id="${escapeHtml(entity.entityId || "")}"
        ${inspectable ? "" : "disabled"}
      >
        Inspect
      </button>
      ${
        canTalk
          ? `<button
              class="ghost"
              data-solo-action="talk"
              data-entity-id="${escapeHtml(entity.entityId || "")}"
            >
              Talk
            </button>`
          : ""
      }
    </article>
  `;
}

export function renderEntityPanel(scene = {}, selectedEntityId = "") {
  const entities = Array.isArray(scene.visibleEntities) ? scene.visibleEntities : [];
  return `
    <section class="module-card solo-panel solo-entities-panel">
      <div class="module-header">
        <h3>Visible Entities</h3>
        <span class="small">${entities.length} visible</span>
      </div>
      <div class="solo-entity-grid">
        ${entities.length ? entities.map((entity) => renderEntityCard(entity, selectedEntityId)).join("") : renderEmpty("No visible entities.")}
      </div>
    </section>
  `;
}

export function renderSceneActionBar(scene = {}) {
  const actions = Array.isArray(scene.availableActions) ? scene.availableActions : [];
  return `
    <section class="module-card solo-panel">
      <div class="module-header">
        <h3>Action Bar</h3>
        <span class="small">Server actions</span>
      </div>
      <div class="solo-action-bar">
        ${
          actions.length
            ? actions
                .map((action) => {
                  const implemented =
                    action.type === "move" ||
                    action.type === "inspect" ||
                    action.type === "search" ||
                    action.type === "talk" ||
                    action.type === "rest" ||
                    action.type === "use_item" ||
                    action.type === "attempt";
                  const enabled = action.enabled !== false && implemented;
                  return `
                    <button
                      class="ghost solo-action-button"
                      data-solo-action="${escapeHtml(action.type || "")}"
                      data-location-id="${escapeHtml(action.toLocationId || "")}"
                      data-entity-id="${escapeHtml(action.entityId || action.targetEntityId || "")}"
                      data-rest-type="${escapeHtml(action.restType || "")}"
                      data-item-id="${escapeHtml(action.itemId || "")}"
                      ${enabled ? "" : "disabled"}
                      title="${escapeHtml(enabled ? labelForAction(action) : action.reason || "Action not implemented yet.")}"
                    >
                      <span>${escapeHtml(labelForAction(action))}</span>
                      ${enabled ? "" : `<small>${escapeHtml(action.reason || "Action not implemented yet.")}</small>`}
                    </button>
                  `;
                })
                .join("")
            : renderEmpty("No actions available.")
        }
      </div>
    </section>
  `;
}

export function renderInventoryPanel(scene = {}) {
  const items = Array.isArray(scene.playerInventory) ? scene.playerInventory : [];
  return `
    <section class="module-card solo-panel solo-inventory-panel">
      <div class="module-header">
        <h3>Inventory</h3>
        <span class="small">${items.length} usable</span>
      </div>
      ${
        items.length
          ? `<div class="solo-compact-list">${items
              .map((item) => `
                <div class="solo-compact-row solo-inventory-row">
                  <div>
                    <strong>${escapeHtml(item.name || item.itemId || "Item")}</strong>
                    <span>${escapeHtml(item.description || "Usable item.")}</span>
                    <div class="small">Quantity: ${escapeHtml(item.quantity ?? 0)}${item.consumable ? " / Consumable" : ""}</div>
                  </div>
                  <button
                    class="ghost"
                    data-solo-action="use_item"
                    data-item-id="${escapeHtml(item.itemId || "")}"
                    ${item.usable ? "" : "disabled"}
                  >
                    Use
                  </button>
                </div>
              `)
              .join("")}</div>`
          : renderEmpty("No usable items available yet.")
      }
    </section>
  `;
}

export function renderSearchResultPanel(searchResult = null, discoveredDetails = []) {
  const details = Array.isArray(discoveredDetails) ? discoveredDetails : [];
  return `
    <section class="module-card solo-panel solo-search-panel">
      <div class="module-header">
        <h3>Area Search</h3>
        <span class="small">Server result</span>
      </div>
      ${
        searchResult
          ? `
            <div class="solo-search-result ${searchResult.found ? "found" : "empty"}">
              <strong>${escapeHtml(searchResult.found ? "Detail found" : "Nothing new found")}</strong>
              <p>${escapeHtml(searchResult.summary || "You find nothing new right now.")}</p>
              ${
                Array.isArray(searchResult.warningCodes) && searchResult.warningCodes.length
                  ? `<div class="solo-tag-row">${searchResult.warningCodes
                      .map((warning) => `<span class="tag">${escapeHtml(warning)}</span>`)
                      .join("")}</div>`
                  : ""
              }
            </div>
          `
          : renderEmpty("Search this area to reveal pre-authored details.")
      }
      ${
        details.length
          ? `<div class="solo-sheet-section">
              <h5>Discovered Details</h5>
              ${renderCompactList(details, "No discovered details yet.", (detail) => `
                <div class="solo-compact-row">
                  <strong>${escapeHtml(detail.label || detail.detailId || "Detail")}</strong>
                  <span>${escapeHtml(detail.description || "")}</span>
                </div>
              `)}
            </div>`
          : ""
      }
    </section>
  `;
}

function renderCheckResult(checkResult = null) {
  if (!checkResult) {
    return "";
  }
  return `
    <div class="solo-check-result">
      <span class="tag ${checkResult.success ? "success" : "danger"}">
        ${escapeHtml(checkResult.success ? "Check success" : "Check failed")}
      </span>
      <span class="small">
        Total ${escapeHtml(checkResult.total)} vs DC ${escapeHtml(checkResult.dc)}
      </span>
    </div>
  `;
}

// FIX R-UI: feature the dice roll + verdict for the action just taken, in the
// MAIN scene flow — so a resolved attempt reads as "I did X → rolled Y vs DC Z →
// (verdict)" instead of resolving silently in the side Recent Rolls panel. The
// narrated prose outcome renders below in the GM/location panel; this surfaces
// the roll that produced it. Server-authoritative and staleness-proof: shown
// only when the most recent timeline event is an attempt, so a later move/search
// never re-surfaces a stale roll. Returns "" otherwise. Reuses existing classes
// (no new CSS rules) with shared :root accent vars applied inline.
export function renderSoloActionOutcome(state = {}) {
  const scene = state.scene || {};
  const timeline = Array.isArray(scene.recentTimeline) ? scene.recentTimeline : [];
  const last = timeline.length ? timeline[timeline.length - 1] : null;
  if (!last || last.type !== "attempt") {
    return "";
  }
  const outcome = scene.latestAttemptResult || state.attemptResult || null;
  if (!outcome) {
    return "";
  }
  const cr = outcome.checkResult || null;
  const success = outcome.success === true;
  const intent = String(outcome.intent || "Your action").trim() || "Your action";
  const hasTotal = cr && cr.total !== undefined && cr.total !== null;
  const hasDc = cr && cr.dc !== undefined && cr.dc !== null;
  const rollLine = hasTotal
    ? `<span class="solo-roll-total ${success ? "good" : "accent"}" style="font-size:22px;line-height:1;">${escapeHtml(cr.total)}</span>
       <span class="small">${hasDc ? `Rolled ${escapeHtml(cr.total)} vs DC ${escapeHtml(cr.dc)}` : `Rolled ${escapeHtml(cr.total)}`}</span>`
    : "";
  return `
    <div class="module-card solo-panel solo-action-outcome solo-attempt-result ${success ? "found" : "empty"}" role="status"
         style="margin:4px 4px 10px;border-left:3px solid var(--accent, #c89a4b);">
      <div class="solo-check-result" style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
        <span class="tag ${success ? "success" : "danger"}">${success ? "Success" : "Failure"}</span>
        ${rollLine}
      </div>
      <p class="small" style="margin:6px 0 0;">You attempted: ${escapeHtml(intent)}</p>
    </div>
  `;
}

export function renderTalkResultPanel(talkResult = null) {
  return `
    <section class="module-card solo-panel solo-talk-panel">
      <div class="module-header">
        <h3>Dialogue</h3>
        <span class="small">Server result</span>
      </div>
      ${
        talkResult
          ? `
            <div class="solo-talk-result ${talkResult.found ? "found" : "empty"}">
              <strong>${escapeHtml(talkResult.speakerName || "NPC")}</strong>
              <p>${escapeHtml(talkResult.line || "There is not much new to say right now.")}</p>
              <div class="small">${escapeHtml(talkResult.summary || "")}</div>
              ${renderCheckResult(talkResult.checkResult)}
              ${
                Array.isArray(talkResult.warningCodes) && talkResult.warningCodes.length
                  ? `<div class="solo-tag-row">${talkResult.warningCodes
                      .map((warning) => `<span class="tag">${escapeHtml(warning)}</span>`)
                      .join("")}</div>`
                  : ""
              }
            </div>
          `
          : renderEmpty("Talk to a visible NPC to see structured dialogue.")
      }
    </section>
  `;
}

export function renderRestResultPanel(restResult = null) {
  return `
    <section class="module-card solo-panel solo-rest-panel">
      <div class="module-header">
        <h3>Rest</h3>
        <span class="small">Server result</span>
      </div>
      ${
        restResult
          ? `
            <div class="solo-rest-result ${restResult.allowed ? "found" : "empty"}">
              <strong>${escapeHtml(restResult.allowed ? `${titleCase(restResult.restType || "short")} Rest` : "Rest denied")}</strong>
              <p>${escapeHtml(restResult.summary || "You cannot rest here right now.")}</p>
              <div class="small">Time advanced: ${escapeHtml(restResult.timeAdvanced ?? 0)} tick(s) / Safety: ${escapeHtml(restResult.safety || "unknown")}</div>
              ${
                Array.isArray(restResult.resourcesRecovered) && restResult.resourcesRecovered.length
                  ? `<div class="solo-sheet-section">
                      <h5>Recovered Resources</h5>
                      ${renderCompactList(restResult.resourcesRecovered, "No resources recovered.", (resource) => `
                        <div class="solo-compact-row">
                          <strong>${escapeHtml(typeLabel(resource.resourceId || "resource"))}</strong>
                          <span>${escapeHtml(resource.before)} -> ${escapeHtml(resource.after)} (+${escapeHtml(resource.amount)})</span>
                        </div>
                      `)}
                    </div>`
                  : renderEmpty("No resources recovered.")
              }
              ${
                Array.isArray(restResult.warningCodes) && restResult.warningCodes.length
                  ? `<div class="solo-tag-row">${restResult.warningCodes
                      .map((warning) => `<span class="tag">${escapeHtml(warning)}</span>`)
                      .join("")}</div>`
                  : ""
              }
            </div>
          `
          : renderEmpty("Rest here to advance time and recover simple resources.")
      }
    </section>
  `;
}

export function renderUseItemResultPanel(useItemResult = null) {
  return `
    <section class="module-card solo-panel solo-use-item-panel">
      <div class="module-header">
        <h3>Use Item</h3>
        <span class="small">Server result</span>
      </div>
      ${
        useItemResult
          ? `
            <div class="solo-use-item-result ${useItemResult.used ? "found" : "empty"}">
              <strong>${escapeHtml(useItemResult.used ? useItemResult.itemName || "Item used" : "Item use denied")}</strong>
              <p>${escapeHtml(useItemResult.summary || "That item cannot be used right now.")}</p>
              <div class="small">
                Effect: ${escapeHtml(typeLabel(useItemResult.effectType || "none"))}
                ${Number.isFinite(useItemResult.quantityRemaining) ? ` / Quantity remaining: ${escapeHtml(useItemResult.quantityRemaining)}` : ""}
              </div>
              ${
                Array.isArray(useItemResult.resourcesRecovered) && useItemResult.resourcesRecovered.length
                  ? `<div class="solo-sheet-section">
                      <h5>Recovered Resources</h5>
                      ${renderCompactList(useItemResult.resourcesRecovered, "No resources recovered.", (resource) => `
                        <div class="solo-compact-row">
                          <strong>${escapeHtml(typeLabel(resource.resourceId || "resource"))}</strong>
                          <span>${escapeHtml(resource.before)} -> ${escapeHtml(resource.after)} (+${escapeHtml(resource.amount)})</span>
                        </div>
                      `)}
                    </div>`
                  : ""
              }
              ${
                useItemResult.revealedNote
                  ? `<div class="solo-sheet-section">
                      <h5>Revealed Note</h5>
                      <p>${escapeHtml(useItemResult.revealedNote)}</p>
                    </div>`
                  : ""
              }
              ${
                Array.isArray(useItemResult.warningCodes) && useItemResult.warningCodes.length
                  ? `<div class="solo-tag-row">${useItemResult.warningCodes
                      .map((warning) => `<span class="tag">${escapeHtml(warning)}</span>`)
                      .join("")}</div>`
                  : ""
              }
            </div>
          `
          : renderEmpty("Use a usable inventory item to apply a predefined effect.")
      }
    </section>
  `;
}

export function renderAttemptPanel(scene = {}, attemptResult = null) {
  const entities = Array.isArray(scene.visibleEntities) ? scene.visibleEntities.filter((entity) => entity.entityId) : [];
  const history = Array.isArray(scene.attemptHistory) ? scene.attemptHistory : [];
  return `
    <section class="module-card solo-panel solo-attempt-panel">
      <div class="module-header">
        <h3>Attempt</h3>
        <span class="small">Freeform server action</span>
      </div>
      <form class="solo-attempt-form" data-solo-attempt-form>
        <label class="field">
          <span class="small">What do you attempt?</span>
          <textarea name="intent" rows="3" placeholder="Describe your intent..." required></textarea>
        </label>
        <label class="field">
          <span class="small">Optional target</span>
          <select name="targetId">
            <option value="">No specific target</option>
            ${entities
              .map((entity) => `<option value="${escapeHtml(entity.entityId)}">${escapeHtml(entity.displayName || entity.entityId)}</option>`)
              .join("")}
          </select>
        </label>
        <button class="ghost" type="submit" data-solo-action="attempt">Attempt</button>
      </form>
      ${
        attemptResult
          ? `
            <div class="solo-attempt-result ${attemptResult.success ? "found" : "empty"}">
              <strong>${escapeHtml(attemptResult.success ? "Attempt succeeded" : "Attempt failed")}</strong>
              <p>${escapeHtml(attemptResult.narration || attemptResult.summary || "The attempt resolves without further effect.")}</p>
              <div class="small">Intent: ${escapeHtml(attemptResult.intent || "")}</div>
              ${renderCheckResult(attemptResult.checkResult)}
              ${
                Array.isArray(attemptResult.warnings) && attemptResult.warnings.length
                  ? `<div class="solo-tag-row">${attemptResult.warnings.map((warning) => `<span class="tag">${escapeHtml(warning)}</span>`).join("")}</div>`
                  : ""
              }
            </div>
          `
          : renderEmpty("Type a custom intent. The server validates and adjudicates the result.")
      }
      ${
        history.length
          ? `<div class="solo-sheet-section">
              <h5>Recent Attempts</h5>
              ${renderCompactList(history.slice(-3), "No recent attempts.", (entry) => `
                <div class="solo-compact-row">
                  <strong>${escapeHtml(entry.success ? "Success" : "Failure")}</strong>
                  <span>${escapeHtml(entry.intent || entry.summary || "")}</span>
                </div>
              `)}
            </div>`
          : ""
      }
    </section>
  `;
}

export function renderEntityDetailPanel(detail = null) {
  if (!detail) {
    return `
      <section class="module-card solo-panel solo-detail-sheet">
        <div class="module-header">
          <h3>Entity Sheet</h3>
          <span class="small">Inspectable details</span>
        </div>
        <div class="solo-detail-empty">
          <strong>No entity selected.</strong>
          <p>Click an inspectable entity to open its server-backed detail sheet.</p>
        </div>
      </section>
    `;
  }

  const entity = detail.entity || {};
  const details = detail.details || {};
  const title = details.title || entity.displayName || entity.entityId || "Entity";
  const type = entity.entityType || details.entityType || "entity";
  const description = details.description || entity.summary || "No details available.";
  const stats = details.stats || entity.stats || {};
  const relationships = details.relationships || entity.relationships || [];
  const memories = details.memoryFacts || entity.memoryFacts || [];
  const availableActions = details.availableActions || entity.availableActions || [];
  const imageAssetId = details.imageAssetId || entity.imageAssetId || null;
  const portraitUri = details.portraitUri || entity.portraitUri || null;
  const tags = details.tags || entity.tags || [];

  return `
    <section class="module-card solo-panel solo-detail-sheet">
      <div class="module-header">
        <h3>Entity Sheet</h3>
        <span class="small">Structured payload</span>
      </div>
      <div class="solo-detail-hero">
        <div class="solo-detail-portrait">${
          portraitUri
            ? `<img class="solo-detail-portrait-img" src="${escapeHtml(portraitUri)}" alt="${escapeHtml(title)} portrait" />`
            : escapeHtml(imageAssetId || "No image assigned.")
        }</div>
        <div>
          <div class="solo-section-kicker">${escapeHtml(typeLabel(type))}</div>
          <h4>${escapeHtml(title)}</h4>
          <p>${escapeHtml(description)}</p>
          ${renderTags(tags)}
        </div>
      </div>

      <div class="solo-sheet-section">
        <h5>Stats</h5>
        ${renderStats(stats)}
      </div>

      <div class="solo-sheet-section">
        <h5>Relationships</h5>
        ${renderCompactList(relationships, "No known relationship data yet.", (relationship) => `
          <div class="solo-compact-row">
            <strong>${escapeHtml(relationship.label || relationship.relationshipId || relationship.targetEntityId || "Relationship")}</strong>
            <span>${escapeHtml(relationship.summary || relationship.status || "")}</span>
          </div>
        `)}
      </div>

      <div class="solo-sheet-section">
        <h5>Linked Memories</h5>
        ${renderCompactList(memories, "No linked memories yet.", (fact) => `
          <div class="solo-compact-row">
            <strong>${escapeHtml(fact.type || fact.factId || "Memory")}</strong>
            <span>${escapeHtml(fact.text || fact.summary || "")}</span>
          </div>
        `)}
      </div>

      <div class="solo-sheet-section">
        <h5>Available Actions</h5>
        ${renderCompactList(availableActions, "No sheet actions available yet.", (action) => `
          <div class="solo-compact-row">
            <strong>${escapeHtml(labelForAction(action))}</strong>
            <span>${escapeHtml(action.enabled === false ? action.reason || "Action not implemented yet." : "Available")}</span>
          </div>
        `)}
      </div>
    </section>
  `;
}

// Quest objective panel — pinned to the top of the Journal tab. Shows the active
// quest (the main quest if active, else the first active quest), its one-line
// objective, and a stage indicator past stage 0. Falls back to a neutral empty
// state when nothing is active (e.g. after the main quest is completed).
export function renderQuestPanel(scene = {}) {
  const quests = scene.quests || {};
  const main = quests.mainQuest && quests.mainQuest.status === "active" ? quests.mainQuest : null;
  const active =
    main ||
    (Array.isArray(quests.activeQuests) ? quests.activeQuests.find((quest) => quest && quest.status === "active") : null) ||
    null;
  return `
    <section class="module-card solo-panel solo-quest-panel">
      <div class="module-header">
        <h3>Objective</h3>
        <span class="small">Your quest</span>
      </div>
      ${
        active
          ? `<div class="solo-quest-active">
               <strong class="solo-quest-title">${escapeHtml(active.title || "Untitled Quest")}</strong>
               <div class="small solo-quest-objective">${escapeHtml(active.objective || "")}</div>
               ${Number(active.stage) > 0 ? `<div class="small solo-quest-stage">Stage ${escapeHtml(active.stage)}</div>` : ""}
             </div>`
          : renderEmpty("No active quest.")
      }
    </section>
  `;
}

export function renderSceneTimelinePanel(scene = {}) {
  const events = Array.isArray(scene.recentTimeline) ? scene.recentTimeline : [];
  return `
    <section class="module-card solo-panel">
      <div class="module-header">
        <h3>Recent Timeline</h3>
        <span class="small">Run events</span>
      </div>
      ${
        events.length
          ? `<ul class="list solo-timeline-list">${events
              .map(
                (event) => `
                  <li class="list-item">
                    <strong>${escapeHtml(event.title || event.type || "Event")}</strong>
                    <div class="small">${escapeHtml(event.summary || "")}</div>
                  </li>
                `
              )
              .join("")}</ul>`
          : renderEmpty("No recent events yet.")
      }
    </section>
  `;
}

export function renderSceneMemoryPanel(scene = {}) {
  const facts = Array.isArray(scene.relevantMemoryFacts) ? scene.relevantMemoryFacts : [];
  return `
    <section class="module-card solo-panel">
      <div class="module-header">
        <h3>Relevant Memory</h3>
        <span class="small">Server facts</span>
      </div>
      ${
        facts.length
          ? `<ul class="list solo-memory-list">${facts
              .map(
                (fact) => `
                  <li class="list-item">
                    <strong>${escapeHtml(fact.type || "fact")}</strong>
                    <div class="small">${escapeHtml(fact.text || "")}</div>
                  </li>
                `
              )
              .join("")}</ul>`
          : renderEmpty("No linked memories yet.")
      }
    </section>
  `;
}

// ---------------------------------------------------------------------------
// Themed game-screen chrome (skins, fonts, character sidebar, tabs, right rail)
// ---------------------------------------------------------------------------

// Default skin ("Ashen Keep") plus the three premium skins. Each entry is a full
// CSS custom-property set applied to the shell root so the whole screen retints.
export const SOLO_SKINS = {
  // Default skin — "Black grimoire": premium black/oxblood leather-bound tome.
  // Genre-neutral occult-journal base (hosts cyberpunk/cosmic-horror, not just
  // fantasy). Mirrors the :root leather-tome palette so the scene shell matches
  // the home/onboarding surfaces. Texture is a fine gradient cross-hatch (grain)
  // — kept quote-free so it's safe inside the inline style="" attribute.
  ashen: {
    "--bg": "#0c0a09", "--panel": "#17120f", "--card": "#19130f", "--inset": "#0a0706",
    "--card-dim": "#120d09", "--tabbar": "#0e0b09", "--border": "#2c2018", "--border-faint": "#201711",
    "--border-strong": "#3d2d1f", "--text": "#e9ddc4", "--text-bright": "#f4ebd6", "--text-2": "#b6a589",
    "--text-muted": "#94856f", "--text-label": "#8a7c64", "--text-faint": "#6a5d4c", "--accent": "#b08545",
    "--accent-2": "#d8b46a", "--accent-bright": "#d8b46a", "--accent-grad-a": "#c79a4e", "--accent-grad-b": "#946f30",
    "--accent-border": "#4a3a1e", "--on-accent": "#1a1206",
    "--texture": "repeating-linear-gradient(34deg,rgba(216,180,106,.022) 0 1px,transparent 1px 3px),repeating-linear-gradient(-22deg,rgba(0,0,0,.16) 0 1px,transparent 1px 4px)",
    "--texture-size": "auto"
  },
  dragon: {
    "--bg": "#0f1411", "--panel": "#0c100d", "--card": "#121a14", "--inset": "#0c120e",
    "--card-dim": "#0e1410", "--tabbar": "#0a0f0c", "--border": "#243029", "--border-faint": "#1a241e",
    "--border-strong": "#2e3d33", "--text": "#e2e8da", "--text-bright": "#f1f5ec", "--text-2": "#a7b3a0",
    "--text-muted": "#8a978a", "--text-label": "#76837a", "--text-faint": "#5e6b62", "--accent": "#cf5236",
    "--accent-2": "#e6a23a", "--accent-bright": "#e6a23a", "--accent-grad-a": "#d65a3c", "--accent-grad-b": "#9e2a1b",
    "--accent-border": "#5a261a", "--on-accent": "#f6e8d6",
    "--texture": "radial-gradient(circle at 50% 100%,rgba(170,90,60,.10) 0 8px,transparent 9px),radial-gradient(circle at 0 100%,rgba(170,90,60,.10) 0 8px,transparent 9px),radial-gradient(circle at 100% 100%,rgba(170,90,60,.10) 0 8px,transparent 9px)",
    "--texture-size": "20px 14px"
  },
  lava: {
    "--bg": "#16100d", "--panel": "#100b09", "--card": "#1a110d", "--inset": "#0e0907",
    "--card-dim": "#140d0a", "--tabbar": "#0c0807", "--border": "#3a221a", "--border-faint": "#281712",
    "--border-strong": "#4a2a1e", "--text": "#f0e0d2", "--text-bright": "#fff0e2", "--text-2": "#c2a896",
    "--text-muted": "#a08876", "--text-label": "#8a7060", "--text-faint": "#6e5446", "--accent": "#ff6a1f",
    "--accent-2": "#ffb347", "--accent-bright": "#ffb347", "--accent-grad-a": "#ff7a2a", "--accent-grad-b": "#d94512",
    "--accent-border": "#7a2e12", "--on-accent": "#1a0c06",
    "--texture": "linear-gradient(115deg,transparent 47%,rgba(255,90,20,.12) 50%,transparent 53%),linear-gradient(60deg,transparent 47%,rgba(255,120,30,.08) 50%,transparent 53%)",
    "--texture-size": "90px 90px"
  },
  wood: {
    "--bg": "#161310", "--panel": "#11100a", "--card": "#1a1810", "--inset": "#11100a",
    "--card-dim": "#15130d", "--tabbar": "#0f0e09", "--border": "#2c2a1c", "--border-faint": "#201e14",
    "--border-strong": "#3a3724", "--text": "#e6e8d4", "--text-bright": "#f2f4e2", "--text-2": "#aab09a",
    "--text-muted": "#8e9480", "--text-label": "#787e6a", "--text-faint": "#5e6450", "--accent": "#86a544",
    "--accent-2": "#c2b24a", "--accent-bright": "#c2b24a", "--accent-grad-a": "#92b04e", "--accent-grad-b": "#5e7a2c",
    "--accent-border": "#3a4a22", "--on-accent": "#14180a",
    "--texture": "repeating-linear-gradient(92deg,rgba(150,140,90,.05) 0 2px,transparent 2px 8px),repeating-linear-gradient(88deg,rgba(120,110,70,.04) 0 1px,transparent 1px 5px)",
    "--texture-size": "auto"
  }
};

export const SOLO_FONTS = {
  tome: { "--font-display": "'Cinzel',Georgia,serif", "--font-body": "'Spectral',Georgia,serif" },
  court: { "--font-display": "'Marcellus',Georgia,serif", "--font-body": "'EB Garamond',Georgia,serif" },
  iron: { "--font-display": "'Grenze Gotisch',Georgia,serif", "--font-body": "'Spectral',Georgia,serif" }
};

const SOLO_SKIN_SWATCHES = {
  ashen: "linear-gradient(135deg,#d8b46a,#0c0a09)",
  dragon: "linear-gradient(135deg,#cf5236,#0f1411)",
  lava: "linear-gradient(135deg,#ff6a1f,#16100d)",
  wood: "linear-gradient(135deg,#86a544,#161310)"
};

const SOLO_SKIN_LABELS = { ashen: "Ashen Keep", dragon: "Dragonscale", lava: "Molten Forge", wood: "Wildwood" };
const SOLO_FONT_LABELS = { tome: "Tome", court: "Court", iron: "Iron" };

export const SOLO_TABS = [
  { id: "scene", label: "Scene" },
  { id: "actions", label: "Actions" },
  { id: "character", label: "Character" },
  { id: "inventory", label: "Inventory" },
  { id: "map", label: "Map" },
  { id: "journal", label: "Journal" }
];

export function normalizeSkin(skin) {
  return Object.prototype.hasOwnProperty.call(SOLO_SKINS, skin) ? skin : "ashen";
}

export function normalizeFontSet(fontSet) {
  return Object.prototype.hasOwnProperty.call(SOLO_FONTS, fontSet) ? fontSet : "tome";
}

export function normalizeTab(tab) {
  return SOLO_TABS.some((entry) => entry.id === tab) ? tab : "scene";
}

// Build the inline custom-property string applied to the shell root.
export function soloThemeVarString(skin = "ashen", fontSet = "tome") {
  const vars = { ...SOLO_SKINS[normalizeSkin(skin)], ...SOLO_FONTS[normalizeFontSet(fontSet)] };
  return Object.entries(vars)
    .map(([key, value]) => `${key}:${value}`)
    .join(";");
}

// Static fallback character. The solo scene payload does not currently carry
// player stats, so the sidebar/sheet use this until live data is wired in.
const SOLO_SAMPLE_CHARACTER = {
  name: "Akrij the Spellblade",
  className: "Spellblade",
  level: 1,
  hitPoints: { current: 12, max: 12 },
  armorClass: 13,
  speed: 30,
  abilities: [
    { key: "STR", mod: "+0", score: 10 },
    { key: "DEX", mod: "+1", score: 12 },
    { key: "CON", mod: "+0", score: 11 },
    { key: "INT", mod: "+2", score: 14, accent: true },
    { key: "WIS", mod: "+1", score: 13 },
    { key: "CHA", mod: "+0", score: 10 }
  ],
  passivePerception: 11,
  initiative: "+1",
  proficiency: "+2",
  region: "Ashenmoor",
  saves: [
    { name: "Strength", mod: "+0" },
    { name: "Dexterity", mod: "+1" },
    { name: "Constitution", mod: "+2", proficient: true },
    { name: "Intelligence", mod: "+4", proficient: true },
    { name: "Wisdom", mod: "+1" },
    { name: "Charisma", mod: "+0" }
  ],
  skills: [
    { name: "Arcana", mod: "+4", proficient: true },
    { name: "Investigation", mod: "+4", proficient: true },
    { name: "Perception", mod: "+3", proficient: true },
    { name: "Insight", mod: "+1" },
    { name: "Athletics", mod: "+0" },
    { name: "Persuasion", mod: "+0" }
  ],
  proficiencies: "Light armor · Simple & martial weapons · Arcane focus · Thieves' cant of the Ashen roads"
};

function abilityModifier(score) {
  const n = Number(score);
  return Number.isFinite(n) ? Math.floor((n - 10) / 2) : 0;
}

function formatMod(mod) {
  return `${mod >= 0 ? "+" : ""}${mod}`;
}

// Maps the server scene.player projection into the character sidebar/sheet shape
// (SOLO_SAMPLE_CHARACTER). AC/speed aren't tracked on run.player, so the payload
// sends null and we default here. Returns null when no player is present.
export function characterFromScenePlayer(player) {
  if (!player || typeof player !== "object") {
    return null;
  }
  const ab = player.abilities && typeof player.abilities === "object" ? player.abilities : {};
  const ABILITY_ORDER = [
    ["STR", "strength"],
    ["DEX", "dexterity"],
    ["CON", "constitution"],
    ["INT", "intelligence"],
    ["WIS", "wisdom"],
    ["CHA", "charisma"]
  ];
  const abilities = ABILITY_ORDER.map(([key, full]) => {
    const score = Number.isFinite(Number(ab[full])) ? Number(ab[full]) : 10;
    return { key, score, mod: formatMod(abilityModifier(score)) };
  });
  const dexMod = abilityModifier(Number(ab.dexterity) || 10);
  const wisMod = abilityModifier(Number(ab.wisdom) || 10);
  const hp = player.hitPoints && typeof player.hitPoints === "object" ? player.hitPoints : { current: 0, max: 0 };
  const skillsObj = player.skills && typeof player.skills === "object" ? player.skills : {};
  const skills = Object.entries(skillsObj).map(([name, value]) => ({
    name: name.charAt(0).toUpperCase() + name.slice(1),
    mod: formatMod(Number(value) || 0)
  }));
  const saves = ABILITY_ORDER.map(([, full]) => ({
    name: full.charAt(0).toUpperCase() + full.slice(1),
    mod: formatMod(abilityModifier(Number(ab[full]) || 10))
  }));
  return {
    name: player.displayName || "Adventurer",
    className: player.className || "Adventurer",
    level: typeof player.level === "number" && Number.isFinite(player.level) ? player.level : 1,
    hitPoints: { current: hp.current ?? 0, max: hp.max ?? 0 },
    armorClass: typeof player.armorClass === "number" && Number.isFinite(player.armorClass) ? player.armorClass : 10,
    speed: typeof player.speed === "number" && Number.isFinite(player.speed) ? player.speed : 30,
    abilities,
    passivePerception: 10 + wisMod,
    initiative: formatMod(dexMod),
    proficiency: "+2",
    region: "Ashenmoor",
    saves,
    skills,
    proficiencies: "—",
    portraitUri: typeof player.portraitUri === "string" ? player.portraitUri : ""
  };
}

export function renderSoloThemeSwitcher(skin = "ashen", fontSet = "tome") {
  const activeSkin = normalizeSkin(skin);
  const activeFont = normalizeFontSet(fontSet);
  const chip = (active) =>
    `display:inline-flex;align-items:center;gap:8px;padding:7px 12px;border-radius:8px;cursor:pointer;font-size:12px;font-weight:600;` +
    (active
      ? "background:var(--accent,#c8922a);border:1px solid var(--accent-2,#e0b352);color:var(--on-accent,#1c1308);"
      : "background:var(--inset,#120c07);border:1px solid var(--border,#2e2420);color:var(--text-2,#b3a48c);");

  const skinButtons = Object.keys(SOLO_SKINS)
    .map(
      (id) =>
        `<button type="button" data-solo-skin="${id}" style="${chip(id === activeSkin)}">` +
        `<span style="display:inline-block;flex:none;width:14px;height:14px;border-radius:4px;background:${SOLO_SKIN_SWATCHES[id]};"></span>` +
        `${escapeHtml(SOLO_SKIN_LABELS[id])}</button>`
    )
    .join("");

  const fontButtons = Object.keys(SOLO_FONTS)
    .map(
      (id) =>
        `<button type="button" data-solo-font="${id}" style="${chip(id === activeFont)}">${escapeHtml(SOLO_FONT_LABELS[id])}</button>`
    )
    .join("");

  return `
    <div class="solo-theme-switcher">
      <div class="solo-theme-group">
        <span class="solo-theme-kicker">Skins</span>
        <span class="solo-theme-premium">Premium</span>
        <div class="solo-theme-buttons">${skinButtons}</div>
      </div>
      <div class="solo-theme-group">
        <span class="solo-theme-kicker">Fonts</span>
        <span class="solo-theme-premium">Premium</span>
        <div class="solo-theme-buttons">${fontButtons}</div>
      </div>
    </div>
  `;
}

export function renderSoloCharacterSidebar(character = SOLO_SAMPLE_CHARACTER) {
  const hp = character.hitPoints || { current: 0, max: 0 };
  const hpPct = hp.max > 0 ? Math.max(0, Math.min(100, Math.round((hp.current / hp.max) * 100))) : 0;
  const abilities = (character.abilities || [])
    .map(
      (ability) => `
        <div class="solo-ability-cell">
          <div class="solo-ability-key">${escapeHtml(ability.key)}</div>
          <div class="solo-ability-mod ${ability.accent ? "accent" : ""}">${escapeHtml(ability.mod)}</div>
          <div class="solo-ability-score">${escapeHtml(ability.score)}</div>
        </div>
      `
    )
    .join("");

  return `
    <aside class="solo-game-sidebar">
      <div class="solo-portrait" data-portrait-for="player" data-portrait-img-class="solo-portrait-img">${character.portraitUri ? `<img class="solo-portrait-img" src="${escapeHtml(character.portraitUri)}" alt="${escapeHtml(character.name || "Character")} portrait" />` : `<div class="solo-portrait-pending"><span class="solo-portrait-spinner" aria-hidden="true"></span><small>Crafting your portrait… (~20s)</small></div>`}</div>
      <div class="solo-sidebar-identity">
        <div class="solo-char-name">${escapeHtml(character.name)}</div>
        <div class="solo-char-sub">${escapeHtml(character.className)} · Level ${escapeHtml(character.level)}</div>
      </div>
      <div class="solo-sidebar-block">
        <div class="solo-hp-row">
          <span class="solo-stat-kicker">Hit Points</span>
          <span class="solo-hp-value">${escapeHtml(hp.current)} <span>/ ${escapeHtml(hp.max)}</span></span>
        </div>
        <div class="solo-hp-track"><div class="solo-hp-fill" style="width:${hpPct}%;"></div></div>
        <div class="solo-mini-stats">
          <div class="solo-mini-stat"><div class="solo-mini-val">${escapeHtml(character.armorClass)}</div><div class="solo-mini-label">Armor</div></div>
          <div class="solo-mini-stat"><div class="solo-mini-val">${escapeHtml(character.speed)}</div><div class="solo-mini-label">Speed</div></div>
        </div>
      </div>
      <div class="solo-sidebar-block">
        <div class="solo-stat-kicker">Abilities</div>
        <div class="solo-ability-grid">${abilities}</div>
      </div>
      <div class="solo-sidebar-block solo-passive-block">
        <div class="solo-passive-row"><span>Passive Perception</span><span>${escapeHtml(character.passivePerception)}</span></div>
        <div class="solo-passive-row"><span>Initiative</span><span>${escapeHtml(character.initiative)}</span></div>
        <div class="solo-passive-row"><span>Proficiency</span><span>${escapeHtml(character.proficiency)}</span></div>
      </div>
      <div class="solo-sidebar-block solo-conditions-block">
        <div class="solo-stat-kicker">Conditions</div>
        <div class="solo-condition">
          <span class="solo-condition-dot"></span>
          <div><div class="solo-condition-name">Soaked</div><div class="solo-condition-note">Chilled from the rain — no penalty yet.</div></div>
        </div>
      </div>
    </aside>
  `;
}

export function renderSoloGameTabs(activeTab = "scene") {
  const active = normalizeTab(activeTab);
  return `
    <div class="solo-game-tabs" role="tablist">
      ${SOLO_TABS.map(
        (tab) =>
          `<button type="button" role="tab" class="solo-game-tab ${tab.id === active ? "active" : ""}" data-solo-tab="${tab.id}" aria-selected="${tab.id === active}">${escapeHtml(tab.label)}</button>`
      ).join("")}
    </div>
  `;
}

export function renderSoloSceneInputBar(state = {}) {
  const scene = state.scene || {};
  const actions = Array.isArray(scene.availableActions) ? scene.availableActions : [];
  const chips = actions
    .filter((action) => action.enabled !== false)
    .slice(0, 4)
    .map((action) => {
      const label = labelForAction(action);
      return `<button type="button" class="solo-scene-chip" data-solo-action="${escapeHtml(action.type || "")}" data-location-id="${escapeHtml(action.toLocationId || "")}" data-entity-id="${escapeHtml(action.entityId || action.targetEntityId || "")}" data-rest-type="${escapeHtml(action.restType || "")}" data-item-id="${escapeHtml(action.itemId || "")}">${escapeHtml(label)}</button>`;
    })
    .join("");

  const confirmation = typeof state.npcCreatorConfirmation === "string" ? state.npcCreatorConfirmation : "";

  // While any action is in flight, disable the input + submit (prevents
  // double-submit) and surface the wait in the button label.
  const busy = Boolean(state.busy);

  // Optional, editable next-action suggestions for this scene. Clicking one fills
  // the input (the player can edit it before submitting); the input itself is
  // always the "type your own" option. Pure scaffolding — never forces a choice.
  const suggestions = Array.isArray(scene.suggestedActions)
    ? scene.suggestedActions.filter((entry) => typeof entry === "string" && entry.trim().length).slice(0, 3)
    : [];
  const hasSuggestions = suggestions.length > 0;
  const suggestionChips = suggestions
    .map(
      (entry) =>
        `<button type="button" class="solo-suggestion" data-solo-suggestion="${escapeHtml(entry)}" ${busy ? "disabled" : ""}>${escapeHtml(entry)}</button>`
    )
    .join("");

  return `
    <div class="solo-scene-input">
      ${
        hasSuggestions
          ? `<div class="solo-suggestions" role="group" aria-label="Suggested actions">
        <span class="solo-suggestions-label">Suggested</span>
        ${suggestionChips}
      </div>`
          : ""
      }
      <div class="solo-scene-input-row">
        <input type="text" class="solo-scene-field" data-solo-attempt-input placeholder="${hasSuggestions ? "…or describe your own action" : "What do you do?"}" value="${escapeHtml(state.attemptDraft || "")}" ${busy ? "disabled" : ""} />
        <button type="button" class="solo-attempt-submit" data-solo-attempt-submit ${busy ? "disabled" : ""}>${busy ? "Thinking…" : "Attempt"}</button>
      </div>
      <div class="solo-scene-tools">
        <button type="button" class="solo-bring-in" data-solo-npc-create>＋ Bring someone in</button>
      </div>
      ${confirmation ? `<div class="solo-npc-confirm" role="status">${escapeHtml(confirmation)}</div>` : ""}
      ${chips ? `<div class="solo-scene-chips">${chips}</div>` : ""}
    </div>
  `;
}

// Inner HTML for the scene-art banner when an image exists: the image plus the
// Redo/Save controls (hidden once the image is locked). Shared by the initial
// render and the poll's in-place swap so both stay consistent.
export function sceneArtInnerHtml(uri, { locked = false } = {}) {
  const controls = locked
    ? ""
    : `
      <div class="solo-scene-art-controls">
        <button type="button" class="solo-scene-art-btn" data-scene-redo title="Generate a new image for this location">↻ Redo</button>
        <button type="button" class="solo-scene-art-btn solo-scene-art-btn--save" data-scene-save title="Keep this image for this location">✓ Save</button>
      </div>`;
  return `<img class="solo-scene-art-img" src="${escapeHtml(uri)}" alt="Location background" />${controls}`;
}

export function renderSoloSceneArt(locationImageUri = null, { locked = false } = {}) {
  const uri = typeof locationImageUri === "string" ? locationImageUri.trim() : "";
  if (uri) {
    // Generated location background fills the banner area (object-fit: cover),
    // with Redo/Save controls overlaid bottom-right until the image is locked.
    return `
      <div class="solo-scene-art" data-scene-art>
        ${sceneArtInnerHtml(uri, { locked })}
      </div>
    `;
  }
  // No image yet: decorative firelit vignette + a subtle generating label,
  // mirroring the portrait-placeholder pattern.
  return `
    <div class="solo-scene-art" data-scene-art>
      <div class="solo-scene-art-glow"></div>
      <div class="solo-scene-art-window"></div>
      <div class="solo-scene-art-hearth"></div>
      <div class="solo-scene-art-floor"></div>
      <div class="solo-scene-art-pending">Painting the scene… (~20s)</div>
    </div>
  `;
}

export function renderSoloCharacterSheet(character = SOLO_SAMPLE_CHARACTER) {
  const row = (entry) => `
    <div class="solo-sheet-row">
      <span class="${entry.proficient ? "proficient" : ""}">${escapeHtml(entry.name)}${entry.proficient ? ` <span class="solo-dot">●</span>` : ""}</span>
      <span class="${entry.proficient ? "proficient" : ""}">${escapeHtml(entry.mod)}</span>
    </div>`;
  const combatCard = (label, value) =>
    `<div class="solo-combat-card"><div class="solo-mini-label">${escapeHtml(label)}</div><div class="solo-combat-val">${escapeHtml(value)}</div></div>`;

  return `
    <div class="solo-character-sheet">
      <div class="solo-sheet-col">
        <div class="solo-stat-kicker">Saving Throws</div>
        <div class="solo-sheet-list">${(character.saves || []).map(row).join("")}</div>
        <div class="solo-stat-kicker" style="margin-top:26px;">Combat</div>
        <div class="solo-combat-grid">
          ${combatCard("Armor Class", character.armorClass)}
          ${combatCard("Initiative", character.initiative)}
          ${combatCard("Speed", `${character.speed} ft`)}
          ${combatCard("Hit Points", `${character.hitPoints.current} / ${character.hitPoints.max}`)}
        </div>
      </div>
      <div class="solo-sheet-col">
        <div class="solo-stat-kicker">Skills</div>
        <div class="solo-sheet-list">${(character.skills || []).map(row).join("")}</div>
        <div class="solo-stat-kicker" style="margin-top:26px;">Proficiencies</div>
        <div class="solo-proficiencies">${escapeHtml(character.proficiencies)}</div>
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Solo battle map — Phase 1 (Tickets: solo battle map).
// Net-new, solo-only (does NOT touch the multiplayer VTT). Phase 1 scope:
// spawn the player + visible NPCs as tokens on a 5ft grid, linked to real run
// entities. No movement/fog yet (Phase 2/3). Positions are derived
// deterministically from the scene; nothing is persisted server-side.
// ---------------------------------------------------------------------------
export const SOLO_MAP_WIDTH = 12;
export const SOLO_MAP_HEIGHT = 10;
export const SOLO_MAP_TILE_FEET = 5;

// Image-completion poll cadence. Portraits + location art generate async (one
// shared worker queue, no WebSocket), so the scene loads with placeholders and
// we poll until every URI is ready. Real providers (Pollinations) routinely
// take far longer than the old 15s budget — base portrait, each NPC base, and
// the location background all generate sequentially — so the window must cover
// realistic latency, not just a couple of ticks. Still bounded: the poll stops
// early as soon as nothing is pending, and at the cap otherwise.
const SOLO_ART_POLL_INTERVAL_MS = 5000;
const SOLO_ART_POLL_MAX_ATTEMPTS = 24; // ~2 minutes at 5s

function soloMapClamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function soloTokenInitials(name) {
  const words = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return "?";
  }
  if (words.length === 1) {
    return words[0].slice(0, 2).toUpperCase();
  }
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

/**
 * Pure. Builds the Phase-1 token list from a solo scene payload: the player
 * plus every NPC currently present, each linked to its real run entity and
 * given a deterministic, collision-free grid position. No movement yet.
 * @param {object} scene buildSoloScenePayload output (needs .player, .cast)
 * @param {{width?:number,height?:number}} options
 * @returns {Array<{id,kind,entityId,displayName,label,portraitUri,faction,speed?,x,y}>}
 */
export function buildSoloMapTokens(scene = {}, options = {}) {
  const width = Number.isFinite(options.width) ? options.width : SOLO_MAP_WIDTH;
  const height = Number.isFinite(options.height) ? options.height : SOLO_MAP_HEIGHT;
  const player = scene && typeof scene.player === "object" ? scene.player : null;
  const cast = Array.isArray(scene?.cast) ? scene.cast : [];
  const presentNpcs = cast.filter((npc) => npc && npc.present && typeof npc.npcId === "string");

  const used = new Set();
  const place = (rawX, rawY) => {
    let x = soloMapClamp(Math.round(rawX), 0, width - 1);
    let y = soloMapClamp(Math.round(rawY), 0, height - 1);
    let guard = 0;
    const limit = width * height;
    while (used.has(`${x},${y}`) && guard < limit) {
      x += 1;
      if (x >= width) {
        x = 0;
        y = (y + 1) % height;
      }
      guard += 1;
    }
    used.add(`${x},${y}`);
    return { x, y };
  };

  const tokens = [];

  let playerSpawn = null;
  if (player) {
    const name = typeof player.displayName === "string" && player.displayName ? player.displayName : "You";
    const vision = typeof player.vision === "number" ? player.vision : DEFAULT_VISION_TILES;
    const pos = place(Math.floor(width / 2), height - 1);
    playerSpawn = { x: pos.x, y: pos.y, vision };
    tokens.push({
      id: "player",
      kind: "player",
      entityId: "player",
      displayName: name,
      label: soloTokenInitials(name),
      portraitUri: typeof player.portraitUri === "string" ? player.portraitUri : "",
      faction: "player",
      // Carried for Phase 2 (speed-validated movement); unused in Phase 1.
      speed: typeof player.speed === "number" ? player.speed : 30,
      vision,
      ...pos
    });
  }

  // Present NPCs spawn within the player's starting vision (fanned out a couple
  // tiles in front of — above — the player) so they're visible on entry instead
  // of hidden by fog near the top edge. Falls back to a top-row spread when
  // there is no player token to anchor on.
  const placeNpcInSight = (index, total, anchor) => {
    if (!anchor) {
      const spacing = Math.max(1, Math.floor(width / (total + 1)));
      return place(Math.min(width - 1, (index + 1) * spacing), 1);
    }
    const radius = Number.isFinite(anchor.vision) ? anchor.vision : DEFAULT_VISION_TILES;
    // Two rows toward the top keeps NPCs in front of the player without taking
    // the player's own cell; clamp so we never step above the board.
    const dy = Math.min(2, anchor.y, radius);
    // Widest horizontal offset that still lands inside the circular vision.
    const maxDx = Math.max(1, Math.floor(Math.sqrt(Math.max(0, radius * radius - dy * dy))));
    const t = total > 1 ? index / (total - 1) : 0.5;
    const dx = Math.round(-maxDx + t * (2 * maxDx));
    return place(anchor.x + dx, anchor.y - dy);
  };

  const count = presentNpcs.length;
  presentNpcs.forEach((npc, index) => {
    const name = npc.displayName || npc.role || npc.npcId;
    tokens.push({
      id: `npc:${npc.npcId}`,
      kind: "npc",
      entityId: npc.npcId,
      displayName: name,
      label: soloTokenInitials(name),
      portraitUri: typeof npc.portraitUri === "string" ? npc.portraitUri : "",
      faction: "npc",
      speed: typeof npc.speed === "number" ? npc.speed : 30,
      vision: typeof npc.vision === "number" ? npc.vision : DEFAULT_VISION_TILES,
      ...placeNpcInSight(index, count, playerSpawn)
    });
  });

  return tokens;
}

function renderSoloMapToken(token, selected = false) {
  const inner = token.portraitUri
    ? `<img src="${escapeHtml(token.portraitUri)}" alt="${escapeHtml(token.displayName)}" />`
    : escapeHtml(token.label);
  return `<span class="solo-token solo-token-${escapeHtml(token.kind)} ${selected ? "solo-token-selected" : ""}" draggable="true" title="${escapeHtml(token.displayName)}" data-token-id="${escapeHtml(token.id)}" data-entity-id="${escapeHtml(token.entityId)}" data-entity-kind="${escapeHtml(token.kind)}">${inner}</span>`;
}

// Pure. Resolves the base tokens (Phase 1) with any persisted/in-progress
// positions from the battle-map state. Returns tokens (with x,y) + a positions
// map keyed by token id (for the movement engine).
export function resolveBattleTokens(scene = {}, mapState = {}) {
  const base = buildSoloMapTokens(scene, { width: SOLO_MAP_WIDTH, height: SOLO_MAP_HEIGHT });
  const saved = mapState && mapState.positions ? mapState.positions : {};
  const tokens = base.map((token) => {
    const pos = saved[token.id];
    return pos && Number.isFinite(pos.x) && Number.isFinite(pos.y) ? { ...token, x: pos.x, y: pos.y } : token;
  });
  const positionsById = {};
  for (const token of tokens) {
    positionsById[token.id] = { x: token.x, y: token.y };
  }
  return { tokens, positionsById };
}

export function renderSoloMapTab(scene = {}, mapState = {}) {
  const width = SOLO_MAP_WIDTH;
  const height = SOLO_MAP_HEIGHT;
  const { tokens, positionsById } = resolveBattleTokens(scene, mapState);
  const selectedId = mapState.selectedTokenId || null;
  const selected = tokens.find((token) => token.id === selectedId) || null;
  const budget = selected ? Math.max(0, tilesForSpeed(selected.speed) - (mapState.movedTiles || 0)) : 0;
  const reachable = selected
    ? computeReachable({ width, height, positions: positionsById, tokenId: selectedId }, budget)
    : new Set();
  const tokenByCell = new Map(tokens.map((token) => [`${token.x},${token.y}`, token]));

  // Fog of war: a cell is revealed if it's in the explored (sticky) set OR
  // within a player-faction token's current vision radius. Fogged cells are
  // darkened and any token standing in fog is hidden.
  const viewers = tokens
    .filter((token) => token.faction === "player")
    .map((token) => ({ x: token.x, y: token.y, radius: token.vision }));
  const revealed = computeRevealed(width, height, viewers);
  for (const key of Array.isArray(mapState.revealed) ? mapState.revealed : []) {
    revealed.add(key);
  }

  const cells = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const key = `${x},${y}`;
      const fogged = !revealed.has(key);
      const token = tokenByCell.get(key);
      const legal = reachable.has(key);
      const showToken = token && !fogged;
      cells.push(
        `<div class="solo-map-cell${legal ? " legal" : ""}${fogged ? " fogged" : ""}" data-cell="${x},${y}">${showToken ? renderSoloMapToken(token, token.id === selectedId) : ""}</div>`
      );
    }
  }

  // Legend lists only currently-visible tokens (fog hides the rest).
  const legend = tokens
    .filter((token) => revealed.has(`${token.x},${token.y}`))
    .map(
      (token) =>
        `<span class="solo-map-legend-item"><span class="solo-token solo-token-${escapeHtml(token.kind)}">${escapeHtml(token.label)}</span>${escapeHtml(token.displayName)}</span>`
    )
    .join("");
  const visibleCount = tokens.filter((token) => revealed.has(`${token.x},${token.y}`)).length;

  const canUndo = Array.isArray(mapState.history) && mapState.history.length > 0;
  const status = selected
    ? `${escapeHtml(selected.displayName)} — ${budget * SOLO_MAP_TILE_FEET} ft of movement left`
    : "Select a token, then drag it or use arrow keys to move (legal tiles glow).";

  return `
    <div class="solo-map-tab" tabindex="0" data-solo-map data-map-width="${width}" data-map-height="${height}">
      <div class="solo-map-toolbar">
        <span class="tag">${width}×${height} grid</span>
        <span class="small">1 tile = ${SOLO_MAP_TILE_FEET} ft</span>
        <span class="tag">Fog of war</span>
        <span class="small solo-map-status">${status}</span>
        <button type="button" class="ghost solo-map-undo" data-map-undo ${canUndo ? "" : "disabled"}>Undo</button>
      </div>
      <div class="solo-map-board" style="grid-template-columns: repeat(${width}, minmax(0, 1fr));" data-map-width="${width}" data-map-height="${height}">
        ${cells.join("")}
      </div>
      ${
        visibleCount
          ? `<div class="solo-map-legend">${legend}</div>`
          : `<div class="solo-map-sub">Nothing in sight — explore to reveal the map.</div>`
      }
    </div>
  `;
}

export function renderSoloRightRail(state = {}) {
  const scene = state.scene || {};
  // Prefer the full server-side cast roster (all run.npcs with portrait URIs);
  // fall back to current-location NPCs for older payloads without `cast`.
  const roster =
    Array.isArray(scene.cast) && scene.cast.length
      ? scene.cast
      : (Array.isArray(scene.visibleEntities) ? scene.visibleEntities : [])
          .filter((entity) => entity?.entityType === "npc")
          .map((entity) => ({
            npcId: String(entity.entityId || "").split(":").slice(1).join(":") || entity.entityId,
            entityId: entity.entityId,
            displayName: entity.displayName,
            role: entity.summary,
            portraitUri: "",
            present: true
          }));

  const cast = roster.length
    ? roster
        .map((member) => {
          const name = member.displayName || "Unknown";
          const role = member.role || "—";
          const entityId = member.entityId || (member.npcId ? `npc:${member.npcId}` : "");
          const portraitUri = typeof member.portraitUri === "string" ? member.portraitUri : "";
          const initial = String(name).trim().slice(0, 1).toUpperCase() || "?";
          const present = member.present !== false;
          const thumb = portraitUri
            ? `<img src="${escapeHtml(portraitUri)}" alt="${escapeHtml(name)}" />`
            : `<span class="solo-cast-thumb-pending" title="Crafting your portrait… (~20s)">${escapeHtml(initial)}</span>`;
          const away = member.present === false ? ` <span class="solo-cast-away">away</span>` : "";
          // Present NPCs carry Talk/Inspect — the affordances the now-removed
          // "Visible Entities" panel held, so entities live in ONE place. Reuses
          // the existing data-solo-action delegation (no handler change) and the
          // .solo-cast-bringback button styling (no new CSS). Bring back stays for
          // everyone.
          return `
            <div class="solo-cast-card">
              <div class="solo-cast-thumb" data-portrait-for="${escapeHtml(entityId)}">${thumb}</div>
              <div class="solo-cast-meta">
                <div class="solo-cast-name">${escapeHtml(name)}${away}</div>
                <div class="solo-cast-role">${escapeHtml(role)}</div>
              </div>
              <div class="solo-cast-actions" style="display:flex;flex-direction:column;gap:4px;">
                ${
                  present
                    ? `<button type="button" class="solo-cast-bringback" data-solo-action="talk" data-entity-id="${escapeHtml(entityId)}">Talk</button>
                       <button type="button" class="solo-cast-bringback" data-solo-action="inspect" data-entity-id="${escapeHtml(entityId)}">Inspect</button>`
                    : ""
                }
                <button type="button" class="solo-cast-bringback" data-solo-npc-bringback data-entity-id="${escapeHtml(entityId)}">Bring back</button>
              </div>
            </div>`;
        })
        .join("")
    : `<div class="solo-empty-state">No one is here yet. Use “Bring someone in” to add a character.</div>`;

  const rollEntries = (Array.isArray(scene.attemptHistory) ? scene.attemptHistory : [])
    .filter((entry) => entry && entry.checkResult)
    .slice(-3)
    .reverse();
  const recentRolls = rollEntries.length
    ? rollEntries
        .map((entry) => {
          const cr = entry.checkResult || {};
          const intent = String(entry.intent || "Check");
          const label = intent.length > 26 ? `${intent.slice(0, 26)}…` : intent;
          const total = cr.total ?? "—";
          const dc = cr.dc ?? "—";
          const cls = cr.success ? "good" : "accent";
          return `<div class="solo-roll"><div><div class="solo-roll-name">${escapeHtml(label)}</div><div class="solo-roll-detail">vs DC ${escapeHtml(dc)}</div></div><span class="solo-roll-total ${cls}">${escapeHtml(total)}</span></div>`;
        })
        .join("")
    : `<div class="solo-empty-state">No rolls yet.</div>`;

  return `
    <aside class="solo-game-rail solo-scene-side">
      <div class="solo-rail-block">
        <div class="solo-stat-kicker">Recent Rolls</div>
        ${recentRolls}
      </div>
      <div class="solo-rail-block">
        <div class="solo-stat-kicker">Cast</div>
        <div class="solo-cast-list">${cast}</div>
      </div>
      <div class="solo-rail-block">
        ${renderMovementPanel(scene)}
      </div>
      <div class="solo-rail-block">
        ${renderSearchResultPanel(state.searchResult, scene.discoveredDetails)}
      </div>
      <div class="solo-rail-block">
        ${renderTalkResultPanel(state.talkResult)}
      </div>
      <div class="solo-rail-block">
        ${renderEntityDetailPanel(state.detail)}
      </div>
    </aside>
  `;
}

// ---------------------------------------------------------------------------
// Visual-novel dialogue overlay
// ---------------------------------------------------------------------------
// Rendered only while `state.dialogueActive` is true (opened by a talk action),
// so the existing right-rail talk panel and all string-render tests are
// untouched. The portrait pulls from talkResult.expressionVariants[expression]
// when the server has generated it (Part 1), otherwise an atmospheric
// placeholder stands in until the image worker finishes. The typewriter reveal
// itself runs in bindSoloSceneShell against live DOM, not in this string.
export function renderSoloDialogueOverlay(state = {}) {
  if (!state.dialogueActive || !state.talkResult) {
    return "";
  }
  const talk = state.talkResult;
  const scene = state.scene || {};
  const expression = typeof talk.expression === "string" && talk.expression ? talk.expression : "neutral";
  const variants = talk.expressionVariants && typeof talk.expressionVariants === "object" ? talk.expressionVariants : {};
  // Fallback chain: requested expression variant -> the NPC's base portrait
  // (from the cast roster) -> atmospheric placeholder. Never a broken image.
  const castMember = (Array.isArray(scene.cast) ? scene.cast : []).find(
    (member) => member && member.npcId === talk.npcId
  ) || null;
  const baseUri = castMember && typeof castMember.portraitUri === "string" ? castMember.portraitUri : "";
  const variantUri = typeof variants[expression] === "string" && variants[expression] ? variants[expression] : "";
  const portraitUri = variantUri || baseUri;
  const speaker = talk.speakerName || "NPC";
  const line = talk.line || "There is not much new to say right now.";
  const typed = state.dialogueTyped === true;
  const initial = String(speaker).trim().slice(0, 1).toUpperCase() || "?";
  // The reply TEXT INPUT is intentionally never disabled — the player must always
  // be able to type. The global busy flag is held by the outer action that opens
  // this overlay (the freeform "speak to X" attempt), so gating the input on it
  // made the box paint dead on arrival. Only the submit BUTTON reflects busy (for
  // feedback); double-submit is prevented by runAction's re-entry guard, and busy
  // always clears in runAction's finally (even on a hung call, via the client
  // request timeout) so submit can never wedge permanently.
  const busy = Boolean(state.busy);
  const replyDraft = typeof state.dialogueReplyDraft === "string" ? state.dialogueReplyDraft : "";

  const portraitInner = portraitUri
    ? `<img class="solo-vn-portrait-img" src="${escapeHtml(portraitUri)}" alt="${escapeHtml(speaker)} portrait" />`
    : `<div class="solo-vn-portrait-placeholder">
        <span>${escapeHtml(initial)}</span>
        <small>Portrait incoming…</small>
      </div>`;

  // Conversation scrollback: the prior exchanges (player + NPC), so the overlay
  // reads as a sustained conversation. The last NPC entry is the current line,
  // which is revealed by the typewriter below — so it's excluded from the
  // scrollback to avoid showing it twice. A few exchanges are kept for context.
  const history = Array.isArray(state.dialogueHistory) ? state.dialogueHistory : [];
  const scrollback = history.slice(0, -1).slice(-4);
  const historyHtml = scrollback.length
    ? `<div class="solo-vn-history">${scrollback
        .map(
          (entry) =>
            `<div class="solo-vn-exchange solo-vn-exchange-${escapeHtml(entry.role || "npc")}">${
              entry.speaker ? `<span class="solo-vn-exchange-who">${escapeHtml(entry.speaker)}</span>` : ""
            }<span class="solo-vn-exchange-text">${escapeHtml(entry.text || "")}</span></div>`
        )
        .join("")}</div>`
    : "";

  // `key` on the portrait forces a fresh element (and thus replays the fade)
  // whenever the expression changes between consecutive lines.
  return `
    <div class="solo-vn-overlay" data-solo-dialogue-overlay role="dialog" aria-modal="true" aria-label="Dialogue with ${escapeHtml(speaker)}">
      <div class="solo-vn-backdrop" data-solo-dialogue-close></div>
      <div class="solo-vn-panel" data-solo-dialogue-panel>
        <div class="solo-vn-portrait" data-expression="${escapeHtml(expression)}" data-portrait-key="${escapeHtml(portraitUri || expression)}">
          ${portraitInner}
        </div>
        <div class="solo-vn-body">
          ${historyHtml}
          <div class="solo-vn-speaker">${escapeHtml(speaker)}</div>
          <div
            class="solo-vn-text ${typed ? "is-complete" : ""}"
            data-solo-dialogue-text
            data-typed="${typed ? "true" : "false"}"
            data-fulltext="${escapeHtml(line)}"
          >${typed ? escapeHtml(line) : ""}</div>
          <div class="solo-vn-reply">
            <input
              type="text"
              class="solo-vn-reply-input"
              data-solo-dialogue-reply-input
              placeholder="Say something — or describe what you do…"
              value="${escapeHtml(replyDraft)}"
            />
            <button type="button" class="solo-vn-reply-submit" data-solo-dialogue-reply-submit ${busy ? "disabled" : ""}>${busy ? "…" : "Reply ›"}</button>
          </div>
          <div class="solo-vn-controls">
            <button type="button" class="solo-vn-end" data-solo-dialogue-end>End conversation</button>
          </div>
        </div>
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// In-scene NPC creator modal
// ---------------------------------------------------------------------------
// Lightweight 3-field modal (portrait / who / how-they-enter), rendered only
// while state.npcCreator.open is true. Field values + the selected File live in
// state so they survive the shell's full-innerHTML re-renders.
export function renderNpcCreatorModal(state = {}) {
  const creator = state.npcCreator || {};
  if (!creator.open) {
    return "";
  }
  const mode = creator.mode === "imagine" ? "imagine" : "upload";
  const loading = creator.loading === true;
  const previewUrl = typeof creator.previewUrl === "string" ? creator.previewUrl : "";
  const error = typeof creator.error === "string" ? creator.error : "";
  const thumbInner = previewUrl
    ? `<img src="${escapeHtml(previewUrl)}" alt="Portrait preview" />`
    : `<span>${mode === "imagine" ? "GM" : "?"}</span>`;

  return `
    <div class="solo-npc-modal-overlay" data-solo-npc-overlay role="dialog" aria-modal="true" aria-label="Bring in a character">
      <div class="solo-npc-modal-backdrop" data-solo-npc-close></div>
      <div class="solo-npc-modal" data-solo-npc-modal>
        <div class="solo-npc-modal-head">
          <h3>Bring someone in</h3>
          <button type="button" class="solo-npc-modal-x" data-solo-npc-close aria-label="Close">×</button>
        </div>

        <div class="solo-npc-field">
          <label class="solo-npc-label">Portrait</label>
          <div class="solo-npc-portrait-row">
            <div class="solo-npc-thumb">${thumbInner}</div>
            <div class="solo-npc-portrait-controls">
              <label class="solo-npc-upload ${mode === "imagine" ? "is-disabled" : ""}">
                <input type="file" accept="image/png,image/jpeg,image/webp" data-solo-npc-file ${mode === "imagine" ? "disabled" : ""} />
                <span>Upload a portrait</span>
              </label>
              <label class="solo-npc-checkbox">
                <input type="checkbox" data-solo-npc-imagine ${mode === "imagine" ? "checked" : ""} />
                <span>Let the GM imagine them</span>
              </label>
              <small class="solo-npc-hint">JPG, PNG, or WEBP · up to 10MB</small>
            </div>
          </div>
        </div>

        <div class="solo-npc-field">
          <label class="solo-npc-label">Who they are</label>
          <input type="text" class="solo-npc-input" data-solo-npc-name placeholder="Name (optional — the GM can name them)" value="${escapeHtml(creator.name || "")}" />
          <input type="text" class="solo-npc-input" data-solo-npc-desc placeholder="a scarred mercenary with a secret" value="${escapeHtml(creator.description || "")}" />
        </div>

        <div class="solo-npc-field">
          <label class="solo-npc-label">How they enter</label>
          <textarea class="solo-npc-textarea" data-solo-npc-intro rows="2" placeholder="My old mentor walks in, looking for me...">${escapeHtml(creator.introInstructions || "")}</textarea>
        </div>

        ${error ? `<div class="solo-npc-error" role="alert">${escapeHtml(error)}</div>` : ""}
        ${loading ? `<div class="solo-npc-loading">The GM is preparing to introduce them…</div>` : ""}

        <div class="solo-npc-actions">
          <button type="button" class="ghost" data-solo-npc-close ${loading ? "disabled" : ""}>Cancel</button>
          <button type="button" class="solo-npc-submit" data-solo-npc-submit ${loading ? "disabled" : ""}>Bring them in</button>
        </div>
      </div>
    </div>
  `;
}

// Formats a run duration (ms) as a compact "Xh Ym" / "Xm Ys" / "Xs" string.
export function formatRunDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) {
    return "—";
  }
  const totalSeconds = Math.floor(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) {
    return `${h}h ${m}m`;
  }
  if (m > 0) {
    return `${m}m ${s}s`;
  }
  return `${s}s`;
}

export function renderSoloSceneShell(state = {}) {
  if (state.loading) {
    return `
      <section class="solo-scene-shell solo-scene-shell-loading">
        <div class="solo-scene-loading">Loading solo scene...</div>
      </section>
    `;
  }

  if (state.error) {
    return `
      <section class="solo-scene-shell solo-scene-shell-error">
        <div class="solo-scene-error">
          <h2>Solo Scene Unavailable</h2>
          <p>${escapeHtml(state.error)}</p>
          <button class="ghost" data-solo-action="reload-scene">Retry</button>
        </div>
      </section>
    `;
  }

  // Victory screen: the main quest was completed (run concluded as a win).
  // Mirrors the death-screen layout with a gold scheme and triumphant copy.
  if (state.victoryScreen) {
    const summary = state.runSummary || {};
    const name = summary.playerName || state.character?.name || "Your adventurer";
    const where = summary.location || state.scene?.location?.name || "the world";
    const played = formatRunDuration(summary.timePlayedMs);
    const questTitle = state.scene?.quests?.mainQuest?.title || "your quest";
    const narration = typeof state.victoryNarration === "string" ? state.victoryNarration : "";
    const narrationTyped = state.victoryTyped === true;
    return `
      <section class="solo-scene-shell solo-victory-screen" data-solo-victory>
        <div class="solo-victory-card">
          <div class="solo-victory-kicker">Victory</div>
          <h2 class="solo-victory-title">${escapeHtml(name)} prevails.</h2>
          ${
            narration
              ? `<p
                   class="solo-victory-narration ${narrationTyped ? "is-complete" : ""}"
                   data-solo-victory-text
                   data-typed="${narrationTyped ? "true" : "false"}"
                   data-fulltext="${escapeHtml(narration)}"
                 >${narrationTyped ? escapeHtml(narration) : ""}</p>`
              : ""
          }
          <p class="solo-victory-sub">You completed <strong>${escapeHtml(questTitle)}</strong>. This chapter is won.</p>
          <dl class="solo-victory-summary">
            <div><dt>Adventurer</dt><dd>${escapeHtml(name)}</dd></div>
            <div><dt>Quest</dt><dd>${escapeHtml(questTitle)}</dd></div>
            <div><dt>Last seen</dt><dd>${escapeHtml(where)}</dd></div>
            <div><dt>Time played</dt><dd>${escapeHtml(played)}</dd></div>
            <div><dt>Outcome</dt><dd>${escapeHtml(summary.outcome || "victory")}</dd></div>
          </dl>
          <button class="solo-victory-home" data-solo-home>Return to your adventures</button>
        </div>
      </section>
    `;
  }

  // Death screen: the run has been concluded as a death; replace the shell with
  // a summary before the player returns to the solo home.
  if (state.deathScreen) {
    const summary = state.runSummary || {};
    const name = summary.playerName || state.character?.name || "Your adventurer";
    const where = summary.location || state.scene?.location?.name || "the wilds";
    const played = formatRunDuration(summary.timePlayedMs);
    return `
      <section class="solo-scene-shell solo-death-screen" data-solo-death>
        <div class="solo-death-card">
          <div class="solo-death-kicker">You Died</div>
          <h2 class="solo-death-title">${escapeHtml(name)} has fallen.</h2>
          <p class="solo-death-sub">Cut down in ${escapeHtml(where)}. This story ends here.</p>
          <dl class="solo-death-summary">
            <div><dt>Adventurer</dt><dd>${escapeHtml(name)}</dd></div>
            <div><dt>Last seen</dt><dd>${escapeHtml(where)}</dd></div>
            <div><dt>Time played</dt><dd>${escapeHtml(played)}</dd></div>
            <div><dt>Outcome</dt><dd>${escapeHtml(summary.outcome || "died")}</dd></div>
          </dl>
          <button class="solo-death-home" data-solo-home>Return to your adventures</button>
        </div>
      </section>
    `;
  }

  const scene = state.scene || {};
  const location = scene.location || {};
  const selectedGmMode = state.gmMode || "placeholder";
  // GM provider/fallback status panel is debug-only (hidden from beta players).
  const debug = state.debug === true;
  const character = state.character || SOLO_SAMPLE_CHARACTER;
  const activeTab = normalizeTab(state.activeTab);
  const skin = normalizeSkin(state.skin);
  const fontSet = normalizeFontSet(state.fontSet);
  const region = location.region || character.region || "Ashenmoor";
  const title = location.name || "Current Scene";

  // Each tab panel is always present in the markup and toggled with `hidden`,
  // so screen-reader/test access to every panel's content is preserved.
  const panel = (id, body) =>
    `<div class="solo-tab-panel" data-solo-tabpanel="${id}" ${id === activeTab ? "" : "hidden"}>${body}</div>`;

  return `
    <section
      class="solo-scene-shell solo-scene-shell-polished solo-game-shell${state.busy ? " is-busy" : ""}"
      data-run-id="${escapeHtml(scene.runId || state.runId || "")}"
      data-solo-busy="${state.busy ? "true" : ""}"
      data-solo-skin="${skin}"
      data-solo-font="${fontSet}"
      style="${soloThemeVarString(skin, fontSet)}"
    >
      <div class="solo-settings ${state.menuOpen ? "open" : ""}">
        <button type="button" class="solo-settings-btn" data-solo-menu-toggle aria-haspopup="true" aria-expanded="${state.menuOpen ? "true" : "false"}" aria-label="Menu" title="Menu">⚙</button>
        ${state.menuOpen ? `
          <div class="solo-settings-menu solo-cog-menu" role="menu">
            <button type="button" class="solo-cog-item" data-solo-exit role="menuitem">Leave Adventure</button>
            <button type="button" class="solo-cog-item" data-solo-cog="Settings" role="menuitem">Settings</button>
            <button type="button" class="solo-cog-item" data-solo-cog="Report a bug" role="menuitem">Report a bug</button>
            ${state.cogNote ? `<div class="solo-cog-note">${escapeHtml(state.cogNote)}</div>` : ""}
          </div>
        ` : ""}
      </div>
      <div class="solo-game-layout">
      <div class="solo-game-frame solo-scene-grid">
        ${renderSoloCharacterSidebar(character)}
        <main class="solo-game-main solo-scene-main">
          <div class="solo-game-header">
            <div class="solo-breadcrumb">${escapeHtml(region)} <span>›</span> ${escapeHtml(title)}</div>
            <div class="solo-game-title">${escapeHtml(title)}</div>
            ${
              scene.quests?.mainQuest && scene.quests.mainQuest.status === "active" && scene.quests.mainQuest.objective
                ? `<div class="small solo-game-objective">Objective: ${escapeHtml(scene.quests.mainQuest.objective)}</div>`
                : ""
            }
          </div>
          <div class="solo-game-content">
            ${
              state.banner
                ? `<div class="solo-banner${state.bannerKind === "info" ? " solo-banner-info" : ""}" role="${state.bannerKind === "info" ? "status" : "alert"}">
                    <span class="solo-banner-msg">${escapeHtml(state.banner)}</span>
                    <button type="button" class="solo-banner-dismiss" data-solo-banner-dismiss aria-label="Dismiss">×</button>
                  </div>`
                : ""
            }
            ${panel(
              "scene",
              `
                <div class="solo-scene-layout" style="grid-template-columns: minmax(0, 1fr);">
                  <div class="solo-scene-center">
                    ${renderSoloUpgradePrompt(scene)}
                    ${typeof scene.openingNarration === "string" && scene.openingNarration.trim() ? renderSoloSceneOpening(scene.openingNarration) : ""}
                    ${renderSoloSceneArt(scene.locationImageUri, { locked: scene.locationImageLocked })}
                    ${renderSoloActionOutcome(state)}
                    ${renderLocationPanel(
                      location,
                      scene.gmNarration,
                      scene.gmStatus,
                      selectedGmMode,
                      debug,
                      { suppressGm: typeof scene.openingNarration === "string" && Boolean(scene.openingNarration.trim()) }
                    )}
                    ${
                      state.gmThinking || state.sceneReloading
                        ? `<div class="solo-thinking" role="status">${state.gmThinking ? "The GM is thinking…" : "Loading scene…"}</div>`
                        : ""
                    }
                    ${renderSoloSceneInputBar(state)}
                  </div>
                </div>
              `
            )}
            ${panel(
              "actions",
              `
                ${renderSceneActionBar(scene)}
                ${renderRestResultPanel(state.restResult)}
                ${renderAttemptPanel(scene, state.attemptResult)}
              `
            )}
            ${panel("character", renderSoloCharacterSheet(character))}
            ${panel(
              "inventory",
              `
                ${renderInventoryPanel(scene)}
                ${renderUseItemResultPanel(state.useItemResult)}
              `
            )}
            ${panel(
              "map",
              `
                <div class="solo-map-view">
                  ${renderSoloMapTab(scene, state.battleMap)}
                  <aside class="solo-map-aside">
                    ${renderMovementPanel(scene)}
                  </aside>
                </div>
              `
            )}
            ${panel(
              "journal",
              `
                ${renderQuestPanel(scene)}
                ${renderSceneTimelinePanel(scene)}
                ${renderSceneMemoryPanel(scene)}
              `
            )}
          </div>
        </main>
        ${renderSoloRightRail(state)}
      </div>
      ${renderSoloGameTabs(activeTab)}
      </div>
      ${renderSoloDialogueOverlay(state)}
      ${renderNpcCreatorModal(state)}
    </section>
  `;
}

export function bindSoloSceneShell(root, handlers = {}) {
  root.querySelectorAll("[data-solo-action='reload-scene']").forEach((button) => {
    button.addEventListener("click", () => handlers.onReload?.());
  });

  root.querySelectorAll("[data-solo-banner-dismiss]").forEach((button) => {
    button.addEventListener("click", () => handlers.onDismissBanner?.());
  });

  root.querySelectorAll("[data-solo-exit]").forEach((button) => {
    button.addEventListener("click", () => handlers.onExit?.());
  });

  root.querySelectorAll("[data-solo-home]").forEach((button) => {
    button.addEventListener("click", () => handlers.onReturnHome?.());
  });

  root.querySelectorAll("[data-solo-menu-toggle]").forEach((button) => {
    button.addEventListener("click", () => handlers.onMenuToggle?.());
  });
  root.querySelectorAll("[data-solo-cog]").forEach((button) => {
    button.addEventListener("click", () => handlers.onCogPlaceholder?.(button.getAttribute("data-solo-cog")));
  });

  // ---- Battle map (Phase 2): select / drag / click-move / arrow keys / undo ----
  const parseCell = (value) => {
    const [x, y] = String(value || "").split(",").map((n) => Number(n));
    return { x, y };
  };
  const ARROW_DELTAS = {
    ArrowUp: [0, -1],
    ArrowDown: [0, 1],
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0]
  };
  // One delegated listener set on the map container instead of per-token /
  // per-cell handlers. Two reasons:
  //   1. Tokens + cells are rebuilt on every render(); a single container
  //      listener covers freshly-rendered children via event.target.closest().
  //   2. The drag bug: dragstart used to call onMapSelectToken -> render(),
  //      which rebuilt the DOM and destroyed the very node being dragged, so the
  //      browser cancelled the drag. dragstart now routes through onMapDragStart,
  //      which selects WITHOUT re-rendering; drop performs the move (and renders)
  //      once the drag has completed.
  const closestMatch = (node, selector) =>
    node && typeof node.closest === "function" ? node.closest(selector) : null;
  const mapEl = root.querySelectorAll("[data-solo-map]")[0] || null;
  if (mapEl && typeof mapEl.addEventListener === "function") {
    mapEl.addEventListener("click", (event) => {
      const target = event?.target;
      if (closestMatch(target, "[data-map-undo]")) {
        handlers.onMapUndo?.();
        return;
      }
      const tokenEl = closestMatch(target, "[data-token-id]");
      if (tokenEl) {
        event.stopPropagation?.();
        handlers.onMapSelectToken?.(tokenEl.getAttribute("data-token-id"));
        return;
      }
      const cellEl = closestMatch(target, "[data-cell]");
      if (cellEl) {
        const { x, y } = parseCell(cellEl.getAttribute("data-cell"));
        handlers.onMapMoveTo?.(x, y);
      }
    });
    mapEl.addEventListener("dragstart", (event) => {
      const tokenEl = closestMatch(event?.target, "[data-token-id]");
      if (!tokenEl) {
        return;
      }
      const tokenId = tokenEl.getAttribute("data-token-id");
      if (event?.dataTransfer && typeof event.dataTransfer.setData === "function") {
        event.dataTransfer.setData("text/plain", tokenId);
      }
      // Select for the drag WITHOUT a re-render so the dragged node survives.
      handlers.onMapDragStart?.(tokenId);
    });
    mapEl.addEventListener("dragover", (event) => {
      if (closestMatch(event?.target, "[data-cell]")) {
        event.preventDefault?.();
      }
    });
    mapEl.addEventListener("drop", (event) => {
      const cellEl = closestMatch(event?.target, "[data-cell]");
      if (!cellEl) {
        return;
      }
      event.preventDefault?.();
      const { x, y } = parseCell(cellEl.getAttribute("data-cell"));
      handlers.onMapMoveTo?.(x, y);
    });
    mapEl.addEventListener("keydown", (event) => {
      const delta = ARROW_DELTAS[event?.key];
      if (!delta) {
        return;
      }
      event.preventDefault?.();
      handlers.onMapArrow?.(delta[0], delta[1]);
    });
  }

  root.querySelectorAll("[data-solo-action='move']").forEach((button) => {
    button.addEventListener("click", () => {
      handlers.onMove?.({
        locationId: button.getAttribute("data-location-id"),
        direction: button.getAttribute("data-direction") || null
      });
    });
  });

  root.querySelectorAll("[data-solo-action='inspect']").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      handlers.onInspect?.({
        entityId: button.getAttribute("data-entity-id")
      });
    });
  });

  root.querySelectorAll("[data-solo-action='search']").forEach((button) => {
    button.addEventListener("click", () => handlers.onSearch?.());
  });

  root.querySelectorAll("[data-solo-action='talk']").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      return handlers.onTalk?.({
        entityId: button.getAttribute("data-entity-id"),
        targetEntityId: button.getAttribute("data-entity-id")
      });
    });
  });

  root.querySelectorAll("[data-solo-action='rest']").forEach((button) => {
    button.addEventListener("click", () => {
      return handlers.onRest?.({
        restType: button.getAttribute("data-rest-type") || "short"
      });
    });
  });

  root.querySelectorAll("[data-solo-action='use_item']").forEach((button) => {
    button.addEventListener("click", () => {
      return handlers.onUseItem?.({
        itemId: button.getAttribute("data-item-id")
      });
    });
  });

  root.querySelectorAll("[data-solo-gm-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      handlers.onGmMode?.({
        mode: button.getAttribute("data-solo-gm-mode")
      });
    });
  });

  root.querySelectorAll(".solo-entity-card.inspectable").forEach((card) => {
    card.addEventListener("click", () => {
      handlers.onInspect?.({
        entityId: card.getAttribute("data-entity-id")
      });
    });
    card.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        handlers.onInspect?.({
          entityId: card.getAttribute("data-entity-id")
        });
      }
    });
  });

  root.querySelectorAll("[data-solo-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      handlers.onTab?.({ tab: button.getAttribute("data-solo-tab") });
    });
  });

  root.querySelectorAll("[data-solo-skin]").forEach((button) => {
    button.addEventListener("click", () => {
      handlers.onSkin?.({ skin: button.getAttribute("data-solo-skin") });
    });
  });

  root.querySelectorAll("[data-solo-font]").forEach((button) => {
    button.addEventListener("click", () => {
      handlers.onFont?.({ fontSet: button.getAttribute("data-solo-font") });
    });
  });

  // ---- Visual-novel dialogue overlay (typewriter + skip + close) ----
  // Only querySelectorAll is used (test mocks expose no querySelector); unknown
  // selectors return [] in the browser and in the lightweight mount test mocks.
  const dialogueTextEl = root.querySelectorAll("[data-solo-dialogue-text]")[0] || null;
  if (dialogueTextEl && typeof dialogueTextEl.getAttribute === "function") {
    const fullText = dialogueTextEl.getAttribute("data-fulltext") || "";
    const alreadyTyped = dialogueTextEl.getAttribute("data-typed") === "true";
    let timer = null;
    const finish = () => {
      if (timer && typeof clearInterval === "function") {
        clearInterval(timer);
      }
      timer = null;
      dialogueTextEl.textContent = fullText;
      dialogueTextEl.classList?.add("is-complete");
      handlers.onDialogueTyped?.();
    };
    if (!alreadyTyped && typeof setInterval === "function") {
      // ~30ms per character typewriter reveal.
      dialogueTextEl.textContent = "";
      let i = 0;
      timer = setInterval(() => {
        i += 1;
        dialogueTextEl.textContent = fullText.slice(0, i);
        if (i >= fullText.length) {
          finish();
        }
      }, 30);
    }
    // Click on the panel skips the typewriter — except the reply controls
    // (input / submit / end), which have their own behavior.
    root.querySelectorAll("[data-solo-dialogue-panel]").forEach((panel) => {
      panel.addEventListener("click", (event) => {
        const target = event?.target;
        if (
          target &&
          typeof target.closest === "function" &&
          target.closest("[data-solo-dialogue-reply-input], [data-solo-dialogue-reply-submit], [data-solo-dialogue-end]")
        ) {
          return;
        }
        if (timer) {
          finish();
        }
      });
    });
  }
  // Backdrop click softly closes the overlay (keeps the right-rail talk summary).
  root.querySelectorAll("[data-solo-dialogue-close]").forEach((el) => {
    el.addEventListener("click", () => handlers.onDialogueClose?.());
  });
  // Explicit "End conversation" exits the VN back to the ambient scene.
  root.querySelectorAll("[data-solo-dialogue-end]").forEach((el) => {
    el.addEventListener("click", (event) => {
      event.stopPropagation?.();
      handlers.onDialogueEnd?.();
    });
  });
  // Player reply: typing updates the draft; Reply button / Enter advances the
  // conversation through the existing talk pipeline (next beat).
  const dialogueReplyInput = root.querySelectorAll("[data-solo-dialogue-reply-input]")[0] || null;
  const submitDialogueReply = () => handlers.onDialogueReply?.();
  root.querySelectorAll("[data-solo-dialogue-reply-submit]").forEach((el) => {
    el.addEventListener("click", (event) => {
      event.stopPropagation?.();
      submitDialogueReply();
    });
  });
  if (dialogueReplyInput && typeof dialogueReplyInput.addEventListener === "function") {
    dialogueReplyInput.addEventListener("input", () => {
      handlers.onDialogueReplyDraft?.({ value: dialogueReplyInput.value });
    });
    dialogueReplyInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        submitDialogueReply();
      }
    });
  }

  // ---- Victory-screen narration typewriter (same treatment as dialogue) ----
  const victoryTextEl = root.querySelectorAll("[data-solo-victory-text]")[0] || null;
  if (victoryTextEl && typeof victoryTextEl.getAttribute === "function") {
    const fullText = victoryTextEl.getAttribute("data-fulltext") || "";
    const alreadyTyped = victoryTextEl.getAttribute("data-typed") === "true";
    let timer = null;
    const finish = () => {
      if (timer && typeof clearInterval === "function") {
        clearInterval(timer);
      }
      timer = null;
      victoryTextEl.textContent = fullText;
      victoryTextEl.classList?.add("is-complete");
      handlers.onVictoryTyped?.();
    };
    if (!alreadyTyped && fullText && typeof setInterval === "function") {
      victoryTextEl.textContent = "";
      let i = 0;
      timer = setInterval(() => {
        i += 1;
        victoryTextEl.textContent = fullText.slice(0, i);
        if (i >= fullText.length) {
          finish();
        }
      }, 30);
    }
    // Click the card (except the home button) skips the typewriter.
    root.querySelectorAll("[data-solo-victory]").forEach((card) => {
      card.addEventListener("click", (event) => {
        const target = event?.target;
        if (target && typeof target.closest === "function" && target.closest("[data-solo-home]")) {
          return;
        }
        if (timer) {
          finish();
        }
      });
    });
  }

  // ---- In-scene NPC creator modal + cast roster ----
  root.querySelectorAll("[data-solo-npc-create]").forEach((button) => {
    button.addEventListener("click", () => handlers.onOpenNpcCreator?.());
  });
  root.querySelectorAll("[data-scene-redo]").forEach((button) => {
    button.addEventListener("click", () => handlers.onSceneRedo?.());
  });
  root.querySelectorAll("[data-scene-save]").forEach((button) => {
    button.addEventListener("click", () => handlers.onSceneSave?.());
  });
  root.querySelectorAll("[data-solo-npc-close]").forEach((el) => {
    el.addEventListener("click", () => handlers.onNpcClose?.());
  });
  root.querySelectorAll("[data-solo-npc-submit]").forEach((button) => {
    button.addEventListener("click", () => handlers.onNpcSubmit?.());
  });
  const npcFileInput = root.querySelectorAll("[data-solo-npc-file]")[0] || null;
  if (npcFileInput && typeof npcFileInput.addEventListener === "function") {
    npcFileInput.addEventListener("change", (event) => {
      handlers.onNpcFile?.({ file: event?.target?.files?.[0] || null });
    });
  }
  const npcImagineInput = root.querySelectorAll("[data-solo-npc-imagine]")[0] || null;
  if (npcImagineInput && typeof npcImagineInput.addEventListener === "function") {
    npcImagineInput.addEventListener("change", (event) => {
      handlers.onNpcMode?.({ imagine: Boolean(event?.target?.checked) });
    });
  }
  for (const [selector, field] of [
    ["[data-solo-npc-name]", "name"],
    ["[data-solo-npc-desc]", "description"],
    ["[data-solo-npc-intro]", "introInstructions"]
  ]) {
    const el = root.querySelectorAll(selector)[0] || null;
    if (el && typeof el.addEventListener === "function") {
      el.addEventListener("input", () => handlers.onNpcField?.({ field, value: el.value }));
    }
  }
  root.querySelectorAll("[data-solo-npc-bringback]").forEach((button) => {
    button.addEventListener("click", () => {
      handlers.onBringBack?.({ entityId: button.getAttribute("data-entity-id") });
    });
  });

  const attemptInput = root.querySelectorAll("[data-solo-attempt-input]")[0] || null;
  const submitAttempt = () => {
    const intent = String(attemptInput?.value || "").trim();
    if (!intent) {
      return;
    }
    handlers.onAttempt?.({ intent });
  };
  root.querySelectorAll("[data-solo-attempt-submit]").forEach((button) => {
    button.addEventListener("click", submitAttempt);
  });
  // Clicking a suggestion fills the attempt input (editable) and focuses it, with
  // the caret at the end — it does NOT submit, so the player can tweak or replace
  // the text. Reuses onAttemptDraft so the draft model stays in sync.
  root.querySelectorAll("[data-solo-suggestion]").forEach((button) => {
    button.addEventListener("click", () => {
      const text = button.getAttribute("data-solo-suggestion") || "";
      if (attemptInput) {
        attemptInput.value = text;
        if (typeof attemptInput.focus === "function") {
          attemptInput.focus();
        }
        try {
          attemptInput.setSelectionRange(text.length, text.length);
        } catch {
          // Not all inputs support selection ranges; ignore.
        }
      }
      handlers.onAttemptDraft?.({ value: text });
    });
  });
  if (attemptInput && typeof attemptInput.addEventListener === "function") {
    attemptInput.addEventListener("input", () => {
      handlers.onAttemptDraft?.({ value: attemptInput.value });
    });
    attemptInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        submitAttempt();
      }
    });
  }
}

export const SOLO_SKIN_STORAGE_KEY = "notdnd.solo.skin";
export const SOLO_FONT_STORAGE_KEY = "notdnd.solo.fontSet";

export function readSoloThemePref(key, fallback) {
  try {
    if (typeof localStorage === "undefined") {
      return fallback;
    }
    return localStorage.getItem(key) || fallback;
  } catch {
    return fallback;
  }
}

// Player-hidden debug surfaces (e.g. the GM provider/fallback status panel) are
// shown only when localStorage notdnd_debug === "true". Off for beta players —
// the "Fallback"/"Placeholder" tags read as "broken" to a real player.
function isDebugEnabled() {
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem("notdnd_debug") === "true";
  } catch {
    return false;
  }
}

export function writeSoloThemePref(key, value) {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(key, value);
    }
  } catch {
    // Persisting the theme is best-effort; ignore storage failures.
  }
}

function freshNpcCreatorState() {
  return {
    open: false,
    mode: "upload",
    file: null,
    previewUrl: "",
    name: "",
    description: "",
    introInstructions: "",
    loading: false,
    error: ""
  };
}

export function mountSoloSceneShell(root, { apiClient, runId }) {
  const state = {
    runId,
    loading: true,
    error: "",
    scene: null,
    character: null,
    detail: null,
    searchResult: null,
    talkResult: null,
    restResult: null,
    useItemResult: null,
    attemptResult: null,
    attemptDraft: "",
    busy: null,
    banner: "",
    // "info" => amber/gold one-time wait notice; anything else => the default
    // (reddish, alert-styled) error banner.
    bannerKind: "",
    // GM provider/fallback status panel: shown only with localStorage
    // notdnd_debug === "true" (hidden from beta players by default).
    debug: isDebugEnabled(),
    gmThinking: false,
    // Run conclusion (death / abandon / victory). runConcluded guards against
    // double-close; death/victory screens swap the shell for a summary; runSummary
    // holds it. pendingVictory is set from an action response's runWon flag and
    // flushed into the victory screen once the action settles.
    runConcluded: false,
    deathScreen: false,
    victoryScreen: false,
    pendingVictory: false,
    // GM-written closing narration for a won run (typewritered on the victory
    // screen before the summary). victoryTyped marks the reveal complete.
    victoryNarration: null,
    victoryTyped: false,
    runSummary: null,
    menuOpen: false,
    cogNote: "",
    battleMap: { positions: {}, selectedTokenId: null, movedTiles: 0, history: [], revealed: [] },
    dialogueActive: false,
    dialogueTyped: false,
    dialogueHistory: [],
    dialogueReplyDraft: "",
    dialogueTargetEntityId: null,
    gmMode: "placeholder",
    activeTab: "scene",
    npcCreator: freshNpcCreatorState(),
    npcCreatorConfirmation: "",
    // Guards re-entry while a Redo/Save location-image request is in flight.
    sceneArtBusy: null,
    skin: normalizeSkin(readSoloThemePref(SOLO_SKIN_STORAGE_KEY, "ashen")),
    fontSet: normalizeFontSet(readSoloThemePref(SOLO_FONT_STORAGE_KEY, "tome"))
  };

  // External/timer-triggered renders are deferred while a text field is focused
  // (see externalRender + the focusout flush below). Any render — user or
  // external — clears it, so a deferred flush never double-renders.
  let pendingExternalRender = false;

  function render() {
    pendingExternalRender = false;
    // Keep the live text input alive across the innerHTML rebuild. The deferral
    // guard (externalRender) only covers TIMER renders; direct render() calls —
    // runAction's start/finally, loadScene, click handlers — would otherwise
    // destroy the focused <input> out from under the player and drop focus/caret.
    // Real symptom: send a VN reply / action, click back to type the next one, and
    // ~1s later the GM call's finally{render()} recreates the box → it "freezes".
    // Capture which field was focused + its caret, restore both after the rebuild.
    const focusSnapshot = captureSoloFocus();
    root.innerHTML = renderSoloSceneShell(state);
    bindSoloSceneShell(root, {
      onReload: loadScene,
      onExit: handleExit,
      onReturnHome: handleReturnHome,
      onDismissBanner: handleDismissBanner,
      onMenuToggle: handleMenuToggle,
      onCogPlaceholder: handleCogPlaceholder,
      onMapSelectToken: handleMapSelectToken,
      onMapDragStart: handleMapDragStart,
      onMapMoveTo: handleMapMoveTo,
      onMapArrow: handleMapArrow,
      onMapUndo: handleMapUndo,
      onMove: handleMove,
      onInspect: handleInspect,
      onSearch: handleSearch,
      onTalk: handleTalk,
      onRest: handleRest,
      onUseItem: handleUseItem,
      onGmMode: handleGmMode,
      onTab: handleTab,
      onSkin: handleSkin,
      onFont: handleFont,
      onAttempt: handleAttempt,
      onAttemptDraft: handleAttemptDraft,
      onDialogueClose: handleDialogueClose,
      onDialogueTyped: handleDialogueTyped,
      onDialogueReply: handleDialogueReply,
      onDialogueReplyDraft: handleDialogueReplyDraft,
      onDialogueEnd: handleDialogueEnd,
      onVictoryTyped: handleVictoryTyped,
      onOpenNpcCreator: handleOpenNpcCreator,
      onSceneRedo: handleSceneRedo,
      onSceneSave: handleSceneSave,
      onNpcClose: handleNpcClose,
      onNpcMode: handleNpcMode,
      onNpcFile: handleNpcFile,
      onNpcField: handleNpcField,
      onNpcSubmit: handleNpcSubmit,
      onBringBack: handleBringBack
    });
    restoreSoloFocus(focusSnapshot);
  }

  // Capture/restore the focused text field across a render(). Identified by a
  // STABLE data-* attribute (the action box and the VN reply box each have a
  // unique one) so the post-rebuild element is the same field. Returns null when
  // nothing relevant is focused — so a render triggered by clicking elsewhere
  // never yanks focus back. The value itself is already restored from state
  // (attemptDraft / dialogueReplyDraft); we only recover focus + caret.
  const SOLO_FOCUS_ATTRS = ["data-solo-attempt-input", "data-solo-dialogue-reply-input"];
  function captureSoloFocus() {
    if (typeof document === "undefined") {
      return null;
    }
    const el = document.activeElement;
    if (!el || (typeof root.contains === "function" && !root.contains(el))) {
      return null;
    }
    const attr = typeof el.hasAttribute === "function" ? SOLO_FOCUS_ATTRS.find((a) => el.hasAttribute(a)) : null;
    if (!attr) {
      return null;
    }
    let start = null;
    let end = null;
    try {
      start = el.selectionStart;
      end = el.selectionEnd;
    } catch {
      // Some input types disallow selection access — focus alone is enough.
    }
    return { attr, start, end };
  }
  function restoreSoloFocus(snapshot) {
    if (!snapshot || typeof root.querySelector !== "function") {
      return;
    }
    const el = root.querySelector(`[${snapshot.attr}]`);
    if (!el || typeof el.focus !== "function" || el.disabled) {
      return;
    }
    el.focus();
    if (snapshot.start !== null && typeof el.setSelectionRange === "function") {
      try {
        el.setSelectionRange(snapshot.start, snapshot.end);
      } catch {
        // Non-fatal — focus is restored even if caret placement isn't supported.
      }
    }
  }

  // True while the user is actively typing in a text input/textarea inside the
  // shell — used to suppress external/timer renders that would clear focus/caret
  // mid-keystroke. Mirrors main.js's isEditingTextField guard. Defensive about
  // headless test roots (no document / no root.contains).
  function isSoloEditingTextField() {
    if (typeof document === "undefined") {
      return false;
    }
    const el = document.activeElement;
    if (!el || el === document.body || (typeof root.contains === "function" && !root.contains(el))) {
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

  // Render driven by an external/timer event (NOT a user click / tab switch). If
  // a text field is focused, skip the innerHTML rebuild and remember to re-run it
  // once focus leaves — a mid-keystroke rebuild would drop focus/caret. User
  // actions call render() directly and are never deferred.
  function externalRender() {
    if (isSoloEditingTextField()) {
      pendingExternalRender = true;
      return;
    }
    render();
  }

  // One-time: when focus leaves a text field, flush any render that was deferred
  // while the user was typing. Listens on `root` (which persists across innerHTML
  // rebuilds); focusout bubbles up to it. The 0ms defer lets activeElement settle
  // so hopping between two text fields doesn't trigger a premature flush.
  if (typeof root.addEventListener === "function") {
    root.addEventListener("focusout", () => {
      if (!pendingExternalRender) {
        return;
      }
      const flush = () => {
        if (pendingExternalRender && !isSoloEditingTextField()) {
          render();
        }
      };
      if (typeof setTimeout === "function") {
        setTimeout(flush, 0);
      } else {
        flush();
      }
    });
  }

  function revokePreview() {
    const url = state.npcCreator?.previewUrl;
    if (url && typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
      try {
        URL.revokeObjectURL(url);
      } catch {
        // best-effort cleanup
      }
    }
  }

  function handleOpenNpcCreator() {
    state.npcCreatorConfirmation = "";
    revokePreview();
    state.npcCreator = { ...freshNpcCreatorState(), open: true };
    render();
  }

  function handleNpcClose() {
    revokePreview();
    state.npcCreator = freshNpcCreatorState();
    render();
  }

  function handleNpcMode({ imagine }) {
    const creator = state.npcCreator;
    creator.mode = imagine ? "imagine" : "upload";
    if (imagine) {
      revokePreview();
      creator.file = null;
      creator.previewUrl = "";
    }
    render();
  }

  function handleNpcFile({ file }) {
    const creator = state.npcCreator;
    revokePreview();
    creator.file = file || null;
    creator.mode = "upload";
    creator.previewUrl =
      file && typeof URL !== "undefined" && typeof URL.createObjectURL === "function"
        ? URL.createObjectURL(file)
        : "";
    render();
  }

  function handleNpcField({ field, value }) {
    // No re-render: keep the live DOM (and caret) intact while typing; state is
    // synced so a later render repopulates from these values.
    const creator = state.npcCreator;
    if (field === "name") {
      creator.name = String(value || "");
    } else if (field === "description") {
      creator.description = String(value || "");
    } else if (field === "introInstructions") {
      creator.introInstructions = String(value || "");
    }
  }

  async function handleNpcSubmit() {
    const creator = state.npcCreator;
    if (!creator || creator.loading) {
      return;
    }
    creator.loading = true;
    creator.error = "";
    render();
    try {
      // Portrait uploaded -> "user"; otherwise AI-portrait "hybrid".
      const origin = creator.file ? "user" : "hybrid";
      const created = await apiClient.createNpc(runId, {
        name: creator.name,
        description: creator.description,
        introInstructions: creator.introInstructions,
        origin
      });
      const npc = created?.npc || null;
      if (creator.file && npc?.npcId) {
        await apiClient.uploadNpcPortrait(runId, npc.npcId, creator.file);
      }
      const name = npc?.generatedName || npc?.displayName || "A new figure";
      revokePreview();
      state.npcCreator = freshNpcCreatorState();
      await loadScene();
      state.npcCreatorConfirmation = `${name} is entering the story…`;
      render();
    } catch (error) {
      creator.loading = false;
      creator.error = String(error?.message || error || "Could not bring them in.");
      render();
    }
  }

  function handleBringBack(entity) {
    // For an NPC already at the current location, "bring back" focuses them via
    // the talk flow (re-engaging any intro/dialogue).
    return handleTalk(entity);
  }

  function handleMenuToggle() {
    state.menuOpen = !state.menuOpen;
    state.cogNote = "";
    render();
  }

  function handleDismissBanner() {
    state.banner = "";
    state.bannerKind = "";
    render();
  }

  // One-time-per-session amber notice on first scene entry, explaining that
  // images stream in so the early placeholders read as intentional, not broken.
  // sessionStorage-gated (shows once per tab session); skipped entirely where
  // sessionStorage is unavailable (tests / SSR), so it never alters test output.
  const IMAGE_WAIT_BANNER_KEY = "notdnd_image_wait_banner_seen";
  function maybeShowImageWaitBanner() {
    const ss = typeof window !== "undefined" ? window.sessionStorage : null;
    if (!ss) {
      return;
    }
    let seen = false;
    try {
      seen = ss.getItem(IMAGE_WAIT_BANNER_KEY) === "true";
    } catch {
      return;
    }
    if (seen) {
      return;
    }
    state.banner =
      "Your world is being illustrated. Portraits and scenes appear as they're ready — usually within 30 seconds.";
    state.bannerKind = "info";
    try {
      ss.setItem(IMAGE_WAIT_BANNER_KEY, "true");
    } catch {
      // best-effort; the banner still shows this load if the write fails.
    }
  }

  // ---- Async feedback wrapper ----------------------------------------------
  // Wraps every network action so it can never fail silently or wait
  // invisibly: it sets a busy flag (disables the input + dims action buttons,
  // guarding against double-submit), arms a 2s "GM is thinking…" lag indicator,
  // surfaces any thrown error as a dismissible in-panel banner, and always
  // clears the busy/lag state when the action settles.
  let lagTimer = null;

  function clearLag() {
    if (lagTimer) {
      clearTimeout(lagTimer);
      lagTimer = null;
    }
    state.gmThinking = false;
  }

  async function runAction(label, fn) {
    if (state.busy) {
      return; // an action is already in flight — ignore re-entry
    }
    state.busy = label;
    state.banner = "";
    clearLag();
    if (typeof setTimeout === "function") {
      // Timer-triggered: the "GM is thinking" lag indicator must not rebuild the
      // DOM (and drop focus) if the player is mid-keystroke in a text field.
      lagTimer = setTimeout(() => {
        state.gmThinking = true;
        externalRender();
      }, 2000);
      if (lagTimer && typeof lagTimer.unref === "function") {
        lagTimer.unref();
      }
    }
    render();
    try {
      await fn();
    } catch (error) {
      state.banner = String(error?.message || error || "Something went wrong. Try again.");
      state.bannerKind = "error";
    } finally {
      state.busy = null;
      clearLag();
      // If this action won the run (main quest completed), swap to the victory
      // screen before the final render.
      await maybeConcludeVictory();
      render();
    }
  }

  // ---- Battle map (Phase 2) ----
  function ensureBattlePositions() {
    if (!state.battleMap.positions || Object.keys(state.battleMap.positions).length === 0) {
      const { positionsById } = resolveBattleTokens(state.scene || {}, state.battleMap);
      state.battleMap.positions = positionsById;
    }
  }

  function persistBattleMap() {
    saveSoloBattleMap(apiClient, runId, {
      width: SOLO_MAP_WIDTH,
      height: SOLO_MAP_HEIGHT,
      positions: state.battleMap.positions,
      revealed: state.battleMap.revealed
    });
  }

  // Fog of war: fold each player-faction token's current vision into the sticky
  // explored set so tiles stay revealed once seen (auto-reveal on movement).
  function accumulateReveal() {
    const { tokens } = resolveBattleTokens(state.scene || {}, state.battleMap);
    const viewers = tokens
      .filter((token) => token.faction === "player")
      .map((token) => ({ x: token.x, y: token.y, radius: token.vision }));
    const merged = new Set(Array.isArray(state.battleMap.revealed) ? state.battleMap.revealed : []);
    for (const cell of computeRevealed(SOLO_MAP_WIDTH, SOLO_MAP_HEIGHT, viewers)) {
      merged.add(cell);
    }
    state.battleMap.revealed = [...merged];
  }

  // One-time seed (run entry): reveal every cell within the player's starting
  // vision radius so the map shows the player's immediate surroundings on load
  // instead of an all-black grid. Movement-time fog (accumulateReveal) is
  // unchanged.
  function seedInitialReveal() {
    const { tokens } = resolveBattleTokens(state.scene || {}, state.battleMap);
    const playerToken = tokens.find((token) => token.faction === "player");
    if (!playerToken) {
      return;
    }
    const radius = Number.isFinite(playerToken.vision) ? playerToken.vision : DEFAULT_VISION_TILES;
    const merged = new Set(Array.isArray(state.battleMap.revealed) ? state.battleMap.revealed : []);
    for (const cell of computeRevealed(SOLO_MAP_WIDTH, SOLO_MAP_HEIGHT, [
      { x: playerToken.x, y: playerToken.y, radius }
    ])) {
      merged.add(cell);
    }
    state.battleMap.revealed = [...merged];
  }

  function handleMapSelectToken(tokenId) {
    ensureBattlePositions();
    state.battleMap.selectedTokenId = tokenId || null;
    state.battleMap.movedTiles = 0; // new activation
    render();
  }

  // Selection at the start of a drag: identical to a click-select but WITHOUT a
  // re-render. Rebuilding the DOM during dragstart removes the node being
  // dragged and the browser aborts the drag — the root cause of "tokens are not
  // draggable". The legal-move highlight simply appears on drop (which renders).
  function handleMapDragStart(tokenId) {
    ensureBattlePositions();
    state.battleMap.selectedTokenId = tokenId || null;
    state.battleMap.movedTiles = 0;
    // Intentionally no render() here.
  }

  function handleMapMoveTo(x, y) {
    const selectedId = state.battleMap.selectedTokenId;
    if (!selectedId) {
      return;
    }
    ensureBattlePositions();
    const { tokens, positionsById } = resolveBattleTokens(state.scene || {}, state.battleMap);
    const token = tokens.find((entry) => entry.id === selectedId);
    if (!token) {
      return;
    }
    const grid = { width: SOLO_MAP_WIDTH, height: SOLO_MAP_HEIGHT, positions: positionsById, tokenId: selectedId };
    const budget = Math.max(0, tilesForSpeed(token.speed) - state.battleMap.movedTiles);
    if (!isLegalMove(grid, budget, x, y)) {
      return; // illegal (too far / occupied / out of bounds) — ignore
    }
    const cost = moveCost(grid, x, y);
    const from = positionsById[selectedId];
    state.battleMap.history.push({ tokenId: selectedId, from: { ...from }, to: { x, y }, cost });
    state.battleMap.positions = { ...positionsById, [selectedId]: { x, y } };
    state.battleMap.movedTiles += cost;
    accumulateReveal(); // auto-reveal fog around the moved token
    persistBattleMap();
    render();
  }

  function handleMapArrow(dx, dy) {
    const selectedId = state.battleMap.selectedTokenId;
    if (!selectedId) {
      return;
    }
    ensureBattlePositions();
    const current = state.battleMap.positions[selectedId];
    if (!current) {
      return;
    }
    handleMapMoveTo(current.x + dx, current.y + dy); // single step; legality enforced inside
  }

  function handleMapUndo() {
    const history = state.battleMap.history;
    if (!history || history.length === 0) {
      return;
    }
    const last = history.pop();
    state.battleMap.positions = { ...state.battleMap.positions, [last.tokenId]: { ...last.from } };
    if (last.tokenId === state.battleMap.selectedTokenId) {
      state.battleMap.movedTiles = Math.max(0, state.battleMap.movedTiles - (last.cost || 0));
    }
    persistBattleMap();
    render();
  }

  function handleCogPlaceholder(label) {
    state.cogNote = `${label} — coming soon`;
    render();
  }

  // Concludes the run server-side exactly once and caches its summary.
  // Best-effort: a failed close must never block the death screen or navigation.
  async function concludeRun(outcome) {
    if (state.runConcluded) {
      return state.runSummary;
    }
    state.runConcluded = true;
    const response = await completeSoloRun(apiClient, runId, outcome);
    state.runSummary = response?.summary || null;
    return state.runSummary;
  }

  // Posts a solo action and flags a pending victory when the server reports the
  // main quest was just completed (response.runWon). The flag is flushed by
  // maybeConcludeVictory once the action settles.
  async function postAction(action) {
    const response = await postSoloAction(apiClient, runId, action);
    if (response && response.runWon) {
      state.pendingVictory = true;
      state.victoryNarration = typeof response.victoryNarration === "string" ? response.victoryNarration : null;
    }
    return response;
  }

  // Concludes the run as a win when it was just won — either via the action
  // response (pendingVictory) or a main quest already flipped to "completed" in
  // the scene (covers reload / re-entry into a won run). Idempotent and mutually
  // exclusive with the death screen. The server already concluded the run as
  // "victory"; concludeRun just fetches the summary (idempotent server-side).
  async function maybeConcludeVictory() {
    if (state.runConcluded || state.deathScreen || state.victoryScreen) {
      return false;
    }
    const wonByQuest = state.scene?.quests?.mainQuest?.status === "completed";
    if (!state.pendingVictory && !wonByQuest) {
      return false;
    }
    state.pendingVictory = false;
    await concludeRun("victory");
    state.victoryScreen = true;
    return true;
  }

  // Navigates to the solo home, flagging the exit so bootstrap() does not
  // auto-resume this (now concluded) run — otherwise "/" would redirect straight
  // back into it (re-entry loop).
  function returnHome() {
    if (typeof window === "undefined") {
      return;
    }
    try {
      window.sessionStorage?.setItem("notdnd_exited_run", "true");
    } catch {
      // sessionStorage may be unavailable; navigation still proceeds.
    }
    // "/" renders the minimal solo home (Continue card + Start a New Adventure +
    // past runs), not the legacy 7-tab GM shell.
    window.location.href = "/";
  }

  async function handleExit() {
    // Voluntary exit ("Leave Adventure"): confirm, close the run as "abandoned"
    // so it is properly concluded (not left active forever), then navigate home.
    if (typeof window === "undefined") {
      return;
    }
    if (typeof window.confirm === "function" && !window.confirm("Leave this adventure? Your progress is saved and the run will be closed.")) {
      return;
    }
    await concludeRun("abandoned");
    returnHome();
  }

  // Returns home from the death screen (run already concluded as "died").
  function handleReturnHome() {
    returnHome();
  }

  function handleDialogueClose() {
    // Close the dialogue overlay without reloading the scene. The talk result
    // remains in state so the right-rail summary stays visible.
    state.dialogueActive = false;
    render();
  }

  function handleDialogueTyped() {
    // Typewriter finished (or was skipped); mark complete so a re-render shows
    // the full line immediately instead of restarting the reveal.
    state.dialogueTyped = true;
  }

  function handleVictoryTyped() {
    // Victory narration typewriter finished/skipped; mark complete so any later
    // re-render shows the full closing line rather than restarting the reveal.
    state.victoryTyped = true;
  }

  function handleTab({ tab }) {
    state.activeTab = normalizeTab(tab);
    render();
  }

  function handleSkin({ skin }) {
    state.skin = normalizeSkin(skin);
    writeSoloThemePref(SOLO_SKIN_STORAGE_KEY, state.skin);
    render();
  }

  function handleFont({ fontSet }) {
    state.fontSet = normalizeFontSet(fontSet);
    writeSoloThemePref(SOLO_FONT_STORAGE_KEY, state.fontSet);
    render();
  }

  function handleAttemptDraft({ value }) {
    state.attemptDraft = String(value || "");
  }

  function handleAttempt({ intent }) {
    if (!state.scene) {
      return;
    }
    return runAction("attempt", async () => {
      const response = await postAction(createAttemptAction({ intent }));
      state.attemptResult = response.attemptResult || response.latestAttemptResult || null;
      state.attemptDraft = "";
      state.searchResult = null;
      state.talkResult = null;
      state.dialogueActive = false;
      state.restResult = null;
      state.useItemResult = null;
      await loadScene();
    });
  }

  // ---- Location-image controls (Redo / Save) ----
  // Redo: ask the server to regenerate the current location image (fresh seed),
  // clear it locally so the "Painting the scene…" placeholder shows, then let
  // the art poll swap the new image in. Save: lock the current image so it is
  // final (Redo/Save controls disappear, never regenerates on revisit).
  function handleSceneRedo() {
    const scene = state.scene;
    if (!scene || !scene.location || scene.locationImageLocked || state.sceneArtBusy) {
      return;
    }
    state.sceneArtBusy = "redo";
    (async () => {
      try {
        await redoLocationImage(apiClient, runId);
        if (state.scene) {
          // Hide the stale image so the placeholder shows and the poll re-arms.
          state.scene = { ...state.scene, locationImageUri: null, locationImageLocked: false };
        }
      } catch (error) {
        state.banner = String(error?.message || error || "Could not redo the scene image.");
        state.bannerKind = "error";
      } finally {
        state.sceneArtBusy = null;
        render();
        scheduleCastPoll();
      }
    })();
  }

  function handleSceneSave() {
    const scene = state.scene;
    if (!scene || !scene.location || scene.locationImageLocked || !scene.locationImageUri || state.sceneArtBusy) {
      return;
    }
    state.sceneArtBusy = "save";
    (async () => {
      try {
        await saveLocationImage(apiClient, runId);
        if (state.scene) {
          state.scene = { ...state.scene, locationImageLocked: true };
        }
      } catch (error) {
        state.banner = String(error?.message || error || "Could not save the scene image.");
        state.bannerKind = "error";
      } finally {
        state.sceneArtBusy = null;
        render();
      }
    })();
  }

  let castPollTimer = null;
  let castPollAttempts = 0;

  function castHasMissingPortraits() {
    // Player portrait still pending?
    const player = state.scene?.player;
    if (player && player.character && !player.portraitUri) {
      return true;
    }
    const cast = state.scene?.cast;
    if (!Array.isArray(cast) || cast.length === 0) {
      return false;
    }
    return cast.some(
      (member) => member && (member.portraitUri === null || member.portraitUri === undefined || member.portraitUri === "")
    );
  }

  // Location background image still pending? (generated async like portraits)
  function locationImageMissing() {
    const scene = state.scene;
    return Boolean(scene && scene.location) && !(typeof scene.locationImageUri === "string" && scene.locationImageUri);
  }

  // Anything in the scene still waiting on async art (portraits or background)?
  function sceneArtPending() {
    return castHasMissingPortraits() || locationImageMissing();
  }

  function stopCastPoll() {
    if (castPollTimer) {
      clearTimeout(castPollTimer);
      castPollTimer = null;
    }
  }

  // Portraits generate ~10-15s after a scene loads (async, no WebSocket), so the
  // first render shows placeholders. Poll the scene a few times until every cast
  // member has a portrait, then stop. Only runs while portraits are missing.
  // Swaps newly-generated portraits into the existing DOM in place — no full
  // re-render — so open menus and in-flight interactions survive the poll.
  // Portrait slots carry data-portrait-for="<player|npc:ID>".
  function applyPortraitUpdates(rootEl, scene) {
    if (!rootEl || !scene || typeof rootEl.querySelectorAll !== "function") {
      return;
    }
    const uris = {};
    if (scene.player) {
      uris.player = typeof scene.player.portraitUri === "string" ? scene.player.portraitUri : "";
    }
    for (const npc of Array.isArray(scene.cast) ? scene.cast : []) {
      if (npc && typeof npc.npcId === "string") {
        uris[`npc:${npc.npcId}`] = typeof npc.portraitUri === "string" ? npc.portraitUri : "";
      }
    }
    rootEl.querySelectorAll("[data-portrait-for]").forEach((slot) => {
      const key = slot.getAttribute("data-portrait-for");
      const uri = uris[key];
      if (!uri) {
        return;
      }
      const img = typeof slot.querySelector === "function" ? slot.querySelector("img") : null;
      if (img) {
        if (img.getAttribute("src") !== uri) {
          img.setAttribute("src", uri);
        }
      } else {
        // Placeholder -> real portrait: replace just this small slot's contents.
        const cls = slot.getAttribute("data-portrait-img-class") || "";
        slot.innerHTML = `<img class="${cls}" src="${escapeHtml(uri)}" alt="" />`;
      }
    });
  }

  // Targeted update: swap a newly-generated location background into the scene
  // banner in place (mirrors applyPortraitUpdates — no full re-render).
  function applySceneArtUpdate(rootEl, scene) {
    const uri = typeof scene?.locationImageUri === "string" ? scene.locationImageUri.trim() : "";
    if (!uri || !rootEl || typeof rootEl.querySelector !== "function") {
      return;
    }
    const art = rootEl.querySelector("[data-scene-art]");
    if (!art) {
      return;
    }
    const locked = Boolean(scene?.locationImageLocked);
    const img = typeof art.querySelector === "function" ? art.querySelector("img.solo-scene-art-img") : null;
    const hasControls = Boolean(art.querySelector("[data-scene-redo]"));
    // Already showing this image with the correct control state — nothing to do.
    if (img && img.getAttribute("src") === uri && hasControls === !locked) {
      return;
    }
    // Rebuild the banner contents (image + Redo/Save unless locked) and re-bind
    // the controls, since replacing innerHTML drops their listeners.
    art.innerHTML = sceneArtInnerHtml(uri, { locked });
    const redoBtn = art.querySelector("[data-scene-redo]");
    if (redoBtn) {
      redoBtn.addEventListener("click", () => handleSceneRedo());
    }
    const saveBtn = art.querySelector("[data-scene-save]");
    if (saveBtn) {
      saveBtn.addEventListener("click", () => handleSceneSave());
    }
  }

  function scheduleCastPoll() {
    stopCastPoll();
    castPollAttempts = 0;
    if (!sceneArtPending() || typeof setTimeout !== "function") {
      return;
    }
    const arm = () => {
      castPollTimer = setTimeout(tick, SOLO_ART_POLL_INTERVAL_MS);
      if (castPollTimer && typeof castPollTimer.unref === "function") {
        castPollTimer.unref();
      }
    };
    const tick = async () => {
      castPollTimer = null;
      castPollAttempts += 1;
      // Never tear down the DOM while the cog menu is open — a full re-render
      // would destroy the open menu and eat in-flight clicks.
      if (state.menuOpen) {
        if (sceneArtPending() && castPollAttempts < SOLO_ART_POLL_MAX_ATTEMPTS) {
          arm();
        }
        return;
      }
      try {
        const refreshed = await fetchSoloScene(apiClient, runId);
        state.scene = {
          ...refreshed,
          gmNarration: state.scene?.gmNarration || null,
          gmStatus: state.scene?.gmStatus || null
        };
        if (refreshed?.player) {
          state.character = characterFromScenePlayer(refreshed.player);
        }
        // Targeted update: only swap newly-available portraits + the location
        // background in place rather than rebuilding the whole shell (which
        // flickers and drops clicks).
        applyPortraitUpdates(root, state.scene);
        applySceneArtUpdate(root, state.scene);
      } catch {
        // best-effort; keep trying until the attempt budget is spent
      }
      if (sceneArtPending() && castPollAttempts < SOLO_ART_POLL_MAX_ATTEMPTS) {
        arm();
      }
    };
    arm();
  }

  async function loadScene() {
    // First load (no scene yet) takes over the shell with the full-screen
    // loader/error. A reload after an action keeps the current scene on screen
    // and shows a brief inline "Loading scene…" strip instead of a blank flash.
    const initial = !state.scene;
    if (initial) {
      state.loading = true;
      state.error = "";
    } else {
      state.sceneReloading = true;
    }
    state.npcCreatorConfirmation = "";
    render();
    try {
      state.scene = await fetchSoloScene(apiClient, runId);
      if (state.scene && state.scene.player) {
        // Surface the player's real character (falls back to the sample only
        // when the payload genuinely lacks a player).
        state.character = characterFromScenePlayer(state.scene.player);
      }
      // Adopt persisted battle-map positions (Phase 2) if the run has them.
      if (state.scene?.battleMap?.positions && typeof state.scene.battleMap.positions === "object") {
        state.battleMap.positions = { ...state.scene.battleMap.positions };
      }
      // Adopt persisted explored fog (Phase 3), then seed reveal around the
      // current player position so the player always sees their surroundings.
      if (Array.isArray(state.scene?.battleMap?.revealed)) {
        state.battleMap.revealed = [...state.scene.battleMap.revealed];
      }
      if (initial) {
        // Run entry: seed the player's starting vision so the map isn't a black
        // grid on first load.
        seedInitialReveal();
        // First entry this session: explain that images stream in.
        maybeShowImageWaitBanner();
      } else {
        // Reload after an action: fold any newly-visible cells into explored fog.
        accumulateReveal();
      }
      try {
        const gmScene = await fetchSoloGmScene(apiClient, runId, { mode: state.gmMode });
        if (gmScene?.gmNarration) {
          state.scene = {
            ...state.scene,
            gmNarration: gmScene.gmNarration,
            gmStatus: gmScene.gmStatus || null
          };
        }
      } catch {
        // Placeholder GM narration is optional and must not block scene rendering.
      }
      // Player downed (0 HP, surfaced via player.status): conclude the run as a
      // death and switch the shell to the death screen.
      if (state.scene?.player?.status === "downed" && !state.runConcluded) {
        await concludeRun("died");
        state.deathScreen = true;
      }
      // Main quest completed in the scene (reload / re-entry into a won run):
      // conclude as a victory. No-op when already concluded or downed.
      await maybeConcludeVictory();
      state.detail = null;
      state.searchResult = null;
      state.talkResult = null;
      state.dialogueActive = false;
      state.restResult = null;
      state.useItemResult = null;
      // VN auto-trigger: the GM/classifier flagged direct dialogue with a named
      // speaker (the freeform "speak to X" path sets scene.vnMode + speakerId
      // server-side). Open the dialogue overlay for that speaker via the talk
      // pipeline. This runs AFTER the resets above so it overrides the default
      // dialogueActive=false when — and only when — vnMode is active. Ambient
      // (vnMode=false) leaves the overlay closed; the manual Talk button is
      // unaffected (it opens via handleTalk + refreshSceneAfterAction, not here).
      if (state.scene && state.scene.vnMode === true && typeof state.scene.speakerId === "string" && state.scene.speakerId.trim()) {
        await openVnDialogueForSpeaker(state.scene.speakerId);
      }
    } catch (error) {
      const message = String(error?.message || error || "Failed to load solo scene.");
      if (initial) {
        // No scene to fall back to — show the full-screen retry surface.
        state.error = message;
      } else {
        // Keep the existing scene visible; surface the failure as a banner.
        state.banner = message;
        state.bannerKind = "error";
      }
    } finally {
      state.loading = false;
      state.sceneReloading = false;
      render();
      scheduleCastPoll();
    }
  }

  function handleMove(move) {
    if (!state.scene) {
      return;
    }
    return runAction("move", async () => {
      await postAction(createMoveAction(state.scene, move));
      await loadScene();
    });
  }

  function handleInspect(entity) {
    return runAction("inspect", async () => {
      state.detail = await postAction(createInspectAction(entity));
    });
  }

  // Several actions share the same epilogue: clear the other result panels and
  // re-fetch the scene, preserving any GM narration already in state.
  async function refreshSceneAfterAction() {
    const refreshed = await fetchSoloScene(apiClient, runId);
    state.scene = {
      ...refreshed,
      gmNarration: state.scene?.gmNarration || null,
      gmStatus: state.scene?.gmStatus || null
    };
  }

  function handleSearch() {
    return runAction("search", async () => {
      const response = await postAction(createSearchAction());
      state.searchResult = response.searchResult || null;
      state.talkResult = null;
      state.dialogueActive = false;
      state.restResult = null;
      state.useItemResult = null;
      await refreshSceneAfterAction();
    });
  }

  function handleTalk(entity) {
    return runAction("talk", async () => {
      const response = await postAction(createTalkAction(entity));
      state.talkResult = response.talkResult || null;
      // Open the visual-novel dialogue overlay and restart the typewriter.
      state.dialogueActive = Boolean(state.talkResult);
      state.dialogueTyped = false;
      // Start a fresh conversation: remember who we're talking to (so replies
      // re-target them through the same talk pipeline) and seed the history with
      // the NPC's opening line.
      state.dialogueTargetEntityId =
        entity.entityId || entity.targetEntityId || (state.talkResult ? `npc:${state.talkResult.npcId}` : null);
      state.dialogueReplyDraft = "";
      state.dialogueHistory =
        state.talkResult && state.talkResult.line
          ? [{ role: "npc", speaker: state.talkResult.speakerName || "NPC", text: state.talkResult.line }]
          : [];
      state.searchResult = null;
      state.restResult = null;
      state.useItemResult = null;
      await refreshSceneAfterAction();
    });
  }

  // Auto-open the VN dialogue overlay from the server's vnMode signal — the
  // freeform "speak to X" path. The classifier set scene.vnMode=true + speakerId
  // server-side, but no dialogue content rides the scene payload, so we pull the
  // speaker's beat through the SAME talk pipeline the manual Talk button uses and
  // converge on the same overlay + dialogue state. postAction directly (NOT
  // runAction): loadScene may already be running inside an action's runAction,
  // whose busy guard would block a nested runAction. Best-effort — on any failure
  // we leave the scene ambient rather than open an empty overlay.
  async function openVnDialogueForSpeaker(speakerId) {
    const target = String(speakerId || "").trim();
    if (!target) {
      return;
    }
    // scene.speakerId arrives as the RAW npcId (the freeform "speak to X" trigger)
    // or, from the GM-driven classifier, an already-"npc:"-prefixed id. The talk
    // pipeline validates targetEntityId against the visible ENTITY id, which is
    // always prefixed — so normalize to "npc:<rawId>" before resolving the beat.
    // Passing the raw id was the bug: validateTalkAction rejected it, no talkResult
    // came back, and the overlay fell through to GM scene narration under a generic
    // "NPC". With the prefix, resolveTalkAction returns the NPC's own beat + name.
    const rawId = target.includes(":") ? target.split(":").slice(1).join(":") : target;
    const entityId = `npc:${rawId}`;
    let talk = null;
    try {
      const resp = await postAction(createTalkAction({ targetEntityId: entityId }));
      talk = resp && resp.talkResult ? resp.talkResult : null;
    } catch {
      talk = null;
    }
    // The dialogue content must be the NPC's OWN line — never the GM scene
    // narration. resolveTalkAction always returns a line for a valid, present NPC
    // (a real unrevealed beat, or an in-character "nothing new yet" placeholder),
    // so a missing line/talkResult means the NPC isn't talkable here: stay ambient
    // rather than open an overlay echoing scene prose under the wrong speaker.
    const line = talk && typeof talk.line === "string" && talk.line.trim() ? talk.line.trim() : "";
    if (!talk || !line) {
      return;
    }
    // Always show the NPC's actual NAME. resolveTalkAction sets speakerName to the
    // NPC's displayName; fall back to the cast roster (keyed by raw npcId) so a
    // known NPC is never labeled the generic "NPC".
    const castName = (Array.isArray(state.scene?.cast) ? state.scene.cast : [])
      .find((member) => member && member.npcId === rawId)?.displayName || null;
    const speakerName = typeof talk.speakerName === "string" && talk.speakerName.trim()
      ? talk.speakerName
      : castName;
    state.talkResult = speakerName && speakerName !== talk.speakerName ? { ...talk, speakerName } : talk;
    state.dialogueActive = true;
    state.dialogueTyped = false;
    state.dialogueTargetEntityId = entityId;
    state.dialogueReplyDraft = "";
    state.dialogueHistory = [{ role: "npc", speaker: speakerName || "NPC", text: line }];
  }

  function handleDialogueReplyDraft({ value }) {
    state.dialogueReplyDraft = String(value || "");
  }

  function handleDialogueReply() {
    if (!state.dialogueActive || !state.talkResult) {
      return undefined;
    }
    const reply = String(state.dialogueReplyDraft || "").trim();
    const target = state.dialogueTargetEntityId || `npc:${state.talkResult.npcId}`;
    return runAction("talk", async () => {
      // The player's line goes into the visible history; the conversation then
      // advances through the SAME talk pipeline (a talk action with no beatId
      // reveals the NPC's next beat) — no parallel dialogue backend.
      if (reply) {
        state.dialogueHistory = [...(state.dialogueHistory || []), { role: "player", speaker: "You", text: reply }];
      }
      state.dialogueReplyDraft = "";
      const response = await postAction(createTalkAction({ entityId: target }));
      const next = response.talkResult || null;
      if (next && next.found !== false && next.line) {
        state.talkResult = next;
        state.dialogueTyped = false;
        state.dialogueHistory = [
          ...(state.dialogueHistory || []),
          { role: "npc", speaker: next.speakerName || "NPC", text: next.line }
        ];
      } else {
        // The NPC has nothing more to add — note it but keep the overlay open so
        // the exit stays explicit (the player clicks "End conversation").
        state.dialogueHistory = [
          ...(state.dialogueHistory || []),
          { role: "system", speaker: "", text: "The conversation winds down. Nothing more to say for now." }
        ];
      }
      state.searchResult = null;
      state.restResult = null;
      state.useItemResult = null;
      await refreshSceneAfterAction();
    });
  }

  function handleDialogueEnd() {
    // Explicit exit: leave the VN overlay back to the ambient scene. The server's
    // vnMode returns to ambient on the player's next (non-talk) action; the
    // overlay closes immediately so the player is back in the scene.
    state.dialogueActive = false;
    state.dialogueReplyDraft = "";
    state.dialogueHistory = [];
    state.dialogueTargetEntityId = null;
    render();
  }

  function handleRest(action) {
    return runAction("rest", async () => {
      const response = await postAction(createRestAction(action));
      state.restResult = response.restResult || null;
      state.searchResult = null;
      state.talkResult = null;
      state.dialogueActive = false;
      state.useItemResult = null;
      await refreshSceneAfterAction();
    });
  }

  function handleUseItem(item) {
    return runAction("use_item", async () => {
      const response = await postAction(createUseItemAction(item));
      state.useItemResult = response.useItemResult || null;
      state.searchResult = null;
      state.talkResult = null;
      state.dialogueActive = false;
      state.restResult = null;
      await refreshSceneAfterAction();
    });
  }

  function handleGmMode({ mode }) {
    state.gmMode = mode === "provider" ? "provider" : "placeholder";
    return runAction("gm-mode", async () => {
      await loadScene();
    });
  }

  render();
  loadScene();
  return {
    reload: loadScene
  };
}
