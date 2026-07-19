// One-time user-data hygiene migration (2026-07-18). Tags existing harness-born
// users with origin:"harness" and purges the known diagnostic account. Prints the
// classification report.
//
// RUN ON A COORDINATED RESTART (server stopped) so the live process can't overwrite
// the write:  stop server → `node scripts/user-hygiene.mjs` → start server.
// Idempotent: re-running only tags newly-harness rows; the purge is a no-op once
// the account is gone. ZERO model calls.
import { tagHarnessUsers, purgeUser } from "../server/db/repository.js";

const DIAGNOSTIC_ACCOUNT = process.argv[2] || "usr_mrr0ypbo_lh7qh8w";

const applied = tagHarnessUsers({ apply: true });
console.log(`[hygiene] classification: ${JSON.stringify(applied.counts)}`);
console.log(`[hygiene] newly tagged origin=harness: ${applied.tagged}`);

const purge = purgeUser(DIAGNOSTIC_ACCOUNT);
console.log(`[hygiene] purged ${DIAGNOSTIC_ACCOUNT}: user=${purge.removedUser} sessions=${purge.removedSessions}`);
console.log("[hygiene] done.");
