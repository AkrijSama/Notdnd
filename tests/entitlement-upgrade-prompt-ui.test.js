import assert from "node:assert/strict";
import test from "node:test";
import { renderSoloUpgradePrompt } from "../src/components/soloSceneShell.js";

test("upgrade prompt: hidden when there is nothing to nudge", async (t) => {
  await t.test("no entitlement payload → no prompt", () => {
    assert.equal(renderSoloUpgradePrompt({}), "");
  });

  await t.test("free user with plenty of quota → no prompt", () => {
    const html = renderSoloUpgradePrompt({
      entitlement: { tier: "free", imageQuotaRemaining: 7, sessionLimitReached: false }
    });
    assert.equal(html, "");
  });

  await t.test("paid + BYOK users never see the prompt", () => {
    assert.equal(
      renderSoloUpgradePrompt({ entitlement: { tier: "adventurer", unlimited: true, imageQuotaRemaining: null } }),
      ""
    );
    assert.equal(
      renderSoloUpgradePrompt({ entitlement: { tier: "free", byok: true, imageQuotaRemaining: 0 } }),
      ""
    );
  });
});

test("upgrade prompt: soft nudge near/at the limit", async (t) => {
  await t.test("shows a low-quota nudge with the remaining count", () => {
    const html = renderSoloUpgradePrompt({
      entitlement: { tier: "free", imageQuotaRemaining: 2, sessionLimitReached: false }
    });
    assert.match(html, /Only 2 free images left today/);
    assert.match(html, /href="\/pricing"/);
    assert.match(html, /data-solo-upgrade-prompt/);
  });

  await t.test("singularizes a single remaining image", () => {
    const html = renderSoloUpgradePrompt({
      entitlement: { tier: "free", imageQuotaRemaining: 1, sessionLimitReached: false }
    });
    assert.match(html, /Only 1 free image left today/);
  });

  await t.test("shows the exhausted-images copy at zero", () => {
    const html = renderSoloUpgradePrompt({
      entitlement: { tier: "free", imageQuotaRemaining: 0, sessionLimitReached: false }
    });
    assert.match(html, /used your free images today/);
  });

  await t.test("session-cap message takes priority", () => {
    const html = renderSoloUpgradePrompt({
      entitlement: { tier: "free", imageQuotaRemaining: 0, sessionLimitReached: true }
    });
    assert.match(html, /free daily session limit/);
  });
});
