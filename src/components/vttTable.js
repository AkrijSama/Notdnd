import { clamp } from "../utils/helpers.js";

function renderMapCells(map, tokens) {
  const tokenIndex = new Map(tokens.map((token) => [`${token.x},${token.y}`, token]));
  const cells = [];

  for (let y = 0; y < map.height; y += 1) {
    for (let x = 0; x < map.width; x += 1) {
      const token = tokenIndex.get(`${x},${y}`);
      cells.push(`
        <button class="map-cell" data-cell="${x},${y}">
          ${
            token
              ? `<span class="token" style="background:${token.color}" title="${token.id}">${token.label}</span>`
              : `${x},${y}`
          }
        </button>
      `);
    }
  }

  return cells.join("");
}

export function renderVttTable(state) {
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

  return `
    <section class="module-card">
      <div class="module-header">
        <h2>VTT Table</h2>
        <span class="tag">Grid + tokens + initiative + chat</span>
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
            <span class="small">Click any grid cell to reposition selected token.</span>
          </div>
          <div class="map-board" id="map-board" data-active-token-id="${selectedToken?.id || ""}">
            ${renderMapCells(map, tokens)}
          </div>
        </article>

        <article class="module-card">
          <h3>Initiative Tracker</h3>
          <ul class="list">
            ${state.initiative
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

export function bindVttTable(root, store) {
  const board = root.querySelector("#map-board");
  const tokenSelect = root.querySelector("#token-select");

  if (board && tokenSelect) {
    tokenSelect.addEventListener("change", () => {
      board.setAttribute("data-active-token-id", tokenSelect.value);
    });

    board.querySelectorAll("[data-cell]").forEach((cell) => {
      cell.addEventListener("click", () => {
        const activeTokenId = board.getAttribute("data-active-token-id");
        if (!activeTokenId) {
          return;
        }
        const [rawX, rawY] = String(cell.getAttribute("data-cell") || "0,0").split(",");
        const currentState = store.getState();
        const selectedCampaign =
          currentState.campaigns.find((campaign) => campaign.id === currentState.selectedCampaignId) || currentState.campaigns[0];
        const map =
          currentState.maps.find((entry) => entry.id === selectedCampaign?.activeMapId) || currentState.maps[0];
        if (!map) {
          return;
        }
        const x = clamp(Number(rawX), 0, map.width - 1);
        const y = clamp(Number(rawY), 0, map.height - 1);

        store.setTokenPosition(map.id, activeTokenId, x, y);
        store.pushChatLine({ speaker: "System", text: `Token ${activeTokenId} moved to ${x},${y}.` });
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
