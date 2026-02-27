import { parseHomebrewDocuments } from "../homebrew/parser.js";
import { createQuickstartCampaignFromParsed, getState } from "../db/repository.js";

export function handleQuickstartParsePayload(payload = {}, deps = {}) {
  const parseFn = deps.parseHomebrewDocuments || parseHomebrewDocuments;
  const files = Array.isArray(payload.files) ? payload.files : [];
  const parsed = parseFn(files);
  return { parsed };
}

export function handleQuickstartBuildPayload(payload = {}, deps = {}) {
  const parseFn = deps.parseHomebrewDocuments || parseHomebrewDocuments;
  const buildFn = deps.createQuickstartCampaignFromParsed || createQuickstartCampaignFromParsed;
  const stateFn = deps.getState || getState;

  const files = Array.isArray(payload.files) ? payload.files : [];
  const parsed = payload.parsed && typeof payload.parsed === "object" ? payload.parsed : parseFn(files);
  const players = Array.isArray(payload.players) ? payload.players : [];

  const launch = buildFn({
    campaignName: payload.campaignName,
    setting: payload.setting,
    players,
    parsed
  });

  return {
    parsed,
    launch: {
      ...launch,
      tab: "vtt"
    },
    state: stateFn()
  };
}
