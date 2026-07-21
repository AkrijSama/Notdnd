// U3 — TYPED INPUT IS FIRST-CLASS. A typed turn is sent as a freeform `attempt`, and a
// conversation aimed at an absent/invalid target ("talk to the wolf" — a beast that can't
// answer, or someone who left) must NEVER hard-reject the turn (the "not processed"
// banner). The pure-conversation path now DEGRADES to a soft, unanswered VN turn instead
// of returning ok:false. (Speech-path is internal → the invariant is asserted at source.)
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const src = fs.readFileSync(path.resolve("server/solo/actions.js"), "utf8");
const client = fs.readFileSync(path.resolve("src/components/soloSceneShell.js"), "utf8");

test("typed input is submitted as a freeform attempt (not a structured, rejectable action)", () => {
  assert.match(client, /type:\s*"attempt"/, "a typed turn posts as an attempt");
});

test("a conversation to an invalid/absent target degrades to a soft turn, never a hard reject", () => {
  const pure = src.slice(src.indexOf("PURE CONVERSATION"));
  const block = pure.slice(0, pure.indexOf("\n}"));
  // on talk-reject it does NOT return the ok:false result; it returns a soft ok:true turn
  assert.match(block, /TYPED INPUT IS FIRST-CLASS/, "the first-class degrade is wired");
  assert.match(block, /ok:\s*true/, "degrades to a committed turn");
  assert.match(block, /unanswered:\s*true/, "the words are surfaced unanswered, not rejected");
});
