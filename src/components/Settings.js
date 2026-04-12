/**
 * Settings UI Component
 * Allows users to configure AI provider and API key (BYOK)
 */

import {
  saveSettings,
  getSettings,
  testLocalConnection,
  DEFAULT_LOCAL_ENDPOINT,
  DEFAULT_LOCAL_MODEL,
} from '../api/client.js';

export class Settings {
  constructor(containerElement) {
    this.container = containerElement;
    this.providers = [
      { value: 'local', label: 'Ollama (Local)', requiresKey: false, tab: 'local' },
      { value: 'openai', label: 'OpenAI', requiresKey: true, tab: 'cloud' },
      { value: 'grok', label: 'Grok', requiresKey: true, tab: 'cloud' },
      { value: 'gemini', label: 'Gemini', requiresKey: true, tab: 'cloud' },
      { value: 'anthropic', label: 'Anthropic', requiresKey: true, tab: 'cloud' },
      { value: 'openrouter', label: 'OpenRouter', requiresKey: true, tab: 'cloud' },
    ];
    this.cloudProviders = this.providers.filter(provider => provider.requiresKey);
    this.render();
    this.loadSettings();
  }

  render() {
    this.container.innerHTML = `
      <div class="settings-panel">
        <h2>AI Provider Settings</h2>

        <div class="settings-tabs" role="tablist" aria-label="Settings tabs">
          <button id="cloud-tab" class="settings-tab active" data-tab="cloud">Cloud</button>
          <button id="local-tab" class="settings-tab" data-tab="local">Local</button>
        </div>

        <div class="settings-form">
          <div id="cloud-settings" class="settings-section active">
            <div class="form-group">
              <label for="provider-select">Provider:</label>
              <select id="provider-select" class="form-control">
                ${this.cloudProviders.map(p => `
                  <option value="${p.value}">${p.label}</option>
                `).join('')}
              </select>
            </div>

            <div class="form-group" id="api-key-group">
              <label for="api-key-input">API Key:</label>
              <input
                type="password"
                id="api-key-input"
                class="form-control"
                placeholder="Enter your API key"
              />
              <small class="form-text">
                Keys are stored in sessionStorage only and never sent to the server for persistence.
              </small>
            </div>

            <div class="form-actions">
              <button id="save-settings-btn" class="btn btn-primary">Save Cloud Settings</button>
            </div>
          </div>

          <div id="local-settings" class="settings-section">
            <div class="form-group">
              <label for="local-endpoint-input">Endpoint URL:</label>
              <input
                type="text"
                id="local-endpoint-input"
                class="form-control"
                placeholder="${DEFAULT_LOCAL_ENDPOINT}"
              />
              <small class="form-text">
                Local requests go straight from the browser to Ollama and never pass through the app server.
              </small>
            </div>

            <div class="form-group">
              <label for="local-model-input">Model Name:</label>
              <input
                type="text"
                id="local-model-input"
                class="form-control"
                placeholder="${DEFAULT_LOCAL_MODEL}"
              />
            </div>

            <div class="form-actions">
              <button id="test-local-connection-btn" class="btn">Test Connection</button>
              <button id="save-local-settings-btn" class="btn btn-primary">Save Local Settings</button>
            </div>
          </div>

          <div class="form-actions">
            <button id="clear-settings-btn" class="btn btn-secondary">Clear</button>
          </div>

          <div id="settings-status" class="status-message"></div>
        </div>
      </div>
    `;

    this.attachEventListeners();
  }

  attachEventListeners() {
    const cloudTab = this.container.querySelector('#cloud-tab');
    const localTab = this.container.querySelector('#local-tab');
    const providerSelect = this.container.querySelector('#provider-select');
    const apiKeyGroup = this.container.querySelector('#api-key-group');
    const apiKeyInput = this.container.querySelector('#api-key-input');
    const saveBtn = this.container.querySelector('#save-settings-btn');
    const localEndpointInput = this.container.querySelector('#local-endpoint-input');
    const localModelInput = this.container.querySelector('#local-model-input');
    const saveLocalBtn = this.container.querySelector('#save-local-settings-btn');
    const testLocalBtn = this.container.querySelector('#test-local-connection-btn');
    const clearBtn = this.container.querySelector('#clear-settings-btn');

    cloudTab.addEventListener('click', () => this.setActiveTab('cloud'));
    localTab.addEventListener('click', () => this.setActiveTab('local'));

    // Show/hide API key input based on provider
    providerSelect.addEventListener('change', (e) => {
      const provider = this.providers.find(p => p.value === e.target.value);
      if (provider && !provider.requiresKey) {
        apiKeyGroup.style.display = 'none';
        apiKeyInput.value = '';
      } else {
        apiKeyGroup.style.display = 'block';
      }
    });

    // Save settings
    saveBtn.addEventListener('click', () => {
      const provider = providerSelect.value;
      const apiKey = apiKeyInput.value.trim();

      const providerConfig = this.providers.find(p => p.value === provider);

      if (providerConfig.requiresKey && !apiKey) {
        this.showStatus('Please enter an API key', 'error');
        return;
      }

      saveSettings({ provider, apiKey });
      this.setActiveTab('cloud');
      this.showStatus('Cloud settings saved successfully', 'success');
    });

    testLocalBtn.addEventListener('click', async () => {
      testLocalBtn.disabled = true;
      try {
        await testLocalConnection(localEndpointInput.value.trim() || DEFAULT_LOCAL_ENDPOINT);
        this.showStatus('Local connection successful', 'success');
      } catch (error) {
        this.showStatus(`Local connection failed: ${error.message}`, 'error');
      } finally {
        testLocalBtn.disabled = false;
      }
    });

    saveLocalBtn.addEventListener('click', () => {
      saveSettings({
        provider: 'local',
        localEndpoint: localEndpointInput.value.trim() || DEFAULT_LOCAL_ENDPOINT,
        localModel: localModelInput.value.trim() || DEFAULT_LOCAL_MODEL,
      });
      this.setActiveTab('local');
      this.showStatus('Local settings saved successfully', 'success');
    });

    // Clear settings
    clearBtn.addEventListener('click', () => {
      sessionStorage.removeItem('ai_provider');
      sessionStorage.removeItem('ai_cloud_provider');
      sessionStorage.removeItem('ai_api_key');
      sessionStorage.removeItem('ai_local_endpoint');
      sessionStorage.removeItem('ai_local_model');
      sessionStorage.removeItem('gm_auto_spawn_entities');
      providerSelect.value = 'openai';
      apiKeyInput.value = '';
      localEndpointInput.value = DEFAULT_LOCAL_ENDPOINT;
      localModelInput.value = DEFAULT_LOCAL_MODEL;
      apiKeyGroup.style.display = 'block';
      this.setActiveTab('local');
      this.showStatus('Settings cleared', 'info');
    });
  }

  loadSettings() {
    const { provider, cloudProvider, apiKey, localEndpoint, localModel } = getSettings();
    const providerSelect = this.container.querySelector('#provider-select');
    const apiKeyInput = this.container.querySelector('#api-key-input');
    const apiKeyGroup = this.container.querySelector('#api-key-group');
    const localEndpointInput = this.container.querySelector('#local-endpoint-input');
    const localModelInput = this.container.querySelector('#local-model-input');

    providerSelect.value = provider === 'local' ? cloudProvider : provider;
    localEndpointInput.value = localEndpoint || DEFAULT_LOCAL_ENDPOINT;
    localModelInput.value = localModel || DEFAULT_LOCAL_MODEL;

    const providerConfig = this.providers.find(p => p.value === providerSelect.value);
    apiKeyGroup.style.display = providerConfig && !providerConfig.requiresKey ? 'none' : 'block';

    if (apiKey) {
      apiKeyInput.value = apiKey;
    }

    this.setActiveTab(provider === 'local' ? 'local' : 'cloud');
  }

  setActiveTab(tabName) {
    const tabs = this.container.querySelectorAll('.settings-tab');
    const sections = this.container.querySelectorAll('.settings-section');

    tabs.forEach(tab => {
      tab.classList.toggle('active', tab.dataset.tab === tabName);
    });

    sections.forEach(section => {
      section.classList.toggle('active', section.id === `${tabName}-settings`);
    });
  }

  showStatus(message, type = 'info') {
    const statusDiv = this.container.querySelector('#settings-status');
    statusDiv.textContent = message;
    statusDiv.className = `status-message status-${type}`;

    setTimeout(() => {
      statusDiv.textContent = '';
      statusDiv.className = 'status-message';
    }, 3000);
  }
}
