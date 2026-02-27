import assert from "node:assert/strict";
import test from "node:test";
import { handleQuickstartBuildPayload, handleQuickstartParsePayload } from "../server/api/quickstartRoutes.js";

test("parse route payload returns parser output", () => {
  const response = handleQuickstartParsePayload(
    { files: [{ name: "a.md", content: "# A" }] },
    {
      parseHomebrewDocuments(files) {
        return { summary: { documents: files.length } };
      }
    }
  );

  assert.deepEqual(response, { parsed: { summary: { documents: 1 } } });
});

test("build route parses files when parsed payload is missing", () => {
  let parseCalled = false;
  const response = handleQuickstartBuildPayload(
    {
      campaignName: "Quick",
      setting: "Setting",
      players: ["A"],
      files: [{ name: "a.md", content: "# A" }]
    },
    {
      parseHomebrewDocuments() {
        parseCalled = true;
        return { books: [], entities: { classes: [], monsters: [], spells: [], npcs: [], locations: [] }, summary: { documents: 1 } };
      },
      createQuickstartCampaignFromParsed() {
        return { campaignId: "cmp_x", mapId: "map_x", encounterId: "enc_x", parsedSummary: { documents: 1 } };
      },
      getState() {
        return { selectedCampaignId: "cmp_x" };
      }
    }
  );

  assert.equal(parseCalled, true);
  assert.equal(response.launch.campaignId, "cmp_x");
  assert.equal(response.launch.tab, "vtt");
  assert.equal(response.state.selectedCampaignId, "cmp_x");
});

test("build route uses supplied parsed payload when provided", () => {
  let parseCalled = false;
  const parsed = {
    books: [{ title: "B" }],
    entities: { classes: [], monsters: [], spells: [], npcs: [], locations: [] },
    summary: { documents: 1 }
  };

  const response = handleQuickstartBuildPayload(
    {
      campaignName: "Quick",
      setting: "Setting",
      players: ["A"],
      parsed
    },
    {
      parseHomebrewDocuments() {
        parseCalled = true;
        return { summary: { documents: 99 } };
      },
      createQuickstartCampaignFromParsed({ parsed: incoming }) {
        assert.deepEqual(incoming, parsed);
        return { campaignId: "cmp_y", mapId: "map_y", encounterId: "enc_y", parsedSummary: { documents: 1 } };
      },
      getState() {
        return { selectedCampaignId: "cmp_y" };
      }
    }
  );

  assert.equal(parseCalled, false);
  assert.equal(response.launch.campaignId, "cmp_y");
});
