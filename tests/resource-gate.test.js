import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cookResourceStatus,
  assertCookResources,
  withCookSlot,
  gateEnabled,
  formatCookStatus
} from "../server/ai/resourceGate.js";

// Floors are read at CALL time (not import time), so each test drives them via env
// and restores after. The system-RAM floor is measurable on ANY machine (incl. CI
// with no nvidia-smi), so it is the deterministic lever for forcing a block.
function withEnv(vars, fn) {
  const prior = {};
  for (const k of Object.keys(vars)) prior[k] = process.env[k];
  Object.assign(process.env, Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, String(v)])));
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    for (const k of Object.keys(vars)) {
      if (prior[k] === undefined) delete process.env[k];
      else process.env[k] = prior[k];
    }
  };
  try {
    const r = fn();
    // Async fn: restore AFTER the promise settles (else env reverts before the
    // awaited body runs — the gate would see the default floor, not the test's).
    if (r && typeof r.then === "function") return r.finally(restore);
    restore();
    return r;
  } catch (e) {
    restore();
    throw e;
  }
}

test("cookResourceStatus reports a measurable, shaped verdict", () => {
  const s = cookResourceStatus();
  assert.equal(typeof s.ok, "boolean");
  assert.equal(typeof s.freeRamMb, "number");
  assert.ok(s.freeRamMb > 0, "system RAM is always measurable");
  assert.equal(typeof s.desktopSharesCard, "boolean");
  assert.ok(typeof formatCookStatus(s) === "string");
});

test("a RAM floor above available RAM BLOCKS with a classified, retryable error", () => {
  withEnv({ NOTDND_COOK_RESOURCE_GATE: "true", NOTDND_COOK_RAM_FLOOR_MB: 9_000_000, NOTDND_COOK_VRAM_FLOOR_MB: 0 }, () => {
    const s = cookResourceStatus();
    assert.equal(s.ok, false);
    assert.match(s.reason, /system RAM/);
    let threw = null;
    try {
      assertCookResources("test-cook");
    } catch (e) {
      threw = e;
    }
    assert.ok(threw, "assertCookResources must throw when starving");
    assert.equal(threw.code, "RESOURCE_GATE_BLOCKED");
    assert.equal(threw.retryable, true);
    assert.ok(threw.status && threw.status.reason);
  });
});

test("sane floors PASS (the machine running the suite has headroom)", () => {
  withEnv({ NOTDND_COOK_RESOURCE_GATE: "true", NOTDND_COOK_RAM_FLOOR_MB: 1, NOTDND_COOK_VRAM_FLOOR_MB: 0 }, () => {
    assert.equal(cookResourceStatus().ok, true);
    assert.doesNotThrow(() => assertCookResources("test-cook"));
  });
});

test("disabling the gate is a hard NO-OP (dedicated render box / harness)", () => {
  withEnv({ NOTDND_COOK_RESOURCE_GATE: "false", NOTDND_COOK_RAM_FLOOR_MB: 9_000_000 }, () => {
    assert.equal(gateEnabled(), false);
    // Even with an impossible floor, a disabled gate never throws and runs the fn.
    assert.deepEqual(assertCookResources("x"), { ok: true, reason: "", disabled: true });
  });
});

test("withCookSlot serialises cooks — no two overlap (one GPU, one render)", async () => {
  await withEnv({ NOTDND_COOK_RESOURCE_GATE: "true", NOTDND_COOK_RAM_FLOOR_MB: 1, NOTDND_COOK_VRAM_FLOOR_MB: 0, NOTDND_COOK_COOLDOWN_MS: 0 }, async () => {
    let active = 0;
    let maxActive = 0;
    const order = [];
    const job = (label) => async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 15));
      order.push(label);
      active -= 1;
      return label;
    };
    const results = await Promise.all([
      withCookSlot("a", job("a")),
      withCookSlot("b", job("b")),
      withCookSlot("c", job("c"))
    ]);
    assert.equal(maxActive, 1, "cooks must never run concurrently");
    assert.deepEqual(results, ["a", "b", "c"]);
    assert.deepEqual(order, ["a", "b", "c"], "FIFO serialisation");
  });
});

test("withCookSlot throws (does not run fn) when the gate blocks after slot acquire", async () => {
  await withEnv({ NOTDND_COOK_RESOURCE_GATE: "true", NOTDND_COOK_RAM_FLOOR_MB: 9_000_000, NOTDND_COOK_VRAM_FLOOR_MB: 0, NOTDND_COOK_COOLDOWN_MS: 0 }, async () => {
    let ran = false;
    let threw = null;
    try {
      await withCookSlot("blocked", async () => {
        ran = true;
        return "should-not-run";
      });
    } catch (e) {
      threw = e;
    }
    assert.equal(ran, false, "the cook fn must not run when the machine is starving");
    assert.ok(threw && threw.code === "RESOURCE_GATE_BLOCKED");
  });
});

test("a rejected cook does not poison the slot chain for the next caller", async () => {
  await withEnv({ NOTDND_COOK_RESOURCE_GATE: "true", NOTDND_COOK_RAM_FLOOR_MB: 1, NOTDND_COOK_VRAM_FLOOR_MB: 0, NOTDND_COOK_COOLDOWN_MS: 0 }, async () => {
    const first = withCookSlot("boom", async () => {
      throw new Error("cook failed");
    }).catch((e) => e.message);
    const second = withCookSlot("ok", async () => "recovered");
    assert.equal(await first, "cook failed");
    assert.equal(await second, "recovered", "the chain survives a prior rejection");
  });
});
