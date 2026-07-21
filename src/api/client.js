const TOKEN_STORAGE_KEY = "notdnd_auth_token_v1";
// Cap how long any JSON API request may hang before it rejects (self-healing UI).
const DEFAULT_REQUEST_TIMEOUT_MS = 25_000;

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

    // Hard client-side timeout: a hung request (server connected but never
    // responding) would otherwise leave the caller awaiting forever — so
    // runAction's finally never runs and the action input stays disabled. The
    // AbortController makes such a request REJECT instead, so the UI re-enables
    // and the loop self-heals regardless of server/LLM behavior.
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_REQUEST_TIMEOUT_MS;
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer =
      controller && timeoutMs > 0 && typeof setTimeout === "function"
        ? setTimeout(() => controller.abort(), timeoutMs)
        : null;

    try {
      const response = await fetch(`${baseUrl}${path}`, {
        ...options,
        headers,
        ...(controller ? { signal: controller.signal } : {})
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
    } catch (error) {
      if (error && error.name === "AbortError") {
        const timeoutError = new Error("The request timed out. The server did not respond, please try again.");
        timeoutError.code = "TIMEOUT";
        throw timeoutError;
      }
      throw error;
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
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
    async debugStatus() {
      // Short timeout: the debug panel polls this and must never hang the poll
      // loop if the server is mid-restart.
      return request("/api/debug/status", { timeoutMs: 4000 });
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
    async guest() {
      // Guest play: mints an anonymous, fully playable identity. The returned
      // token is stored exactly like a login token; registering later upgrades
      // the same user in place, so a guest's runs survive account creation.
      const response = await request("/api/auth/guest", {
        method: "POST",
        body: JSON.stringify({})
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
    async roadmap() {
      // Public roadmap rows (owner-editable data file, no auth). Absent file →
      // { ok, items: [] } so the caller hides the panel cleanly.
      return request("/api/roadmap");
    },
    async listSoloRuns() {
      return request("/api/solo/runs");
    },
    async deleteSoloRun(runId) {
      return request(`/api/solo/runs/${encodeURIComponent(runId)}`, {
        method: "DELETE"
      });
    },
    async renameSoloRun(runId, title) {
      return request(`/api/solo/runs/${encodeURIComponent(runId)}/rename`, {
        method: "POST",
        body: JSON.stringify({ title })
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
      // GM-bound like the action call — the ambient scene narration can hit the
      // same slow model/fallback path, so give it the same headroom (was 25s).
      return request(`/api/solo/runs/${encodeURIComponent(runId)}/gm-scene${query}`, { timeoutMs: 90000 });
    },
    async postSoloAction(runId, action, turnId = null) {
      return request(`/api/solo/runs/${encodeURIComponent(runId)}/actions`, {
        method: "POST",
        // turnId (input integrity): a client-stamped id the server uses to make a
        // resubmission idempotent (no re-roll, no double-commit). Omitted → today's
        // behavior. Sent alongside `action` so the server body shape is additive.
        body: JSON.stringify(turnId ? { action, turnId } : { action }),
        // A GM turn is legitimately slow: the server's own backstop is ~65s
        // (GM_LOCAL_TIMEOUT_MS + 5s) and a cloud→local fallback hop adds more, plus
        // the attempt interpreter runs BEFORE narration. The old 25s default aborted
        // these still-working turns client-side; the turn had already COMMITTED
        // server-side, so the view froze on the pre-action state and the player
        // appeared "thrown back" to an earlier turn. Give the action call headroom
        // above the server ceiling so a slow-but-working turn is never abandoned.
        timeoutMs: 120000
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
    // Onboarding "I'll upload my own" portrait: the file IS the portrait — the
    // server writes it into the draft layout and NO generation fires on this
    // path. Multipart (no manual Content-Type; the browser sets the boundary).
    async uploadDraftPortrait(file) {
      const headers = {};
      if (authToken) {
        headers.Authorization = `Bearer ${authToken}`;
      }
      const form = new FormData();
      form.append("file", file);
      const response = await fetch(`${baseUrl}/api/onboarding/portrait/upload`, { method: "POST", headers, body: form });
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
    async createWorldRun({ world, character, draftPortraitId = null, mode = "sandbox", scenarioId = null, userWorldId = null }) {
      // mode: "sandbox" (open world, no authored spine — the default) or
      // "campaign" (guided adventure: main quest, job offers, a destination).
      // The server honors payload.mode; absent still means sandbox (index.js).
      // scenarioId: an authored world-book (e.g. "babel") — the server loads it as
      // the SOLE source of setting truth. Requires a non-sandbox mode (the loader
      // ignores a scenario for a sandbox run), so callers force mode:"campaign".
      // userWorldId: an owner-scoped Custom World — same loader, same campaign gate.
      return request("/api/onboarding/world-run", {
        method: "POST",
        body: JSON.stringify({ world, character, draftPortraitId, mode, scenarioId, userWorldId })
      });
    },
    // ── Custom World creator ─────────────────────────────────────────────────
    async listWorlds() {
      return request("/api/worlds");
    },
    async draftWorld({ creationId, interview }) {
      return request("/api/worlds/draft", { method: "POST", body: JSON.stringify({ creationId, interview }) });
    },
    async twistWorldCard({ creationId, cardType, card, instruction, context }) {
      return request("/api/worlds/twist", { method: "POST", body: JSON.stringify({ creationId, cardType, card, instruction, context }) });
    },
    async saveWorld({ creationId, draft, interview, overrides }) {
      return request("/api/worlds/save", { method: "POST", body: JSON.stringify({ creationId, draft, interview, overrides }) });
    },
    async deleteWorld(worldId) {
      return request(`/api/worlds/${encodeURIComponent(worldId)}`, { method: "DELETE" });
    },
    // Mid-creation portrait: request generation (server returns a draftId) and
    // poll it. No run exists yet.
    async requestDraftPortrait({ character, world, nonce, supersedes, appearance, avoid }) {
      // nonce MUST be forwarded: the server derives the draft cache id + seed from
      // it, so a Redo (which bumps the nonce) needs it to bypass the cache and
      // produce a genuinely new image. Dropping it made Redo return the same image.
      // T8: appearance/avoid preference slots ride to the sealed builder (additive).
      return request("/api/onboarding/portrait", {
        method: "POST",
        body: JSON.stringify({ character, world, nonce, supersedes, appearance, avoid })
      });
    },
    async getDraftPortrait(draftId) {
      return request(`/api/onboarding/portrait/${encodeURIComponent(draftId)}`);
    },
    // Conversational portrait editor: apply one tweak to the CURRENT portrait
    // (sourceImageUrl). nonce bumps per edit so each version gets a fresh draftId.
    // Returns { draftId, status, consistentEdit, entitlement } — same poll as a
    // generation. status "quota_reached" when the daily image quota is spent.
    async editDraftPortrait({ character, world, instruction, sourceImageUrl, nonce, supersedes }) {
      return request("/api/onboarding/portrait/edit", {
        method: "POST",
        body: JSON.stringify({ character, world, instruction, sourceImageUrl, nonce, supersedes })
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
