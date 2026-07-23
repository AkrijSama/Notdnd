// ROBUST HEADLESS-CHROME CLEANUP for the door harnesses (JOB 0.2 — the zombie leak).
//
// THE LEAK: the harnesses run under a `timeout N ...` wrapper. At N seconds `timeout` SIGTERMs
// the node driver. A try/finally `chrome.kill()` does NOT run on a signal — SIGTERM terminates
// node without unwinding — so the headless browser was orphaned and survived forever, each
// pinning a swiftshader gpu-process at ~40% CPU (1.5-2h zombies). This makes cleanup survive
// being killed, two independent ways so a single mechanism failing can't leak:
//
//   (a) SIGNAL TRAP — SIGTERM/SIGINT/exit handlers kill chrome + remove its user-data-dir. This
//       directly covers the described mechanism (the timeout wrapper's default SIGTERM), plus
//       ctrl-C and any normal/early exit. This alone fixes the leak the dispatch describes.
//   (b) REAP-ON-START — a sidecar records (nodePid, chromePid, dir). On the NEXT harness start we
//       reap any recorded chrome whose node DRIVER is dead (orphaned) — the backstop for a hard,
//       untrappable SIGKILL (pre-mortem a). Concurrency-SAFE: a still-running harness's node is
//       alive, so its chrome is kept, never reaped by a sibling.
import fs from "node:fs";

const SIDECAR = "/tmp/notdnd-harness-browsers.tsv"; // shared across harness runs

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

// Reap any browser recorded by a prior run whose node driver has died (orphaned). Rewrites the
// sidecar to keep only entries whose driver is still alive (concurrent runs).
function reapOrphans() {
  let lines;
  try { lines = fs.readFileSync(SIDECAR, "utf8").split("\n").filter(Boolean); } catch { return; }
  const survivors = [];
  for (const line of lines) {
    const [nodePid, chromePid, dir] = line.split("\t");
    const np = Number(nodePid), cp = Number(chromePid);
    if (Number.isInteger(np) && isAlive(np)) { survivors.push(line); continue; } // driver alive → keep
    if (Number.isInteger(cp)) { try { process.kill(cp, "SIGKILL"); } catch { /* already gone */ } }
    if (dir && dir.startsWith("/tmp/")) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ } }
  }
  try { if (survivors.length) fs.writeFileSync(SIDECAR, survivors.join("\n") + "\n"); else fs.rmSync(SIDECAR, { force: true }); } catch { /* best-effort */ }
}

/**
 * Guard a spawned headless-Chrome so it never outlives this process. Call once, right after spawn.
 * @param {import("node:child_process").ChildProcess} chrome
 * @param {string} userDataDir the browser's --user-data-dir (removed on cleanup)
 * @returns {() => void} the idempotent cleanup (also safe to call from a finally)
 */
export function guardBrowser(chrome, userDataDir) {
  reapOrphans(); // (b) clean any prior hard-killed orphan BEFORE this run adds its own record
  try { fs.appendFileSync(SIDECAR, `${process.pid}\t${chrome.pid}\t${userDataDir}\n`); } catch { /* best-effort */ }
  let done = false;
  const cleanup = () => {
    if (done) return;
    done = true;
    try { chrome.kill("SIGKILL"); } catch { /* gone */ }
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* gone */ }
    // drop THIS run's sidecar line (leave any concurrent siblings')
    try {
      const rest = fs.readFileSync(SIDECAR, "utf8").split("\n").filter((l) => l && !l.startsWith(`${process.pid}\t`));
      if (rest.length) fs.writeFileSync(SIDECAR, rest.join("\n") + "\n"); else fs.rmSync(SIDECAR, { force: true });
    } catch { /* best-effort */ }
  };
  // (a) survive being killed: the timeout wrapper's SIGTERM, ctrl-C, and any exit.
  process.once("SIGTERM", () => { cleanup(); process.exit(143); });
  process.once("SIGINT", () => { cleanup(); process.exit(130); });
  process.once("exit", cleanup);
  return cleanup;
}
