import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  confirmPasswordReset,
  initializeDatabase,
  loginUser,
  registerUser,
  requestPasswordReset,
  resetDatabase
} from "../server/db/repository.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "notdnd-reset-tests-"));
process.env.NOTDND_DB_PATH = path.join(tmpDir, "reset.db.json");

// Runs `fn` with console.log captured, returns the concatenated log output.
function captureLog(fn) {
  let logged = "";
  const original = console.log;
  console.log = (...args) => {
    logged += args.map(String).join(" ");
  };
  try {
    fn();
  } finally {
    console.log = original;
  }
  return logged;
}

test("requestPasswordReset logs a 6-digit code; confirm changes the password (single-use)", () => {
  initializeDatabase();
  resetDatabase();
  registerUser({ email: "reset@example.com", password: "OldPassword1", displayName: "Reset" });

  const logged = captureLog(() => {
    const result = requestPasswordReset({ email: "reset@example.com" });
    assert.equal(result.ok, true);
  });
  const code = (logged.match(/\b(\d{6})\b/) || [])[1];
  assert.ok(code, "a 6-digit reset code is logged to the console");

  // A wrong code (different length) is rejected without changing the password.
  assert.throws(
    () => confirmPasswordReset({ email: "reset@example.com", token: `${code}9`, newPassword: "NewPassword1" }),
    /Invalid or expired/
  );

  // A too-short new password is rejected without consuming the code.
  assert.throws(
    () => confirmPasswordReset({ email: "reset@example.com", token: code, newPassword: "short" }),
    /at least 8 characters/
  );

  // The correct code changes the password.
  assert.equal(confirmPasswordReset({ email: "reset@example.com", token: code, newPassword: "NewPassword1" }).ok, true);

  // Old password no longer works; the new one does.
  assert.throws(() => loginUser({ email: "reset@example.com", password: "OldPassword1" }), /Invalid email or password/);
  assert.ok(loginUser({ email: "reset@example.com", password: "NewPassword1" }).token);

  // The code is single-use: re-confirming with it fails (it was cleared).
  assert.throws(
    () => confirmPasswordReset({ email: "reset@example.com", token: code, newPassword: "Another12345" }),
    /Invalid or expired/
  );
});

test("requestPasswordReset is enumeration-safe and confirm rejects emails with no issued code", () => {
  initializeDatabase();
  resetDatabase();

  // Unknown email: still returns ok (does not reveal whether the account exists)
  // and logs nothing.
  let logged = "";
  logged = captureLog(() => {
    assert.equal(requestPasswordReset({ email: "nobody@example.com" }).ok, true);
  });
  assert.equal(logged, "", "no code is logged for an unknown email");

  // Confirm for an account with no outstanding code fails.
  assert.throws(
    () => confirmPasswordReset({ email: "nobody@example.com", token: "123456", newPassword: "Whatever12" }),
    /Invalid or expired/
  );

  // A registered user who never requested a reset also cannot confirm.
  registerUser({ email: "noreset@example.com", password: "Password123", displayName: "NR" });
  assert.throws(
    () => confirmPasswordReset({ email: "noreset@example.com", token: "123456", newPassword: "Password999" }),
    /Invalid or expired/
  );
});
