function summarizeCampaign(state, campaignId) {
  const campaign = (state.campaigns || []).find((entry) => entry.id === campaignId) || null;
  const packageData = state.campaignPackagesByCampaign?.[campaignId] || {
    scenes: [],
    npcs: [],
    items: [],
    rules: []
  };
  const recentChat = (state.chatLog || []).filter((line) => line.campaignId === campaignId).slice(-6);
  const journals = state.journalsByCampaign?.[campaignId] || [];

  return {
    campaign,
    packageData,
    recentChat,
    journals,
    mapCount: (state.maps || []).filter((entry) => entry.campaignId === campaignId).length,
    encounterCount: (state.encounters || []).filter((entry) => entry.campaignId === campaignId).length,
    characterCount: (state.characters || []).filter((entry) => entry.campaignId === campaignId).length
  };
}

function renderMemorySnippets(snippets = []) {
  if (!snippets.length) {
    return "No matching memory snippets.";
  }

  return snippets
    .map((snippet, idx) => `${idx + 1}. [${snippet.docKey} > ${snippet.heading}] ${snippet.text}`)
    .join("\n");
}

export function buildHumanGmAssistPrompt({ state, campaignId, message, memorySnippets = [] }) {
  const snapshot = summarizeCampaign(state, campaignId);
  return [
    "You are a concise tabletop GM copilot helping a human game master run the session better.",
    "Return practical advice, rulings support, pacing tips, and one strong next move.",
    `Campaign: ${snapshot.campaign?.name || campaignId}`,
    `Setting: ${snapshot.campaign?.setting || "Unknown"}`,
    `Maps: ${snapshot.mapCount} | Encounters: ${snapshot.encounterCount} | Characters: ${snapshot.characterCount}`,
    `Prepared scenes: ${(snapshot.packageData.scenes || []).map((scene) => scene.name).slice(0, 4).join(", ") || "None"}`,
    `Prepared NPCs: ${(snapshot.packageData.npcs || []).map((npc) => npc.name).slice(0, 5).join(", ") || "None"}`,
    `Prepared rules: ${(snapshot.packageData.rules || []).map((rule) => rule.name).slice(0, 5).join(", ") || "None"}`,
    `Recent chat: ${snapshot.recentChat.map((line) => `${line.speaker}: ${line.text}`).join(" | ") || "None"}`,
    `Recent journals: ${snapshot.journals.slice(0, 3).map((entry) => `${entry.title}: ${entry.body}`).join(" | ") || "None"}`,
    `Memory snippets:\n${renderMemorySnippets(memorySnippets)}`,
    `Human GM request: ${message}`
  ].join("\n\n");
}

export function buildAgentGmPrompt({ state, campaignId, message, memorySnippets = [] }) {
  const snapshot = summarizeCampaign(state, campaignId);
  return [
    "You are the acting game master for a live tabletop session.",
    "Respond in-world, be decisive, preserve continuity, and surface one concrete consequence or decision point.",
    "Use the provided memory snippets first. Do not assume context outside the snippets and campaign summary.",
    `Campaign: ${snapshot.campaign?.name || campaignId}`,
    `Setting: ${snapshot.campaign?.setting || "Unknown"}`,
    `Prepared scenes: ${(snapshot.packageData.scenes || []).map((scene) => `${scene.name} (${scene.objective})`).slice(0, 4).join(" | ") || "None"}`,
    `Prepared NPCs: ${(snapshot.packageData.npcs || []).map((npc) => `${npc.name}=${npc.role}`).slice(0, 6).join(" | ") || "None"}`,
    `Prepared items: ${(snapshot.packageData.items || []).map((item) => item.name).slice(0, 6).join(", ") || "None"}`,
    `Prepared rules: ${(snapshot.packageData.rules || []).map((rule) => rule.name).slice(0, 6).join(", ") || "None"}`,
    `Recent chat: ${snapshot.recentChat.map((line) => `${line.speaker}: ${line.text}`).join(" | ") || "None"}`,
    `Memory snippets:\n${renderMemorySnippets(memorySnippets)}`,
    `Player input: ${message}`
  ].join("\n\n");
}

export function buildFallbackHumanAdvice({ state, campaignId, message, memorySnippets = [] }) {
  const snapshot = summarizeCampaign(state, campaignId);
  const primaryScene = snapshot.packageData.scenes?.[0];
  const primaryNpc = snapshot.packageData.npcs?.[0];
  const snippetLead = memorySnippets[0];
  return [
    `Human GM Assist: focus the next beat around ${primaryScene?.name || "the current scene"}.`,
    snippetLead ? `Relevant memory: ${snippetLead.heading} -> ${snippetLead.text.slice(0, 120)}` : "No strong memory match found, so stay with the current objective.",
    `Surface ${primaryNpc?.name || "the lead NPC"} as the voice of urgency.`,
    `Best next move: ask the table one sharp question tied to "${message}" and resolve it immediately.`
  ].join(" ");
}
