// INPUT INTEGRITY — client turn lifecycle (draft survival, resync-safe resubmit,
// failed-turn surfacing, queue-one-deep, stall visibility) + the founding
// regression (20s stall + resync with a pending turn → resolves or surfaces,
// never vanishes). String-based per the shell's test idiom; the async flow is
// driven through a mounted shell with a mock apiClient.
import assert from "node:assert/strict";
import test from "node:test";
import {
  firstWordsLabel,
  stallElapsedLabel,
  newSoloTurnId,
  soloComposerDraftKey,
  renderSoloTurnLifecycle,
  renderSoloThinkingIndicator,
  readSoloThemePref,
  writeSoloThemePref,
  mountSoloSceneShell,
  SOLO_STALL_ELAPSED_THRESHOLD_MS
} from "../src/components/soloSceneShell.js";

// ── in-memory localStorage (draft survival + prefs read/write) ────────────────
class MemStorage {
  constructor() { this.store = new Map(); }
  getItem(k) { return this.store.has(k) ? this.store.get(k) : null; }
  setItem(k, v) { this.store.set(k, String(v)); }
  removeItem(k) { this.store.delete(k); }
}
globalThis.localStorage = new MemStorage();

function resetStorage() {
  globalThis.localStorage = new MemStorage();
}

// ── pure helpers ──────────────────────────────────────────────────────────────
test("firstWordsLabel: first six words, ellipsized, safe on empty", () => {
  assert.equal(firstWordsLabel("open the ancient iron door slowly and quietly now"), "open the ancient iron door slowly…");
  assert.equal(firstWordsLabel("say hello"), "say hello");
  assert.equal(firstWordsLabel("   "), "");
  assert.equal(firstWordsLabel(undefined), "");
});

test("stallElapsedLabel: seconds since start, guards bad input", () => {
  assert.equal(stallElapsedLabel(1000, 19000), "18s");
  assert.equal(stallElapsedLabel(1000, 1000), "0s");
  assert.equal(stallElapsedLabel(NaN, 5000), "");
  assert.equal(stallElapsedLabel(5000, 1000), "", "now-before-start yields nothing");
});

test("newSoloTurnId: unique per call and namespaced to the run", () => {
  const a = newSoloTurnId("run_abc");
  const b = newSoloTurnId("run_abc");
  assert.notEqual(a, b, "two turn ids are distinct");
  assert.match(a, /^turn_run_abc_/);
});

test("soloComposerDraftKey + read/write: a draft round-trips per run", () => {
  resetStorage();
  const key = soloComposerDraftKey("run_xyz");
  assert.equal(key, "notdnd.solo.draft.run_xyz");
  assert.equal(readSoloThemePref(key, ""), "", "empty by default");
  writeSoloThemePref(key, "search the ruins");
  assert.equal(readSoloThemePref(key, ""), "search the ruins", "persisted and read back");
});

test("renderSoloTurnLifecycle: a failed turn surfaces Retry + Discard with the action label", () => {
  const html = renderSoloTurnLifecycle({ pendingTurn: { status: "failed", text: "bribe the guard with my last coin" } });
  assert.match(html, /wasn't processed/);
  assert.match(html, /bribe the guard with my last…/);
  assert.match(html, /data-solo-turn-retry/);
  assert.match(html, /data-solo-turn-discard/);
});

test("renderSoloTurnLifecycle: a queued turn shows the one-deep chip; idle shows nothing", () => {
  assert.equal(renderSoloTurnLifecycle({}), "");
  const html = renderSoloTurnLifecycle({ queuedTurn: { text: "then run for the gate" } });
  assert.match(html, /Queued/);
  assert.match(html, /then run for the gate/);
});

test("renderSoloThinkingIndicator: elapsed counter appears only past the stall threshold", () => {
  const started = 1000;
  const base = { gmThinking: true, pendingTurn: { status: "processing", startedAt: started } };
  // Just after submit: plain thinking label, no counter.
  assert.match(renderSoloThinkingIndicator(base, started + 1000), /GM is thinking/);
  // Past the stall threshold: a live elapsed counter.
  const late = renderSoloThinkingIndicator(base, started + SOLO_STALL_ELAPSED_THRESHOLD_MS + 12000);
  assert.match(late, /Still working — \d+s/);
});

// ── mounted-shell flow ────────────────────────────────────────────────────────
function makeScene() {
  return {
    ok: true,
    runId: "run_test",
    edition: "mainline",
    policyProfileId: "mainline_default",
    location: {
      locationId: "start_location",
      name: "Start Location",
      description: "A neutral room.",
      state: {},
      tags: [],
      contentTags: []
    },
    visibleEntities: [],
    availableMoves: [],
    availableActions: [],
    quests: {},
    player: { name: "Bram", inventory: [] },
    narration: ""
  };
}

function makeRoot() {
  return {
    innerHTML: "",
    _l: {},
    addEventListener(name, handler) { this._l[name] = handler; },
    querySelector() { return null; },   // force the full-render path (no fast-path)
    querySelectorAll() { return []; }
  };
}

// A mock apiClient whose postSoloAction behavior is scripted per-call. Records every
// (runId, action, turnId) so a resync resubmit's turnId can be asserted identical.
function makeApiClient(postImpl) {
  const calls = [];
  return {
    calls,
    async fetchSoloScene() { return makeScene(); },
    async fetchSoloGmScene() { return { ok: true, scene: makeScene(), gmNarration: null, gmStatus: null, errors: [] }; },
    async postSoloAction(runId, action, turnId) {
      calls.push({ runId, action, turnId });
      return postImpl(calls.length, { runId, action, turnId });
    }
  };
}

async function tick(n = 3) {
  for (let i = 0; i < n; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

// The delegated handler set the shell publishes on its root (bindSoloSceneShell).
function handlersOf(root) {
  return root.__soloHandlers || {};
}

test("DRAFT SURVIVAL (loss path e): a keystroke persists; a fresh mount restores it", async () => {
  resetStorage();
  const api = makeApiClient(() => ({ ok: true }));
  const root1 = makeRoot();
  const mounted = mountSoloSceneShell(root1, { apiClient: api, runId: "run_draft" });
  await mounted.reload();
  // Simulate typing (the composer input event handler).
  handlersOf(root1).onAttemptDraft({ value: "search the crumbling altar" });
  assert.equal(readSoloThemePref(soloComposerDraftKey("run_draft"), ""), "search the crumbling altar", "draft persisted on keystroke");

  // A fresh mount for the same run restores the draft into the composer.
  const root2 = makeRoot();
  const mounted2 = mountSoloSceneShell(root2, { apiClient: makeApiClient(() => ({ ok: true })), runId: "run_draft" });
  await mounted2.reload();
  assert.match(root2.innerHTML, /search the crumbling altar/, "the persisted draft is restored after a refresh");
});

test("RESYNC-SAFE RESUBMIT (loss paths a/c/d): a thrown turn resubmits the SAME turnId", async () => {
  resetStorage();
  // First post throws (as if the connection dropped mid-flight); the retry succeeds.
  const api = makeApiClient((n) => {
    if (n === 1) { throw new Error("network dropped"); }
    return { ok: true, turnId: "server-echo", attemptResult: { checkResult: { total: 14 }, band: "success" } };
  });
  const root = makeRoot();
  const mounted = mountSoloSceneShell(root, { apiClient: api, runId: "run_resync" });
  await mounted.reload();
  const handlers = handlersOf(root);
  await handlers.onAttempt({ intent: "force the rusted gate", mode: "action" });
  await tick();
  assert.equal(api.calls.length, 2, "the thrown turn was resubmitted exactly once");
  assert.equal(api.calls[0].turnId, api.calls[1].turnId, "the resubmit reuses the SAME turnId (server-idempotent, no double-commit)");
  assert.ok(api.calls[0].turnId, "a client turnId was stamped");
});

test("FAILED-TURN SURFACING (loss path a, unrecoverable): both attempts fail → Retry/Discard, draft kept, never vanishes", async () => {
  resetStorage();
  const api = makeApiClient(() => { throw new Error("server unreachable"); });
  const root = makeRoot();
  const mounted = mountSoloSceneShell(root, { apiClient: api, runId: "run_failed" });
  await mounted.reload();
  const handlers = handlersOf(root);
  await handlers.onAttempt({ intent: "call out to the watchman", mode: "action" });
  await tick();
  assert.equal(api.calls.length, 2, "the turn was tried and retried (never silently dropped)");
  assert.match(root.innerHTML, /wasn't processed/, "the failed turn is SURFACED, not lost");
  assert.match(root.innerHTML, /data-solo-turn-retry/, "a Retry affordance is offered");
  assert.match(root.innerHTML, /data-solo-turn-discard/, "Discard is offered — a player choice only");
  assert.match(root.innerHTML, /call out to the watchman/, "the player's exact text is preserved (in the surface and the box)");

  // Retry reuses the SAME turnId; if the server recovers, the turn resolves.
  const failedTurnId = api.calls[1].turnId;
  handlers.onTurnRetry();
  await tick();
  assert.ok(api.calls.length >= 3, "Retry resubmits");
  assert.equal(api.calls[2].turnId, failedTurnId, "Retry reuses the failed turn's turnId (idempotent, no re-roll on the server)");
});

test("QUEUE, DON'T SWALLOW (loss path b): a turn typed while one is processing queues one-deep", async () => {
  resetStorage();
  let releaseFirst;
  const api = makeApiClient((n) => {
    if (n === 1) {
      // Hold the first turn open so the second submit lands while busy.
      return new Promise((resolve) => { releaseFirst = () => resolve({ ok: true, attemptResult: null }); });
    }
    return { ok: true, attemptResult: null };
  });
  const root = makeRoot();
  const mounted = mountSoloSceneShell(root, { apiClient: api, runId: "run_queue" });
  await mounted.reload();
  const handlers = handlersOf(root);
  handlers.onAttempt({ intent: "draw my blade", mode: "action" });   // first turn — held open
  await tick(1);
  handlers.onAttempt({ intent: "and charge the ogre", mode: "action" }); // typed while busy
  await tick(1);
  assert.match(root.innerHTML, /Queued/, "the second turn is QUEUED, not swallowed");
  assert.match(root.innerHTML, /and charge the ogre/, "the queued text is visible");
  assert.equal(api.calls.length, 1, "only the first turn is in flight so far");
  // Releasing the first turn flushes the queued one.
  releaseFirst();
  await tick(4);
  assert.equal(api.calls.length, 2, "the queued turn auto-sends once the first settles");
  assert.equal(api.calls[1].action.intent, "and charge the ogre", "the queued action is the one that was held");
});

test("FOUNDING REGRESSION: 20s stall + resync with a pending turn → turn RESOLVES, never vanishes", async () => {
  resetStorage();
  // The founding class-e case: the client gives up on a slow turn (throw), but the
  // server ALREADY committed it. The resync resubmit (same turnId) returns the
  // server's idempotent replay — the turn resolves, it does not disappear.
  const api = makeApiClient((n) => {
    if (n === 1) {
      // 20s stall then the client abandons the request.
      throw Object.assign(new Error("The request timed out — the server did not respond."), { code: "TIMEOUT" });
    }
    // The resubmit hits the server, which finds the turnId already committed.
    return { ok: true, turnId: "commit-1", idempotentReplay: true, alreadyProcessed: true };
  });
  const root = makeRoot();
  const mounted = mountSoloSceneShell(root, { apiClient: api, runId: "run_founding" });
  await mounted.reload();
  const handlers = handlersOf(root);
  await handlers.onAttempt({ intent: "descend into the flooded vault", mode: "action" });
  await tick(4);
  assert.equal(api.calls.length, 2, "the abandoned turn was resubmitted (resync-safe), not dropped");
  assert.equal(api.calls[0].turnId, api.calls[1].turnId, "same turnId → the server replays its commit rather than re-rolling");
  // The turn did NOT vanish: it neither left a stuck 'failed' surface nor lost the
  // pending state silently — the idempotent replay resynced the committed scene.
  assert.doesNotMatch(root.innerHTML, /wasn't processed/, "an idempotent replay resolves the turn (no false failure surface)");
});
