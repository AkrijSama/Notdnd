import { clamp } from "../utils/helpers.js";

function lockOwner(lockState, resource) {
  const lock = (lockState || []).find((entry) => entry.resource === resource);
  return lock ? lock.ownerName || lock.ownerUserId : null;
}

function renderMapCells(map, tokens, revealedCells = {}, cursorState = []) {
  const tokenIndex = new Map(tokens.map((token) => [`${token.x},${token.y}`, token]));
  const cursorIndex = new Map(cursorState.map((cursor) => [`${cursor.x},${cursor.y}`, cursor]));
  const cells = [];

  for (let y = 0; y < map.height; y += 1) {
    for (let x = 0; x < map.width; x += 1) {
      const token = tokenIndex.get(`${x},${y}`);
      const cursor = cursorIndex.get(`${x},${y}`);
      const key = `${x},${y}`;
      const isFogged = Boolean(map.fogEnabled) && !Boolean(revealedCells[key]);
      cells.push(`
        <button class="map-cell ${isFogged ? "fogged" : ""}" data-cell="${x},${y}">
          ${
            token
              ? `<span class="token" style="background:${token.color}" title="${token.id}">${token.label}</span>`
              : `${x},${y}`
          }
          ${cursor ? `<span class="tag" style="position:absolute; top:2px; left:2px; font-size:10px;">${cursor.displayName}</span>` : ""}
        </button>
      `);
    }
  }

  return cells.join("");
}

export function renderVttTable(state, realtime = {}) {
  const selectedCampaign = state.campaigns.find((campaign) => campaign.id === state.selectedCampaignId) || state.campaigns[0];
  const preferredMapId = selectedCampaign?.activeMapId;
  const map = state.maps.find((entry) => entry.id === preferredMapId) || state.maps[0];
  if (!map) {
    return `
      <section class="module-card">
        <div class="module-header">
          <h2>VTT Table</h2>
          <span class="tag">Grid + tokens + initiative + chat</span>
        </div>
        <div class="small">No maps available yet.</div>
      </section>
    `;
  }

  const tokens = state.tokensByMap[map.id] || [];
  const selectedToken = tokens[0];
  const revealed = state.revealedCellsByMap?.[map.id] || {};
  const presenceUsers = realtime.presenceUsers || [];
  const cursorState = realtime.cursorState || [];
  const lockState = realtime.lockState || [];

  const tokenLockOwner = lockOwner(lockState, "token_move");
  const fogLockOwner = lockOwner(lockState, "fog_edit");
  const initiativeLockOwner = lockOwner(lockState, "initiative_edit");

  return `
    <section class="module-card">
      <div class="module-header">
        <h2>VTT Table</h2>
        <span class="tag">Grid + tokens + initiative + chat + fog + live presence</span>
      </div>

      <div class="inline">
        <span class="tag">Presence: ${presenceUsers.length}</span>
        ${presenceUsers.map((user) => `<span class="tag">${user.displayName}</span>`).join("")}
      </div>

      <div class="grid-two">
        <article class="module-card">
          <div class="module-header">
            <h3>${map.name}</h3>
            <span class="small">${map.width}x${map.height}</span>
          </div>
          <div class="inline">
            <label class="field">
              <span>Move Token</span>
              <select id="token-select">
                ${tokens.map((token) => `<option value="${token.id}">${token.label} (${token.faction})</option>`).join("")}
              </select>
            </label>
            <label class="field">
              <span>Map Interaction</span>
              <select id="map-action-mode">
                <option value="move">Move token</option>
                <option value="fog">Toggle fog</option>
              </select>
            </label>
            <span class="small">Fog enabled: ${map.fogEnabled ? "yes" : "no"}</span>
          </div>

          <div class="inline">
            <button class="ghost" data-lock-action="acquire" data-resource="token_move">Lock Token Move</button>
            <button class="ghost" data-lock-action="release" data-resource="token_move">Unlock Token Move</button>
            <span class="small">Owner: ${tokenLockOwner || "none"}</span>
          </div>
          <div class="inline">
            <button class="ghost" data-lock-action="acquire" data-resource="fog_edit">Lock Fog</button>
            <button class="ghost" data-lock-action="release" data-resource="fog_edit">Unlock Fog</button>
            <span class="small">Owner: ${fogLockOwner || "none"}</span>
          </div>

          <div class="map-board" id="map-board" data-map-id="${map.id}" data-map-width="${map.width}" data-map-height="${map.height}" data-active-token-id="${selectedToken?.id || ""}">
            ${renderMapCells(map, tokens, revealed, cursorState)}
          </div>
        </article>

        <article class="module-card">
          <h3>Initiative Tracker</h3>
          <div class="inline">
            <button class="ghost" data-lock-action="acquire" data-resource="initiative_edit">Lock Initiative</button>
            <button class="ghost" data-lock-action="release" data-resource="initiative_edit">Unlock Initiative</button>
            <span class="small">Owner: ${initiativeLockOwner || "none"}</span>
          </div>
          <ul class="list">
            ${state.initiative
              .filter((turn) => turn.campaignId === selectedCampaign?.id)
              .slice()
              .sort((a, b) => b.value - a.value)
              .map(
                (turn) => `<li class="list-item"><strong>${turn.name}</strong> <span class="tag">${turn.value}</span></li>`
              )
              .join("")}
          </ul>
          <form id="initiative-form" class="inline">
            <input name="name" placeholder="Unit" required />
            <input name="value" type="number" min="1" max="30" placeholder="Init" required />
            <button type="submit" class="ghost">Add</button>
          </form>
        </article>
      </div>
    </section>
  `;
}

export function bindVttTable(root, store, { realtimeClient } = {}) {
  const board = root.querySelector("#map-board");
  const tokenSelect = root.querySelector("#token-select");
  const modeSelect = root.querySelector("#map-action-mode");

  root.querySelectorAll("[data-lock-action]").forEach((button) => {
    button.addEventListener("click", () => {
      const resource = String(button.getAttribute("data-resource") || "");
      const action = String(button.getAttribute("data-lock-action") || "acquire");
      if (!resource || !realtimeClient) {
        return;
      }
      if (action === "acquire") {
        realtimeClient.acquireLock(resource);
      } else {
        realtimeClient.releaseLock(resource);
      }
    });
  });

  if (board && tokenSelect && modeSelect) {
    tokenSelect.addEventListener("change", () => {
      board.setAttribute("data-active-token-id", tokenSelect.value);
    });

    board.addEventListener("mousemove", (event) => {
      if (!realtimeClient) {
        return;
      }
      const rect = board.getBoundingClientRect();
      const relX = event.clientX - rect.left;
      const relY = event.clientY - rect.top;
      const width = Number(board.getAttribute("data-map-width") || 10);
      const height = Number(board.getAttribute("data-map-height") || 10);
      const cellX = clamp(Math.floor((relX / rect.width) * width), 0, width - 1);
      const cellY = clamp(Math.floor((relY / rect.height) * height), 0, height - 1);
      realtimeClient.sendCursor(cellX, cellY, modeSelect.value === "fog" ? "fog" : "move");
    });

    board.querySelectorAll("[data-cell]").forEach((cell) => {
      cell.addEventListener("click", async () => {
        const [rawX, rawY] = String(cell.getAttribute("data-cell") || "0,0").split(",");
        const x = Number(rawX);
        const y = Number(rawY);

        const mapId = String(board.getAttribute("data-map-id") || "");
        if (!mapId) {
          return;
        }

        if (modeSelect.value === "fog") {
          try {
            await store.toggleFogCell({ mapId, x, y });
          } catch (error) {
            store.pushChatLine({ speaker: "System", text: `Fog toggle failed: ${String(error.message || error)}` });
          }
          return;
        }

        const activeTokenId = board.getAttribute("data-active-token-id");
        if (!activeTokenId) {
          return;
        }

        const currentState = store.getState();
        const selectedCampaign =
          currentState.campaigns.find((campaign) => campaign.id === currentState.selectedCampaignId) || currentState.campaigns[0];
        const map =
          currentState.maps.find((entry) => entry.id === selectedCampaign?.activeMapId) || currentState.maps[0];
        if (!map) {
          return;
        }

        const safeX = clamp(x, 0, map.width - 1);
        const safeY = clamp(y, 0, map.height - 1);

        store.setTokenPosition(map.id, activeTokenId, safeX, safeY);
        store.pushChatLine({ speaker: "System", text: `Token ${activeTokenId} moved to ${safeX},${safeY}.` });
      });
    });
  }

  const initForm = root.querySelector("#initiative-form");
  if (initForm) {
    initForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const payload = new FormData(initForm);
      const name = String(payload.get("name") || "").trim();
      const value = clamp(Number(payload.get("value")), 1, 30);
      if (!name) {
        return;
      }

      store.addInitiativeTurn({ name, value });
      store.pushChatLine({ speaker: "System", text: `${name} joined initiative at ${value}.` });
      initForm.reset();
    });
  }
}
