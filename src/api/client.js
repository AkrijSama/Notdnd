const TOKEN_STORAGE_KEY = "notdnd_auth_token_v1";

function loadToken() {
  return localStorage.getItem(TOKEN_STORAGE_KEY);
}

function saveToken(token) {
  if (token) {
    localStorage.setItem(TOKEN_STORAGE_KEY, token);
  } else {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
  }
}

export function createApiClient(baseUrl = "") {
  let authToken = loadToken();

  async function request(path, options = {}) {
    const headers = {
      "Content-Type": "application/json",
      ...(options.headers || {})
    };

    if (authToken) {
      headers.Authorization = `Bearer ${authToken}`;
    }

    const response = await fetch(`${baseUrl}${path}`, {
      ...options,
      headers
    });

    const payload = await response.json();
    if (!response.ok || payload.ok === false) {
      const error = new Error(payload.error || `Request failed: ${response.status}`);
      error.code = payload.code;
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  }

  return {
    getAuthToken() {
      return authToken;
    },
    setAuthToken(token) {
      authToken = token || null;
      saveToken(authToken);
    },
    async health() {
      return request("/api/health");
    },
    async register({ email, password, displayName }) {
      const response = await request("/api/auth/register", {
        method: "POST",
        body: JSON.stringify({ email, password, displayName })
      });
      if (response?.token) {
        this.setAuthToken(response.token);
      }
      return response;
    },
    async login({ email, password }) {
      const response = await request("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password })
      });
      if (response?.token) {
        this.setAuthToken(response.token);
      }
      return response;
    },
    async logout() {
      const response = await request("/api/auth/logout", {
        method: "POST",
        body: JSON.stringify({})
      });
      this.setAuthToken(null);
      return response;
    },
    async me() {
      return request("/api/auth/me");
    },
    async getState() {
      return request("/api/state");
    },
    async fetchSoloScene(runId) {
      return request(`/api/solo/runs/${encodeURIComponent(runId)}/scene`);
    },
    async fetchSoloGmScene(runId, options = {}) {
      const query = options.mode ? `?mode=${encodeURIComponent(options.mode)}` : "";
      return request(`/api/solo/runs/${encodeURIComponent(runId)}/gm-scene${query}`);
    },
    async postSoloAction(runId, action) {
      return request(`/api/solo/runs/${encodeURIComponent(runId)}/actions`, {
        method: "POST",
        body: JSON.stringify({ action })
      });
    },
    async applyOperation(op, payload = {}, expectedVersion = null) {
      return request("/api/ops", {
        method: "POST",
        body: JSON.stringify({ op, payload, expectedVersion })
      });
    },
    async listCampaignMembers(campaignId) {
      return request(`/api/campaign/members?campaignId=${encodeURIComponent(campaignId)}`);
    },
    async addCampaignMember(payload) {
      return request("/api/campaign/members", {
        method: "POST",
        body: JSON.stringify(payload)
      });
    },
    async listAiProviders() {
      return request("/api/ai/providers");
    },
    async getAiUsage(campaignId) {
      return request(`/api/ai/usage?campaignId=${encodeURIComponent(campaignId)}`);
    },
    async generateAi(payload) {
      return request("/api/ai/generate", {
        method: "POST",
        body: JSON.stringify(payload)
      });
    },
    async respondAsGm(payload) {
      return request("/api/gm/respond", {
        method: "POST",
        body: JSON.stringify(payload)
      });
    },
    async startOnboarding(payload) {
      return request("/api/onboarding/start", {
        method: "POST",
        body: JSON.stringify(payload)
      });
    },
    async getGmMemory(campaignId) {
      return request(`/api/gm/memory?campaignId=${encodeURIComponent(campaignId)}`);
    },
    async getGmMemoryEntity(campaignId, entityName) {
      return request(`/api/gm/memory/${encodeURIComponent(entityName)}?campaignId=${encodeURIComponent(campaignId)}`);
    },
    async saveGmMemory(payload) {
      const campaignId = payload?.campaignId;
      const entity = payload?.entity || {
        name: payload?.docKey || "Untitled",
        type: "lore",
        tags: payload?.docKey ? [payload.docKey] : [],
        body: payload?.content || ""
      };
      return request("/api/gm/memory", {
        method: "POST",
        body: JSON.stringify({ campaignId, entity })
      });
    },
    async upsertGmMemoryEntity(campaignId, entity) {
      return request("/api/gm/memory", {
        method: "POST",
        body: JSON.stringify({ campaignId, entity })
      });
    },
    async deleteGmMemoryEntity(campaignId, entityName) {
      return request(`/api/gm/memory/${encodeURIComponent(entityName)}?campaignId=${encodeURIComponent(campaignId)}`, {
        method: "DELETE"
      });
    },
    async searchGmMemory(payload) {
      return request("/api/gm/memory/search", {
        method: "POST",
        body: JSON.stringify(payload)
      });
    },
    async rebuildGmMemory(campaignId) {
      return request(`/api/gm/memory/rebuild?campaignId=${encodeURIComponent(campaignId)}`, {
        method: "POST",
        body: JSON.stringify({})
      });
    },
    async buildQuickstartCampaign(payload) {
      return request("/api/quickstart/build", {
        method: "POST",
        body: JSON.stringify(payload)
      });
    },
    async parseQuickstartFiles(payload) {
      return request("/api/quickstart/parse", {
        method: "POST",
        body: JSON.stringify(payload)
      });
    },
    async importHomebrewFromUrl(url) {
      return request("/api/homebrew/import-url", {
        method: "POST",
        body: JSON.stringify({ url })
      });
    }
  };
}
