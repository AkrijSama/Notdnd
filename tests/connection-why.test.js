// U4 — CONNECTION FAILURE WHY. A failed turn submission carries a CLASSIFIED reason
// (timeout / unreachable / busy / server) + Retry, never a bare "not processed".
import test from "node:test";
import assert from "node:assert/strict";
import { classifyTurnFailure } from "../src/components/soloSceneShell.js";

test("turn-failure classification maps the error to an actionable reason", () => {
  assert.match(classifyTurnFailure({ message: "The operation was aborted due to timeout" }), /too long/i);
  assert.match(classifyTurnFailure({ message: "Failed to fetch" }), /connection/i);
  assert.match(classifyTurnFailure({ message: "NetworkError when attempting" }), /connection/i);
  assert.match(classifyTurnFailure({ status: 429 }), /busy/i);
  assert.match(classifyTurnFailure({ status: 503 }), /error/i);
  assert.match(classifyTurnFailure({}), /didn't reach the server/i);
  // no em-dash in any classified reason (player-facing ban)
  for (const e of [{message:"timeout"},{message:"network"},{status:429},{status:500},{}]) assert.doesNotMatch(classifyTurnFailure(e), /—/);
});
