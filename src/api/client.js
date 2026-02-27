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
    async getGmMemory(campaignId) {
      return request(`/api/gm/memory?campaignId=${encodeURIComponent(campaignId)}`);
    },
    async saveGmMemory(payload) {
      return request("/api/gm/memory", {
        method: "POST",
        body: JSON.stringify(payload)
      });
    },
    async searchGmMemory(payload) {
      return request("/api/gm/memory/search", {
        method: "POST",
        body: JSON.stringify(payload)
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
