export function createApiClient(baseUrl = "") {
  async function request(path, options = {}) {
    const response = await fetch(`${baseUrl}${path}`, {
      headers: {
        "Content-Type": "application/json"
      },
      ...options
    });

    const payload = await response.json();
    if (!response.ok || payload.ok === false) {
      throw new Error(payload.error || `Request failed: ${response.status}`);
    }
    return payload;
  }

  return {
    async health() {
      return request("/api/health");
    },
    async getState() {
      return request("/api/state");
    },
    async applyOperation(op, payload = {}) {
      return request("/api/ops", {
        method: "POST",
        body: JSON.stringify({ op, payload })
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
    }
  };
}
