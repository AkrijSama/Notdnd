const TOKEN_STORAGE_KEY = "notdnd_auth_token_v1";

// Guarded: privacy browsers (Brave shields, incognito with site data blocked)
// throw a SecurityError on any localStorage access. This runs at module load,
// so an unguarded throw blanks the whole app. Degrade gracefully — no persisted
// token, session stays in memory.
function loadToken() {
  try {
    if (typeof localStorage === "undefined") {
      return null;
    }
    return localStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

function saveToken(token) {
  try {
    if (typeof localStorage === "undefined") {
      return;
    }
    if (token) {
      localStorage.setItem(TOKEN_STORAGE_KEY, token);
    } else {
      localStorage.removeItem(TOKEN_STORAGE_KEY);
    }
  } catch {
    // Best-effort persistence; ignore storage failures (privacy/blocked storage).
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
    async listSoloRuns() {
      return request("/api/solo/runs");
    },
    async deleteSoloRun(runId) {
      return request(`/api/solo/runs/${encodeURIComponent(runId)}`, {
        method: "DELETE"
      });
    },
    async deleteCampaign(campaignId) {
      return request(`/api/campaigns/${encodeURIComponent(campaignId)}`, {
        method: "DELETE"
      });
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
    async saveSoloBattleMap(runId, battleMap) {
      return request(`/api/solo/runs/${encodeURIComponent(runId)}/map`, {
        method: "POST",
        body: JSON.stringify(battleMap || {})
      });
    },
    async completeSoloRun(runId, outcome) {
      return request(`/api/solo/runs/${encodeURIComponent(runId)}/complete`, {
        method: "POST",
        body: JSON.stringify({ outcome: outcome || "completed" })
      });
    },
    async redoLocationImage(runId) {
      return request(`/api/solo/runs/${encodeURIComponent(runId)}/location-image/redo`, {
        method: "POST",
        body: JSON.stringify({})
      });
    },
    async saveLocationImage(runId) {
      return request(`/api/solo/runs/${encodeURIComponent(runId)}/location-image/save`, {
        method: "POST",
        body: JSON.stringify({})
      });
    },
    async createNpc(runId, { name, description, introInstructions, origin } = {}) {
      return request(`/api/solo/runs/${encodeURIComponent(runId)}/npcs`, {
        method: "POST",
        body: JSON.stringify({ name, description, introInstructions, origin })
      });
    },
    async uploadNpcPortrait(runId, npcId, file) {
      // Multipart upload — must NOT set Content-Type so the browser supplies the
      // multipart boundary. Reuses the closure's auth token / base URL.
      const headers = {};
      if (authToken) {
        headers.Authorization = `Bearer ${authToken}`;
      }
      const form = new FormData();
      form.append("file", file);
      const response = await fetch(
        `${baseUrl}/api/solo/runs/${encodeURIComponent(runId)}/npcs/${encodeURIComponent(npcId)}/portrait`,
        { method: "POST", headers, body: form }
      );
      const payload = await response.json();
      if (!response.ok || payload.ok === false) {
        const error = new Error(payload.error || `Request failed: ${response.status}`);
        error.code = payload.code;
        error.status = response.status;
        error.payload = payload;
        throw error;
      }
      return payload;
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
    // Custom homebrew content (manually authored).
    async listCustomHomebrew() {
      return request("/api/homebrew/custom");
    },
    async createCustomHomebrew(item) {
      return request("/api/homebrew/custom", {
        method: "POST",
        body: JSON.stringify({ item })
      });
    },
    async deleteCustomHomebrew(id) {
      return request(`/api/homebrew/custom/${encodeURIComponent(id)}`, {
        method: "DELETE"
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
    async previewWorld(definition) {
      return request("/api/onboarding/world", {
        method: "POST",
        body: JSON.stringify({ world: definition })
      });
    },
    async regenerateWorldField({ definition, field, salt }) {
      return request("/api/onboarding/world/field", {
        method: "POST",
        body: JSON.stringify({ definition, field, salt })
      });
    },
    async createWorldRun({ world, character, draftPortraitId = null }) {
      return request("/api/onboarding/world-run", {
        method: "POST",
        body: JSON.stringify({ world, character, draftPortraitId })
      });
    },
    // Mid-creation portrait: request generation (server returns a draftId) and
    // poll it. No run exists yet.
    async requestDraftPortrait({ character, world }) {
      return request("/api/onboarding/portrait", {
        method: "POST",
        body: JSON.stringify({ character, world })
      });
    },
    async getDraftPortrait(draftId) {
      return request(`/api/onboarding/portrait/${encodeURIComponent(draftId)}`);
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
    },
    // PDF sourcebook import — pass { file } (a File) to upload+extract, or
    // { text } to parse pasted text. Returns review candidates (NOT saved).
    async importSourcebookPdf({ file = null, text = "" } = {}) {
      if (file) {
        const headers = {};
        if (authToken) {
          headers.Authorization = `Bearer ${authToken}`;
        }
        const form = new FormData();
        form.append("file", file);
        const response = await fetch(`${baseUrl}/api/homebrew/import-pdf`, { method: "POST", headers, body: form });
        const payload = await response.json();
        if (!response.ok) {
          const error = new Error(payload.error || `Request failed: ${response.status}`);
          error.code = payload.code;
          error.status = response.status;
          throw error;
        }
        return payload;
      }
      return request("/api/homebrew/import-pdf", {
        method: "POST",
        body: JSON.stringify({ text })
      });
    },
    // Persist reviewed candidates as custom content (Opus 1's storage endpoint).
    async saveCustomContent(items) {
      return request("/api/homebrew/custom", {
        method: "POST",
        body: JSON.stringify({ items })
      });
    }
  };
}
