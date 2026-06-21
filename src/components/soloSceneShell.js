import { fetchSoloGmScene, fetchSoloScene, postSoloAction } from "./soloSceneApi.js";

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

export function renderGmNarrationPanel(gmNarration = null, gmStatus = null, selectedMode = "placeholder") {
  const narration = gmNarration?.narration || null;
  if (!narration) {
    return `
      <div class="solo-gm-placeholder">
        <span>Future GM Narration</span>
        <p>Scene narration will appear here later, generated from server truth and memory.</p>
        ${renderGmStatusPanel(gmStatus, selectedMode)}
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
      ${renderGmStatusPanel(gmStatus, selectedMode)}
    </div>
  `;
}

export function renderLocationPanel(location = {}, gmNarration = null, gmStatus = null, selectedMode = "placeholder") {
  const imageLabel = location.imageAssetId ? `Image asset: ${location.imageAssetId}` : "No image assigned yet.";
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
        ${renderTags(location.tags)}
        ${renderGmNarrationPanel(gmNarration, gmStatus, selectedMode)}
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
  const canTalk = entity.entityType === "npc" && Array.isArray(entity.actionTypes) && entity.actionTypes.includes("talk");
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
                  const implemented = action.type === "move" || action.type === "inspect" || action.type === "search" || action.type === "talk" || action.type === "rest";
                  const enabled = action.enabled !== false && implemented;
                  return `
                    <button
                      class="ghost solo-action-button"
                      data-solo-action="${escapeHtml(action.type || "")}"
                      data-location-id="${escapeHtml(action.toLocationId || "")}"
                      data-entity-id="${escapeHtml(action.entityId || action.targetEntityId || "")}"
                      data-rest-type="${escapeHtml(action.restType || "")}"
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
  const tags = details.tags || entity.tags || [];

  return `
    <section class="module-card solo-panel solo-detail-sheet">
      <div class="module-header">
        <h3>Entity Sheet</h3>
        <span class="small">Structured payload</span>
      </div>
      <div class="solo-detail-hero">
        <div class="solo-detail-portrait">${escapeHtml(imageAssetId || "No image assigned.")}</div>
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

  const scene = state.scene || {};
  const selectedEntityId = state.detail?.entity?.entityId || state.detail?.entityId || "";
  const selectedGmMode = state.gmMode || "placeholder";

  return `
    <section class="solo-scene-shell solo-scene-shell-polished" data-run-id="${escapeHtml(scene.runId || state.runId || "")}">
      ${renderSceneHeader(scene, state)}
      <div class="solo-scene-grid">
        <main class="solo-scene-main">
          ${renderLocationPanel(scene.location || {}, scene.gmNarration, scene.gmStatus, selectedGmMode)}
          ${renderMovementPanel(scene)}
          ${renderEntityPanel(scene, selectedEntityId)}
        </main>
        <aside class="solo-scene-side">
          ${renderSceneActionBar(scene)}
          ${renderSearchResultPanel(state.searchResult, scene.discoveredDetails)}
          ${renderTalkResultPanel(state.talkResult)}
          ${renderRestResultPanel(state.restResult)}
          ${renderEntityDetailPanel(state.detail)}
          ${renderSceneTimelinePanel(scene)}
          ${renderSceneMemoryPanel(scene)}
        </aside>
      </div>
    </section>
  `;
}

export function bindSoloSceneShell(root, handlers = {}) {
  root.querySelectorAll("[data-solo-action='reload-scene']").forEach((button) => {
    button.addEventListener("click", () => handlers.onReload?.());
  });

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
}

export function mountSoloSceneShell(root, { apiClient, runId }) {
  const state = {
    runId,
    loading: true,
    error: "",
    scene: null,
    detail: null,
    searchResult: null,
    talkResult: null,
    restResult: null,
    gmMode: "placeholder"
  };

  function render() {
    root.innerHTML = renderSoloSceneShell(state);
    bindSoloSceneShell(root, {
      onReload: loadScene,
      onMove: handleMove,
      onInspect: handleInspect,
      onSearch: handleSearch,
      onTalk: handleTalk,
      onRest: handleRest,
      onGmMode: handleGmMode
    });
  }

  async function loadScene() {
    state.loading = true;
    state.error = "";
    render();
    try {
      state.scene = await fetchSoloScene(apiClient, runId);
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
      state.detail = null;
      state.searchResult = null;
      state.talkResult = null;
      state.restResult = null;
    } catch (error) {
      state.error = String(error?.message || error || "Failed to load solo scene.");
    } finally {
      state.loading = false;
      render();
    }
  }

  async function handleMove(move) {
    if (!state.scene) {
      return;
    }
    try {
      await postSoloAction(apiClient, runId, createMoveAction(state.scene, move));
      await loadScene();
    } catch (error) {
      state.error = String(error?.message || error || "Move failed.");
      render();
    }
  }

  async function handleInspect(entity) {
    try {
      state.detail = await postSoloAction(apiClient, runId, createInspectAction(entity));
      render();
    } catch (error) {
      state.error = String(error?.message || error || "Inspect failed.");
      render();
    }
  }

  async function handleSearch() {
    try {
      const response = await postSoloAction(apiClient, runId, createSearchAction());
      state.searchResult = response.searchResult || null;
      state.talkResult = null;
      state.restResult = null;
      const refreshed = await fetchSoloScene(apiClient, runId);
      state.scene = {
        ...refreshed,
        gmNarration: state.scene?.gmNarration || null,
        gmStatus: state.scene?.gmStatus || null
      };
      render();
    } catch (error) {
      state.error = String(error?.message || error || "Search failed.");
      render();
    }
  }

  async function handleTalk(entity) {
    try {
      const response = await postSoloAction(apiClient, runId, createTalkAction(entity));
      state.talkResult = response.talkResult || null;
      state.searchResult = null;
      state.restResult = null;
      const refreshed = await fetchSoloScene(apiClient, runId);
      state.scene = {
        ...refreshed,
        gmNarration: state.scene?.gmNarration || null,
        gmStatus: state.scene?.gmStatus || null
      };
      render();
    } catch (error) {
      state.error = String(error?.message || error || "Talk failed.");
      render();
    }
  }

  async function handleRest(action) {
    try {
      const response = await postSoloAction(apiClient, runId, createRestAction(action));
      state.restResult = response.restResult || null;
      state.searchResult = null;
      state.talkResult = null;
      const refreshed = await fetchSoloScene(apiClient, runId);
      state.scene = {
        ...refreshed,
        gmNarration: state.scene?.gmNarration || null,
        gmStatus: state.scene?.gmStatus || null
      };
      render();
    } catch (error) {
      state.error = String(error?.message || error || "Rest failed.");
      render();
    }
  }

  async function handleGmMode({ mode }) {
    state.gmMode = mode === "provider" ? "provider" : "placeholder";
    await loadScene();
  }

  render();
  loadScene();
  return {
    reload: loadScene
  };
}
