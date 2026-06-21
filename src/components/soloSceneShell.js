import { fetchSoloScene, postSoloAction } from "./soloSceneApi.js";

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function labelForAction(action = {}) {
  if (action.label) {
    return action.label;
  }
  if (action.type === "move" && action.toLocationId) {
    return `Move to ${action.toLocationId}`;
  }
  return String(action.type || "Action");
}

function listItems(items, emptyLabel, renderItem) {
  if (!Array.isArray(items) || items.length === 0) {
    return `<li class="list-item small">${escapeHtml(emptyLabel)}</li>`;
  }
  return items.map(renderItem).join("");
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

export function renderSoloSceneShell(state = {}) {
  if (state.loading) {
    return `
      <section class="solo-scene-shell">
        <div class="solo-scene-loading">Loading solo scene...</div>
      </section>
    `;
  }

  if (state.error) {
    return `
      <section class="solo-scene-shell">
        <div class="solo-scene-error">
          <h2>Solo Scene Unavailable</h2>
          <p>${escapeHtml(state.error)}</p>
          <button class="ghost" data-solo-action="reload-scene">Retry</button>
        </div>
      </section>
    `;
  }

  const scene = state.scene || {};
  const location = scene.location || {};
  const imageLabel = location.imageAssetId
    ? `Image asset: ${location.imageAssetId}`
    : "Location image placeholder";
  const detail = state.detail || null;

  return `
    <section class="solo-scene-shell" data-run-id="${escapeHtml(scene.runId || state.runId || "")}">
      <header class="solo-scene-header">
        <div>
          <div class="small">Solo Run ${escapeHtml(scene.runId || state.runId || "Unknown")}</div>
          <h2>${escapeHtml(location.name || "Unknown Location")}</h2>
        </div>
        <span class="tag">${escapeHtml(scene.edition || "mainline")}</span>
      </header>

      <div class="solo-scene-grid">
        <main class="solo-scene-main">
          <section class="solo-location-card">
            <div class="solo-location-image" data-image-asset-id="${escapeHtml(location.imageAssetId || "")}">
              <span>${escapeHtml(imageLabel)}</span>
            </div>
            <div class="solo-location-copy">
              <h3>${escapeHtml(location.name || "Current Location")}</h3>
              <p>${escapeHtml(location.description || "No location description is available.")}</p>
              <div class="solo-gm-placeholder">GM narration will appear here later.</div>
            </div>
          </section>

          <section class="module-card">
            <div class="module-header">
              <h3>Exits</h3>
              <span class="small">${Array.isArray(scene.availableMoves) ? scene.availableMoves.length : 0} available</span>
            </div>
            <div class="solo-button-grid">
              ${listItems(scene.availableMoves, "No connected locations.", (move) => `
                <button
                  class="ghost solo-move-button"
                  data-solo-action="move"
                  data-location-id="${escapeHtml(move.locationId || move.toLocationId || "")}"
                  data-direction="${escapeHtml(move.direction || "")}"
                >
                  ${escapeHtml(move.direction ? `${move.direction}: ${move.name || move.locationId}` : move.name || move.locationId)}
                </button>
              `)}
            </div>
          </section>

          <section class="module-card">
            <div class="module-header">
              <h3>Visible Entities</h3>
              <span class="small">${Array.isArray(scene.visibleEntities) ? scene.visibleEntities.length : 0} visible</span>
            </div>
            <div class="solo-entity-grid">
              ${listItems(scene.visibleEntities, "No visible entities.", (entity) => `
                <article class="solo-entity-card" data-entity-id="${escapeHtml(entity.entityId || "")}">
                  <div class="inline">
                    <strong>${escapeHtml(entity.displayName || entity.entityId || "Entity")}</strong>
                    <span class="tag">${escapeHtml(entity.entityType || "entity")}</span>
                  </div>
                  <p class="small">${escapeHtml(entity.summary || "Inspectable server entity.")}</p>
                  <button
                    class="ghost"
                    data-solo-action="inspect"
                    data-entity-id="${escapeHtml(entity.entityId || "")}"
                    ${entity.inspectable === false ? "disabled" : ""}
                  >
                    Inspect
                  </button>
                </article>
              `)}
            </div>
          </section>
        </main>

        <aside class="solo-scene-side">
          <section class="module-card">
            <div class="module-header">
              <h3>Action Bar</h3>
              <span class="small">Server actions</span>
            </div>
            <div class="solo-action-bar">
              ${listItems(scene.availableActions, "No actions available.", (action) => {
                const implemented = action.type === "move" || action.type === "inspect";
                const enabled = action.enabled !== false && implemented;
                return `
                  <button
                    class="ghost"
                    data-solo-action="${escapeHtml(action.type || "")}"
                    data-location-id="${escapeHtml(action.toLocationId || "")}"
                    data-entity-id="${escapeHtml(action.entityId || "")}"
                    ${enabled ? "" : "disabled"}
                    title="${escapeHtml(enabled ? labelForAction(action) : action.reason || "Not implemented yet")}"
                  >
                    ${escapeHtml(labelForAction(action))}
                  </button>
                `;
              })}
            </div>
          </section>

          <section class="module-card">
            <div class="module-header">
              <h3>Inspect Details</h3>
              <span class="small">Structured payload</span>
            </div>
            ${
              detail
                ? `
                  <div class="solo-detail-panel">
                    <h4>${escapeHtml(detail.details?.title || detail.entity?.displayName || "Entity")}</h4>
                    <p>${escapeHtml(detail.details?.description || detail.entity?.summary || "No details available.")}</p>
                    <div class="small">Actions: ${(detail.details?.availableActions || []).map((entry) => escapeHtml(entry.type || entry)).join(", ") || "None"}</div>
                  </div>
                `
                : `<p class="small">Inspect a visible entity to show server details.</p>`
            }
          </section>

          <section class="module-card">
            <div class="module-header">
              <h3>Recent Timeline</h3>
              <span class="small">Run events</span>
            </div>
            <ul class="list">
              ${listItems(scene.recentTimeline, "No timeline events yet.", (event) => `
                <li class="list-item">
                  <strong>${escapeHtml(event.title || event.type || "Event")}</strong>
                  <div class="small">${escapeHtml(event.summary || "")}</div>
                </li>
              `)}
            </ul>
          </section>

          <section class="module-card">
            <div class="module-header">
              <h3>Relevant Memory</h3>
              <span class="small">Server facts</span>
            </div>
            <ul class="list">
              ${listItems(scene.relevantMemoryFacts, "No relevant facts yet.", (fact) => `
                <li class="list-item">
                  <strong>${escapeHtml(fact.type || "fact")}</strong>
                  <div class="small">${escapeHtml(fact.text || "")}</div>
                </li>
              `)}
            </ul>
          </section>
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
    button.addEventListener("click", () => {
      handlers.onInspect?.({
        entityId: button.getAttribute("data-entity-id")
      });
    });
  });
}

export function mountSoloSceneShell(root, { apiClient, runId }) {
  const state = {
    runId,
    loading: true,
    error: "",
    scene: null,
    detail: null
  };

  function render() {
    root.innerHTML = renderSoloSceneShell(state);
    bindSoloSceneShell(root, {
      onReload: loadScene,
      onMove: handleMove,
      onInspect: handleInspect
    });
  }

  async function loadScene() {
    state.loading = true;
    state.error = "";
    render();
    try {
      state.scene = await fetchSoloScene(apiClient, runId);
      state.detail = null;
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

  render();
  loadScene();
  return {
    reload: loadScene
  };
}
