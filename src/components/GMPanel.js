import {
  approvePendingSpawns,
  getCampaignState,
  getGMResponse,
  updateGMSettings,
} from '../api/client.js';
import { createRealtimeClient } from '../realtime/client.js';

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export class GMPanel {
  constructor(containerElement) {
    this.container = containerElement;
    this.gameContext = {
      campaignId: 'quickstart',
      location: 'tavern',
      characters: [],
      inventory: [],
    };
    this.tokens = [];
    this.pendingSpawns = [];
    this.autoSpawnEntities = true;
    this.messageKeys = new Set();
    this.realtime = createRealtimeClient();

    this.render();
    this.attachEventListeners();
    this.attachRealtimeListeners();
    this.loadCampaignState();
    this.appendMessage('System', 'Welcome to NOTDND! Configure your AI provider in Settings, then start playing.');
  }

  render() {
    this.container.innerHTML = `
      <div class="gm-panel">
        <div class="gm-toolbar">
          <div>
            <h2>GM Console</h2>
            <p>Structured narrative responses can spawn NPCs and monsters directly onto the map.</p>
          </div>
          <label class="toggle-control" for="auto-spawn-toggle">
            <input id="auto-spawn-toggle" type="checkbox" checked />
            <span>Auto-spawn entities</span>
          </label>
        </div>

        <div class="gm-layout">
          <section class="gm-column gm-column-main">
            <div id="game-output" class="output-area"></div>
            <div class="input-area">
              <input type="text" id="user-input" placeholder="What do you do?" />
              <button id="submit-action-btn" class="btn btn-primary">Submit</button>
            </div>
            <div id="gm-status" class="status-message"></div>
          </section>

          <aside class="gm-column gm-column-side">
            <div class="vtt-panel">
              <div class="vtt-panel-header">
                <h3>VTT Canvas</h3>
                <span id="token-count-pill" class="pill">0 tokens</span>
              </div>
              <div id="vtt-canvas" class="vtt-canvas"></div>
            </div>

            <div class="pending-panel">
              <div class="pending-panel-header">
                <h3>Pending Spawns</h3>
                <button id="approve-all-spawns-btn" class="btn btn-secondary" type="button">Approve All</button>
              </div>
              <div id="pending-spawn-list" class="pending-spawn-list"></div>
            </div>
          </aside>
        </div>
      </div>
    `;
  }

  attachEventListeners() {
    this.outputElement = this.container.querySelector('#game-output');
    this.inputElement = this.container.querySelector('#user-input');
    this.submitButton = this.container.querySelector('#submit-action-btn');
    this.autoSpawnToggle = this.container.querySelector('#auto-spawn-toggle');
    this.statusElement = this.container.querySelector('#gm-status');
    this.canvasElement = this.container.querySelector('#vtt-canvas');
    this.pendingListElement = this.container.querySelector('#pending-spawn-list');
    this.approveAllButton = this.container.querySelector('#approve-all-spawns-btn');
    this.tokenCountElement = this.container.querySelector('#token-count-pill');

    this.submitButton.addEventListener('click', () => {
      this.handleSubmit();
    });

    this.inputElement.addEventListener('keypress', (event) => {
      if (event.key === 'Enter') {
        this.handleSubmit();
      }
    });

    this.autoSpawnToggle.addEventListener('change', async () => {
      const enabled = this.autoSpawnToggle.checked;
      this.autoSpawnToggle.disabled = true;

      try {
        const response = await updateGMSettings(enabled, this.gameContext);
        this.applyCampaignState(response.campaign);
        this.showStatus(
          enabled ? 'Auto-spawn enabled. New entities will appear on the map immediately.' : 'Auto-spawn disabled. New entities will queue for approval.',
          'info'
        );
      } catch (error) {
        this.autoSpawnToggle.checked = !enabled;
        this.showStatus(`Failed to update GM settings: ${error.message}`, 'error');
      } finally {
        this.autoSpawnToggle.disabled = false;
      }
    });

    this.approveAllButton.addEventListener('click', () => {
      this.handleApprovePending([]);
    });
  }

  attachRealtimeListeners() {
    this.realtime.subscribe('system:connected', () => {
      this.showStatus('Realtime feed connected.', 'info');
    });

    this.realtime.subscribe('gm:spawn', (token) => {
      if (!token || !token.id) {
        return;
      }

      this.upsertToken(token);
      this.renderTokens();
      this.showStatus(`${token.name} entered the map.`, 'success');
    });
  }

  async loadCampaignState() {
    try {
      const response = await getCampaignState(this.gameContext);
      this.applyCampaignState(response.campaign);
    } catch (error) {
      this.showStatus(`Failed to load campaign state: ${error.message}`, 'error');
    }
  }

  applyCampaignState(campaign = {}) {
    this.tokens = Array.isArray(campaign.tokens) ? [...campaign.tokens] : [];
    this.pendingSpawns = Array.isArray(campaign.pendingSpawns) ? [...campaign.pendingSpawns] : [];
    this.autoSpawnEntities = campaign.settings?.autoSpawnEntities ?? true;

    if (this.autoSpawnToggle) {
      this.autoSpawnToggle.checked = this.autoSpawnEntities;
    }

    if (Array.isArray(campaign.chatLog)) {
      campaign.chatLog.forEach((message) => {
        this.appendMessage(message.sender, message.text, message.type, `chat:${message.id}`);
      });
    }

    this.renderTokens();
    this.renderPendingSpawns();
  }

  appendMessage(sender, text, type = 'normal', key = `local:${Date.now()}:${Math.random()}`) {
    if (this.messageKeys.has(key)) {
      return;
    }

    this.messageKeys.add(key);

    const message = document.createElement('div');
    message.className = `message message-${type}`;
    message.innerHTML = `<strong>${escapeHtml(sender)}:</strong> ${escapeHtml(text)}`;
    this.outputElement.appendChild(message);
    this.outputElement.scrollTop = this.outputElement.scrollHeight;
  }

  upsertToken(token) {
    const existingIndex = this.tokens.findIndex((currentToken) => currentToken.id === token.id);

    if (existingIndex >= 0) {
      this.tokens.splice(existingIndex, 1, token);
      return;
    }

    this.tokens.push(token);
  }

  renderTokens() {
    this.canvasElement.innerHTML = this.tokens.map((token) => {
      const initials = token.name
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((part) => part[0]?.toUpperCase() || '')
        .join('');

      return `
        <div
          class="vtt-token"
          style="left: ${token.x}px; top: ${token.y}px; background: ${escapeHtml(token.tokenColor)};"
          title="${escapeHtml(token.name)}"
        >
          <span class="token-label">${escapeHtml(initials || '?')}</span>
          <span class="token-meta">${escapeHtml(token.hp)}/${escapeHtml(token.maxHp)}</span>
        </div>
      `;
    }).join('');

    this.tokenCountElement.textContent = `${this.tokens.length} token${this.tokens.length === 1 ? '' : 's'}`;
  }

  renderPendingSpawns() {
    if (!this.pendingSpawns.length) {
      this.pendingListElement.innerHTML = `
        <div class="pending-empty">
          Auto-spawn is ${this.autoSpawnEntities ? 'enabled' : 'disabled'}, and there are no entities waiting for approval.
        </div>
      `;
      this.approveAllButton.disabled = true;
      return;
    }

    this.pendingListElement.innerHTML = this.pendingSpawns.map((pendingSpawn) => `
      <div class="pending-card">
        <div class="pending-card-copy">
          <strong>${escapeHtml(pendingSpawn.entity.name)}</strong>
          <span>${escapeHtml(pendingSpawn.entity.type)} • ${escapeHtml(pendingSpawn.entity.disposition)}</span>
          <span>HP ${escapeHtml(pendingSpawn.entity.hp)} • AC ${escapeHtml(pendingSpawn.entity.ac)}</span>
        </div>
        <button class="btn btn-primary approve-spawn-btn" data-spawn-id="${escapeHtml(pendingSpawn.id)}" type="button">
          Approve
        </button>
      </div>
    `).join('');

    this.approveAllButton.disabled = false;

    this.pendingListElement.querySelectorAll('.approve-spawn-btn').forEach((button) => {
      button.addEventListener('click', () => {
        this.handleApprovePending([button.dataset.spawnId]);
      });
    });
  }

  async handleSubmit() {
    const input = this.inputElement.value.trim();
    if (!input) {
      return;
    }

    this.inputElement.value = '';
    this.submitButton.disabled = true;
    this.appendMessage('You', input);

    try {
      const response = await getGMResponse(this.gameContext, input, {
        autoSpawnEntities: this.autoSpawnEntities,
        forceServer: true,
      });

      if (response.campaign) {
        this.applyCampaignState(response.campaign);
      } else if (response.result) {
        this.appendMessage('GM', response.result);
      }

      if (Array.isArray(response.spawn) && response.spawn.length > 0) {
        this.showStatus(`Spawned ${response.spawn.length} ${response.spawn.length === 1 ? 'entity' : 'entities'} onto the map.`, 'success');
      } else if (Array.isArray(response.pendingSpawns) && response.pendingSpawns.length > 0) {
        this.showStatus(`${response.pendingSpawns.length} spawn${response.pendingSpawns.length === 1 ? '' : 's'} queued for approval.`, 'info');
      } else {
        this.showStatus('GM response received.', 'info');
      }
    } catch (error) {
      this.appendMessage('System', `Error: ${error.message}`, 'error');
      this.showStatus(`GM request failed: ${error.message}`, 'error');
    } finally {
      this.submitButton.disabled = false;
      this.inputElement.focus();
    }
  }

  async handleApprovePending(pendingSpawnIds) {
    this.approveAllButton.disabled = true;

    try {
      const response = await approvePendingSpawns(pendingSpawnIds, this.gameContext);
      this.applyCampaignState(response.campaign);

      const approvedCount = Array.isArray(response.approved) ? response.approved.length : 0;
      this.showStatus(
        approvedCount > 0
          ? `Approved ${approvedCount} pending spawn${approvedCount === 1 ? '' : 's'}.`
          : 'No pending spawns were approved.',
        approvedCount > 0 ? 'success' : 'info'
      );
    } catch (error) {
      this.showStatus(`Failed to approve pending spawns: ${error.message}`, 'error');
    } finally {
      this.approveAllButton.disabled = this.pendingSpawns.length === 0;
    }
  }

  showStatus(message, type = 'info') {
    this.statusElement.textContent = message;
    this.statusElement.className = `status-message status-${type}`;
  }
}
