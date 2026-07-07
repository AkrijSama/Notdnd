import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "notdnd-guest-"));
process.env.NOTDND_DB_PATH = path.join(tmpDir, "guest.db.json");
process.env.NOTDND_MEMORY_ROOT = path.join(tmpDir, "campaigns");
process.env.NOTDND_WORLD_PROVIDER = "placeholder";
process.env.NOTDND_NPC_IDENTITY_PROVIDER = "placeholder";
process.env.NOTDND_MOCK_IMAGE = "true";
process.env.NOTDND_MOCK_OPENROUTER = "true";

const {
  initializeDatabase,
  resetDatabase,
  createGuestUser,
  upgradeGuestUser,
  registerUser,
  loginUser,
  getUserBySessionToken,
  listSoloRunsForUser
} = await import("../server/db/repository.js");
const { createWorldOnboardingRun } = await import("../server/campaign/onboarding.js");
const { canStartSession, canGenerateImage, TIER_LIMITS } = await import("../server/auth/entitlements.js");

const CHAR = {
  name: "Stray",
  race: "Human",
  characterClass: "Rogue",
  background: "Urchin",
  baseAbilityScores: { strength: 10, dexterity: 12, constitution: 10, intelligence: 10, wisdom: 10, charisma: 10 }
};

function fresh() {
  initializeDatabase();
  resetDatabase();
}

// ── DEFECT 13: a stranger can play WITHOUT an account ───────────────────────
test("createGuestUser mints a playable identity: real id, session token, isGuest", () => {
  fresh();
  const result = createGuestUser();
  assert.ok(result.user.id, "guest has a real stable user id");
  assert.equal(result.user.isGuest, true, "flagged as guest");
  assert.equal(result.user.email, null, "no email — nothing was asked of the player");
  assert.ok(result.token, "session token issued");
  const resolved = getUserBySessionToken(result.token);
  assert.equal(resolved.id, result.user.id, "the token authenticates as the guest");
  assert.equal(resolved.isGuest, true, "sanitized user carries isGuest (routes/entitlements read it)");
});

test("a guest can start the Babel run and receives the VOICE opening", async () => {
  fresh();
  const guest = createGuestUser();
  const result = await createWorldOnboardingRun(guest.user.id, {
    world: { tone: "dark fantasy" },
    character: CHAR,
    mode: "campaign",
    scenarioId: "babel"
  });
  assert.ok(result.runId, "run created");
  const runs = listSoloRunsForUser(guest.user.id);
  assert.equal(runs.length, 1, "the run belongs to the guest");
  const run = runs[0];
  assert.ok(Array.isArray(run.openingBeats) && run.openingBeats.length > 0, "authored opening beats present");
  const opening = run.openingBeats.join(" ");
  assert.match(opening, /HOLLOW PINE/i, "the VOICE names the road to Hollow Pine");
});

// ── The critical guarantee: saving does NOT lose the run ────────────────────
test("upgradeGuestUser promotes IN PLACE: same id, run retained, login works", async () => {
  fresh();
  const guest = createGuestUser();
  const created = await createWorldOnboardingRun(guest.user.id, {
    world: { tone: "dark fantasy" },
    character: CHAR,
    mode: "campaign",
    scenarioId: "babel"
  });

  const upgraded = upgradeGuestUser(guest.user.id, {
    email: "kept@notdnd.local",
    password: "password123",
    displayName: "Keeper"
  });
  assert.equal(upgraded.user.id, guest.user.id, "SAME user id — nothing to migrate");
  assert.equal(upgraded.user.isGuest, false, "no longer a guest");
  assert.equal(upgraded.user.email, "kept@notdnd.local");

  // The adventure survived: same run, still owned, still resumable by id.
  const runs = listSoloRunsForUser(upgraded.user.id);
  assert.equal(runs.length, 1, "the guest's run is still theirs after registering");
  assert.equal(runs[0].runId, created.runId, "and it is the SAME run");

  // The new credentials genuinely work.
  const login = loginUser({ email: "kept@notdnd.local", password: "password123" });
  assert.equal(login.user.id, guest.user.id, "login lands on the promoted account");
});

test("upgrade validation mirrors register: bad email / short password / taken email / non-guest", async () => {
  fresh();
  const guest = createGuestUser();
  assert.throws(() => upgradeGuestUser(guest.user.id, { email: "nope", password: "password123" }), /email/i);
  assert.throws(() => upgradeGuestUser(guest.user.id, { email: "a@b.co", password: "short" }), /8 characters/i);
  registerUser({ email: "taken@notdnd.local", password: "password123", displayName: "T" });
  assert.throws(
    () => upgradeGuestUser(guest.user.id, { email: "taken@notdnd.local", password: "password123" }),
    /already registered/i
  );
  const real = registerUser({ email: "real@notdnd.local", password: "password123", displayName: "R" });
  assert.throws(
    () => upgradeGuestUser(real.user.id, { email: "x@y.co", password: "password123" }),
    /already registered/i,
    "a full account cannot be 'upgraded'"
  );
});

// ── Entitlements: guests are capped tighter than free accounts ───────────────
test("guest entitlements: stricter caps apply via the isGuest policy overlay", () => {
  fresh();
  const guest = createGuestUser();
  const session = canStartSession(guest.user);
  assert.equal(session.tier, "guest");
  assert.equal(session.limit, TIER_LIMITS.guest.sessions, "guest session cap applies");
  const image = canGenerateImage(guest.user);
  assert.equal(image.limit, TIER_LIMITS.guest.images, "guest image cap applies");

  const upgraded = upgradeGuestUser(guest.user.id, { email: "cap@notdnd.local", password: "password123" });
  const after = canStartSession(upgraded.user);
  assert.equal(after.tier, "free", "after saving, normal free-tier limits apply");
});
