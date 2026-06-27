import {
  OFFICIAL_BOOKS,
  STARTER_CAMPAIGNS,
  STARTER_CHARACTERS,
  STARTER_ENCOUNTERS,
  STARTER_MAP,
  STARTER_TOKENS
} from "../data/placeholders.js";
import { clamp, safeJsonParse, uid } from "../utils/helpers.js";

const STORAGE_KEY = "notdnd_state_v1";

function seedState() {
  return {
    campaigns: [...STARTER_CAMPAIGNS],
    selectedCampaignId: STARTER_CAMPAIGNS[0]?.id || null,
    books: [...OFFICIAL_BOOKS],
    characters: [...STARTER_CHARACTERS],
    encounters: [...STARTER_ENCOUNTERS],
    maps: [STARTER_MAP],
    tokensByMap: {
      [STARTER_MAP.id]: [...STARTER_TOKENS]
    },
    initiative: [
      { id: uid("init"), name: "Thorn", value: 18 },
      { id: uid("init"), name: "Asha", value: 15 },
      { id: uid("init"), name: "Ash Goblin", value: 13 }
    ],
    chatLog: [
      { id: uid("chat"), speaker: "GM", text: "The ash gate cracks open as drums echo from below." }
    ],
    aiJobs: [],
    campaignPackagesByCampaign: {},
    gmSettings: {
      gmName: "Narrator Prime",
      gmStyle: "Cinematic Tactical",
      safetyProfile: "Table-Friendly",
      primaryRulebook: "Core Rules SRD",
      gmMode: "human",
      agentProvider: "local",
      agentModel: "local-gm-v1"
    },
    aiProviders: [],
    gmMemoryDocsByCampaign: {},
    gmMemorySearchResults: [],
    gmLastResponseMeta: null,
    gmRuntimeStatus: "",
    stateVersion: 0,
    campaignVersions: {},
    auth: {
      user: null
    }
  };
}

function loadState() {
  // Guarded: privacy browsers / blocked-storage contexts throw a SecurityError
  // on localStorage access. This runs at module load, so an unguarded throw
  // blanks the app — fall back to a fresh seed state (cached state just isn't
  // restored).
  let raw = null;
  try {
    if (typeof localStorage !== "undefined") {
      raw = localStorage.getItem(STORAGE_KEY);
    }
  } catch {
    return seedState();
  }
  if (!raw) {
    return seedState();
  }

  const parsed = safeJsonParse(raw, null);
  if (!parsed || typeof parsed !== "object") {
    return seedState();
  }

  return {
    ...seedState(),
    ...parsed
  };
}

function persist(state) {
  // Best-effort; no-op when storage is unavailable or throws (privacy/blocked).
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    }
  } catch {
    // Ignore — the in-memory state remains the source of truth this session.
  }
}

export function createStore({ apiClient = null } = {}) {
  let state = loadState();
  const subscribers = new Set();

  function notify() {
    persist(state);
    subscribers.forEach((fn) => fn(state));
  }

  async function syncOperation(op, payload = {}) {
    if (!apiClient) {
      return null;
    }

    try {
      const response = await apiClient.applyOperation(op, payload, state.stateVersion);
      if (response?.state) {
        state = {
          ...state,
          ...response.state
        };
        notify();
      }
      return response;
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(`Failed to sync op ${op}:`, error);
      await hydrateFromServer();
      return null;
    }
  }

  async function syncOperationWithResult(op, payload = {}) {
    if (!apiClient) {
      return null;
    }

    const response = await apiClient.applyOperation(op, payload, state.stateVersion);
    if (response?.state) {
      state = {
        ...state,
        ...response.state
      };
      notify();
    }
    return response?.result || null;
  }

  async function hydrateFromServer() {
    if (!apiClient) {
      return;
    }
    try {
      const response = await apiClient.getState();
      if (response?.state) {
        state = {
          ...state,
          ...response.state
        };
        notify();
      }
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error("Failed to hydrate from server:", error);
      if (error?.code === "UNAUTHORIZED" || error?.status === 401) {
        state = {
          ...state,
          auth: {
            user: null
          }
        };
        notify();
      }
    }
  }

  async function loadAiProviders() {
    if (!apiClient) {
      return [];
    }
    const response = await apiClient.listAiProviders();
    state = {
      ...state,
      aiProviders: response.providers || []
    };
    notify();
    return state.aiProviders;
  }

  async function loadGmMemoryDocs(campaignId = state.selectedCampaignId) {
    if (!apiClient || !campaignId) {
      return [];
    }
    const response = await apiClient.getGmMemory(campaignId);
    const docs = response.entities || response.docs || [];
    state = {
      ...state,
      gmMemoryDocsByCampaign: {
        ...state.gmMemoryDocsByCampaign,
        [campaignId]: docs
      }
    };
    notify();
    return docs;
  }

  async function saveGmMemoryDoc({ campaignId = state.selectedCampaignId, docKey, content }) {
    if (!apiClient || !campaignId) {
      throw new Error("API client is required for GM memory");
    }
    const response = await apiClient.saveGmMemory({ campaignId, docKey, content });
    const saved = response.entity || response.doc;
    const docs = (state.gmMemoryDocsByCampaign[campaignId] || []).filter((entry) => entry.name !== saved?.name);
    state = {
      ...state,
      gmMemoryDocsByCampaign: {
        ...state.gmMemoryDocsByCampaign,
        [campaignId]: [saved, ...docs].sort((left, right) =>
          String(left.name || left.title || "").localeCompare(String(right.name || right.title || ""))
        )
      }
    };
    notify();
    return saved;
  }

  async function searchGmMemory({ campaignId = state.selectedCampaignId, query, docKey = null, limit = 5 }) {
    if (!apiClient || !campaignId) {
      throw new Error("API client is required for GM memory search");
    }
    const response = await apiClient.searchGmMemory({ campaignId, query, docKey, limit });
    state = {
      ...state,
      gmMemorySearchResults: response.results || []
    };
    notify();
    return response.results || [];
  }

  async function requestGmResponse({ campaignId = state.selectedCampaignId, message, mode, provider, model, stream }) {
    if (!apiClient || !campaignId) {
      throw new Error("API client is required for GM responses");
    }
    const response = await apiClient.respondAsGm({ campaignId, message, mode, provider, model, stream });
    state = {
      ...state,
      gmLastResponseMeta: {
        mode: mode || "session",
        memoryUpdates: response.memoryUpdates || [],
        rolls: response.mechanical?.rolls || []
      }
    };
    notify();
    await hydrateFromServer();
    return response;
  }

  async function startOnboarding({ characterName, archetype, backstorySnippet }) {
    if (!apiClient) {
      throw new Error("API client is required for onboarding.");
    }

    const response = await apiClient.startOnboarding({
      characterName,
      archetype,
      backstorySnippet
    });

    await hydrateFromServer();

    if (response?.campaignId) {
      state = {
        ...state,
        selectedCampaignId: response.campaignId
      };
      notify();
      await loadGmMemoryDocs(response.campaignId);
    }

    return response;
  }

  async function previewWorld(definition = {}) {
    if (!apiClient) {
      throw new Error("API client is required for world generation.");
    }
    return apiClient.previewWorld(definition);
  }

  async function regenerateWorldField({ definition = {}, field, salt } = {}) {
    if (!apiClient) {
      throw new Error("API client is required for world generation.");
    }
    return apiClient.regenerateWorldField({ definition, field, salt });
  }

  async function createWorldRun({ world = {}, character = {}, draftPortraitId = null } = {}) {
    if (!apiClient) {
      throw new Error("API client is required for world onboarding.");
    }
    return apiClient.createWorldRun({ world, character, draftPortraitId });
  }

  return {
    getState() {
      return state;
    },
    subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
    async bootstrapRemote() {
      await hydrateFromServer();
      await loadAiProviders();
      if (state.selectedCampaignId) {
        await loadGmMemoryDocs(state.selectedCampaignId);
      }
    },
    async refreshFromServer() {
      await hydrateFromServer();
    },
    applyAuthoritativeState(nextState) {
      if (!nextState || typeof nextState !== "object") {
        return;
      }
      state = {
        ...state,
        ...nextState
      };
      notify();
    },
    async buildQuickstartCampaign({ campaignName, setting, players, files, parsed }) {
      if (!apiClient) {
        throw new Error("API client is required for quickstart build");
      }

      const response = await apiClient.buildQuickstartCampaign({
        campaignName,
        setting,
        players,
        files,
        parsed,
        expectedVersion: state.stateVersion
      });

      if (response?.state) {
        state = {
          ...state,
          ...response.state
        };
        notify();
      }

      return response;
    },
    async parseQuickstartFiles({ files }) {
      if (!apiClient) {
        throw new Error("API client is required for quickstart parse");
      }
      return apiClient.parseQuickstartFiles({ files });
    },
    async importHomebrewFromUrl(url) {
      if (!apiClient) {
        throw new Error("API client is required for url import");
      }
      return apiClient.importHomebrewFromUrl(url);
    },
    clearAuth() {
      state = {
        ...state,
        auth: {
          user: null
        }
      };
      notify();
    },
    resetAll() {
      state = seedState();
      notify();
      syncOperation("reset_all");
    },
    setGmRuntimeStatus(message) {
      state = {
        ...state,
        gmRuntimeStatus: String(message || "")
      };
      notify();
    },
    async deleteCampaign(campaignId) {
      if (!apiClient) {
        throw new Error("API client is required to delete a campaign.");
      }
      const response = await apiClient.deleteCampaign(campaignId);
      if (response?.state) {
        state = {
          ...state,
          ...response.state
        };
      } else {
        await hydrateFromServer();
      }
      notify();
      return response;
    },
    setSelectedCampaign(campaignId) {
      state = { ...state, selectedCampaignId: campaignId };
      notify();
      syncOperation("select_campaign", { campaignId });
      loadGmMemoryDocs(campaignId);
    },
    createCampaign({ name, setting, bookIds, players }) {
      const id = uid("cmp");
      const campaign = {
        id,
        name,
        setting,
        status: "Prep",
        readiness: 35,
        sessionCount: 0,
        players,
        sourceBooks: bookIds
      };

      state = {
        ...state,
        campaigns: [campaign, ...state.campaigns],
        selectedCampaignId: id
      };
      notify();

      syncOperation("create_campaign", {
        ...campaign,
        sourceBooks: campaign.sourceBooks
      });

      return campaign;
    },
    incrementCampaignReadiness(campaignId, amount) {
      state = {
        ...state,
        campaigns: state.campaigns.map((campaign) =>
          campaign.id === campaignId
            ? { ...campaign, readiness: clamp((campaign.readiness || 0) + amount, 0, 100) }
            : campaign
        )
      };
      notify();
      syncOperation("increment_campaign_readiness", { campaignId, amount });
    },
    addBook({ title, type, tags, chapters }) {
      const book = {
        id: uid("book"),
        title,
        type,
        tags,
        chapters
      };

      state = {
        ...state,
        books: [book, ...state.books]
      };
      notify();

      syncOperation("add_book", book);
      return book;
    },
    addCharacter(character) {
      const nextCharacter = {
        id: uid("char"),
        ...character
      };

      state = {
        ...state,
        characters: [nextCharacter, ...state.characters]
      };
      notify();
      syncOperation("add_character", {
        ...nextCharacter,
        campaignId: state.selectedCampaignId
      });

      return nextCharacter;
    },
    addEncounter(encounter) {
      const nextEncounter = {
        id: uid("enc"),
        ...encounter
      };

      state = {
        ...state,
        encounters: [nextEncounter, ...state.encounters]
      };
      notify();
      syncOperation("add_encounter", {
        ...nextEncounter,
        campaignId: state.selectedCampaignId
      });

      return nextEncounter;
    },
    addInitiativeTurn(turn) {
      const nextTurn = {
        id: uid("init"),
        ...turn
      };

      state = {
        ...state,
        initiative: [...state.initiative, nextTurn]
      };
      notify();
      syncOperation("add_initiative_turn", {
        ...nextTurn,
        campaignId: state.selectedCampaignId
      });

      return nextTurn;
    },
    setTokenPosition(mapId, tokenId, x, y) {
      const tokens = state.tokensByMap[mapId] || [];
      state = {
        ...state,
        tokensByMap: {
          ...state.tokensByMap,
          [mapId]: tokens.map((token) => (token.id === tokenId ? { ...token, x, y } : token))
        }
      };
      notify();
      syncOperation("set_token_position", { mapId, tokenId, x, y, campaignId: state.selectedCampaignId });
    },
    pushChatLine({ speaker, text }) {
      const line = { id: uid("chat"), speaker, text };
      state = {
        ...state,
        chatLog: [...state.chatLog, line]
      };
      notify();
      syncOperation("push_chat_line", {
        ...line,
        campaignId: state.selectedCampaignId
      });
    },
    queueAiJob({ type, prompt, providerName, modelValue }) {
      const job = {
        id: uid("job"),
        type,
        prompt,
        status: "Queued",
        providerName,
        modelValue,
        createdAt: Date.now()
      };
      state = {
        ...state,
        aiJobs: [job, ...state.aiJobs]
      };
      notify();
      syncOperation("queue_ai_job", {
        ...job,
        campaignId: state.selectedCampaignId
      });
      return job;
    },
    setAiJobStatus(jobId, status) {
      state = {
        ...state,
        aiJobs: state.aiJobs.map((job) => (job.id === jobId ? { ...job, status } : job))
      };
      notify();
      syncOperation("set_ai_job_status", {
        jobId,
        status,
        campaignId: state.selectedCampaignId
      });
    },
    setGmSettings(settings) {
      state = {
        ...state,
        gmSettings: {
          ...state.gmSettings,
          ...settings
        }
      };
      notify();
      syncOperation("set_gm_settings", {
        campaignId: state.selectedCampaignId,
        ...state.gmSettings,
        ...settings
      });
    },
    async loadAiProviders() {
      return loadAiProviders();
    },
    async loadGmMemoryDocs(campaignId = state.selectedCampaignId) {
      return loadGmMemoryDocs(campaignId);
    },
    async saveGmMemoryDoc({ campaignId = state.selectedCampaignId, docKey, content }) {
      return saveGmMemoryDoc({ campaignId, docKey, content });
    },
    async searchGmMemory({ campaignId = state.selectedCampaignId, query, docKey = null, limit = 5 }) {
      return searchGmMemory({ campaignId, query, docKey, limit });
    },
    async requestGmResponse({ campaignId = state.selectedCampaignId, message, mode, provider, model, stream }) {
      return requestGmResponse({ campaignId, message, mode, provider, model, stream });
    },
    async startOnboarding({ characterName, archetype, backstorySnippet }) {
      return startOnboarding({ characterName, archetype, backstorySnippet });
    },
    async previewWorld(definition) {
      return previewWorld(definition);
    },
    async regenerateWorldField(payload) {
      return regenerateWorldField(payload);
    },
    async createWorldRun(payload) {
      return createWorldRun(payload);
    },
    async rollDice({ expression, label, actor }) {
      return syncOperationWithResult("roll_dice", {
        campaignId: state.selectedCampaignId,
        expression,
        label,
        actor
      });
    },
    async resolveAttack({ attacker, target, attackExpression, targetAc, damageExpression, damageType }) {
      return syncOperationWithResult("resolve_attack", {
        campaignId: state.selectedCampaignId,
        attacker,
        target,
        attackExpression,
        targetAc,
        damageExpression,
        damageType
      });
    },
    async resolveSkillCheck({ expression, dc, label, actor }) {
      return syncOperationWithResult("resolve_skill_check", {
        campaignId: state.selectedCampaignId,
        expression,
        dc,
        label,
        actor
      });
    },
    async addJournalEntry({ title, body, tags, visibility }) {
      return syncOperationWithResult("add_journal_entry", {
        campaignId: state.selectedCampaignId,
        title,
        body,
        tags,
        visibility
      });
    },
    async updateJournalEntry({ entryId, title, body, tags, visibility }) {
      return syncOperationWithResult("update_journal_entry", {
        campaignId: state.selectedCampaignId,
        entryId,
        title,
        body,
        tags,
        visibility
      });
    },
    async toggleFogCell({ mapId, x, y, revealed }) {
      return syncOperationWithResult("toggle_fog_cell", {
        campaignId: state.selectedCampaignId,
        mapId,
        x,
        y,
        revealed
      });
    },
    async upsertMap({ id, name, width, height, fogEnabled, dynamicLighting, imageUrl }) {
      return syncOperationWithResult("upsert_map", {
        campaignId: state.selectedCampaignId,
        id,
        name,
        width,
        height,
        fogEnabled,
        dynamicLighting,
        imageUrl
      });
    },
    async setActiveMap(mapId) {
      return syncOperationWithResult("set_active_map", {
        campaignId: state.selectedCampaignId,
        mapId
      });
    }
  };
}
