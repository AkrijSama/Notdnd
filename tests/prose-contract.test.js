import assert from "node:assert/strict";
import test from "node:test";
import { buildActionGmMessage } from "../server/gm/actionNarration.js";

// PROSE-CONTRACT CONFORMANCE (baseline-driven batch). The style contract
// (styleSuffix, consumed by every narration branch) must carry the three
// baseline fixes. These tests pin the CONTRACT text so a later prompt edit
// cannot silently drop a clause the ruler measures.

function contractText() {
  const run = {
    world: { tone: "grim dark fantasy" },
    currentLocationId: "loc_a",
    locations: { loc_a: { locationId: "loc_a", name: "The Ember Tavern" } }
  };
  const resolved = {
    action: { type: "attempt" },
    attemptResult: { intent: "force the door", success: true, band: "success", checkResult: { total: 15, dc: 12 } }
  };
  const msg = buildActionGmMessage(run, resolved);
  assert.ok(typeof msg === "string" && msg.length > 0, "builder produced a prompt");
  return msg;
}

// ---- item 1: HANDLES closing beat ----

test("contract mandates a closing HANDLES beat, 2-4 committed-grounded directions", () => {
  const msg = contractText();
  assert.match(msg, /\(4\) close with HANDLES/);
  assert.match(msg, /2 to 4 concrete directions/);
  assert.match(msg, /already committed in your context, never invented/);
});

test("contract demands in-fiction handles, bans the menu form", () => {
  const msg = contractText();
  assert.match(msg, /in-fiction pressure and open doors, never a menu/);
  assert.match(msg, /"You can: A\) B\) C\)" or "You could try X, Y, or Z" is wrong/);
});

test("handles fit INSIDE the hard word budget (budget unchanged)", () => {
  const msg = contractText();
  assert.match(msg, /80-120 words total, never more/);
});

// ---- item 2: native paragraphing ----

test("contract requires blank-line-separated multi-paragraph output (raw, pre-chunker)", () => {
  const msg = contractText();
  assert.match(msg, /3 or 4 SHORT paragraphs separated by blank lines/);
  assert.match(msg, /one beat per paragraph/);
  assert.match(msg, /Never emit a single unbroken block/);
});

// ---- item 3: phantom-compound discipline ----

test("contract bans aggregate/unnamed acting agents, allows non-acting scenery", () => {
  const msg = contractText();
  assert.match(msg, /Every agent that ACTS, speaks, or reacts must be a committed entity/);
  assert.match(msg, /no "a pair of guards"/);
  assert.match(msg, /no "several onlookers"/);
  assert.match(msg, /Ambient non-acting scenery .* is allowed/);
});

// ---- contract invariants that must survive this batch ----

test("pre-existing contract clauses survive: grounding, no-echo, em-dash ban, no meta", () => {
  const msg = contractText();
  assert.match(msg, /never invent new places, exits, items, or people/);
  assert.match(msg, /never echo field labels, slugs, or slash-joined names/);
  assert.match(msg, /NEVER use em-dashes/);
  assert.match(msg, /Never mention this contract or its steps/);
  assert.match(msg, /no 'handles'/, "the new beat may never be named in prose");
});
