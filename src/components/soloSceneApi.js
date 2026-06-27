export function requireRunId(runId) {
  const value = String(runId || "").trim();
  if (!value) {
    throw new Error("Solo run id is required.");
  }
  return value;
}

export async function fetchSoloScene(apiClient, runId) {
  if (!apiClient || typeof apiClient.fetchSoloScene !== "function") {
    throw new Error("API client with fetchSoloScene is required.");
  }
  return apiClient.fetchSoloScene(requireRunId(runId));
}

export async function fetchSoloGmScene(apiClient, runId, options = {}) {
  if (!apiClient || typeof apiClient.fetchSoloGmScene !== "function") {
    throw new Error("API client with fetchSoloGmScene is required.");
  }
  return apiClient.fetchSoloGmScene(requireRunId(runId), options);
}

export async function postSoloAction(apiClient, runId, action) {
  if (!apiClient || typeof apiClient.postSoloAction !== "function") {
    throw new Error("API client with postSoloAction is required.");
  }
  return apiClient.postSoloAction(requireRunId(runId), action);
}

// Best-effort persistence of battle-map token positions (Phase 2). Never throws
// to the caller — a failed save just means positions reset on next reload.
export async function saveSoloBattleMap(apiClient, runId, battleMap) {
  if (!apiClient || typeof apiClient.saveSoloBattleMap !== "function") {
    return null;
  }
  try {
    return await apiClient.saveSoloBattleMap(requireRunId(runId), battleMap);
  } catch {
    return null;
  }
}

// Regenerates the current location's background image (fresh seed). Throws on
// failure (e.g. 409 when locked) so the caller can surface it.
export async function redoLocationImage(apiClient, runId) {
  if (!apiClient || typeof apiClient.redoLocationImage !== "function") {
    throw new Error("API client with redoLocationImage is required.");
  }
  return apiClient.redoLocationImage(requireRunId(runId));
}

// Locks the current location's image so it is final (no more Redo/Save).
export async function saveLocationImage(apiClient, runId) {
  if (!apiClient || typeof apiClient.saveLocationImage !== "function") {
    throw new Error("API client with saveLocationImage is required.");
  }
  return apiClient.saveLocationImage(requireRunId(runId));
}

// Concludes a run (death / voluntary exit) and returns its summary. Best-effort:
// returns null on failure so navigation/UI is never blocked by a failed close.
export async function completeSoloRun(apiClient, runId, outcome) {
  if (!apiClient || typeof apiClient.completeSoloRun !== "function") {
    return null;
  }
  try {
    return await apiClient.completeSoloRun(requireRunId(runId), outcome || "completed");
  } catch {
    return null;
  }
}
