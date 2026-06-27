// Minimal process supervisor for NON-container deploys (bare metal / a host with
// no orchestrator restart policy). Spawns `node server/index.js` and respawns it
// after a 1s backoff if it dies unexpectedly, so players never hit a dead server.
//
// Container/Fly deploys do NOT use this — they run `node server/index.js`
// directly and rely on the orchestrator's restart policy (docker-compose
// `restart: always`, Fly machine restart). package.json "start" points here.
//
// ESM (the repo is "type":"module", so a `require`-based wrapper would throw
// "require is not defined"). We forward SIGTERM/SIGINT to the child and only
// suppress the respawn when WE initiated shutdown — so a clean orchestrator stop
// exits cleanly, while a crash (non-zero exit) OR an external kill (e.g. OOM
// SIGKILL) is restarted. EADDRINUSE is the exception: respawning never frees a
// port held by another process, so we fast-fail instead of looping forever.
import { spawn } from "node:child_process";

let child = null;
let shuttingDown = false;
// Last 500 chars of the child's stderr, so we can detect an unrecoverable
// EADDRINUSE before deciding whether to respawn.
let stderrTail = "";

function start() {
  stderrTail = "";
  // stdout inherited (the [SERVER]/[DB] startup logs reach the terminal
  // directly); stderr piped so we can scan it for EADDRINUSE — while still
  // passing it through to the terminal so the operator sees errors unchanged.
  child = spawn(process.execPath, ["server/index.js"], { stdio: ["inherit", "inherit", "pipe"] });
  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
    stderrTail = (stderrTail + chunk.toString("utf8")).slice(-500);
  });
  // "close" (not "exit") so all piped stderr has been flushed before we decide.
  child.on("close", (code, signal) => {
    if (shuttingDown) {
      // We asked it to stop — mirror its exit and don't respawn.
      process.exit(typeof code === "number" ? code : 0);
      return;
    }
    if (code === 0) {
      // Clean self-exit (not a crash) — nothing left to supervise.
      process.exit(0);
      return;
    }
    // Unrecoverable port conflict: another process holds the port, so respawning
    // would just loop [DB] -> EADDRINUSE -> restart forever, never binding.
    if (code === 1 && stderrTail.includes("EADDRINUSE")) {
      console.error("[FATAL] Port already in use. Kill the existing process and restart.");
      process.exit(1);
      return;
    }
    // Crash (non-zero code) or external kill (signal) the supervisor did not
    // request — bring the server back.
    const reason = signal ? `killed by ${signal}` : `exited ${code}`;
    console.log(`[restart] ${reason}, restarting in 1s...`);
    setTimeout(start, 1000);
  });
}

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    shuttingDown = true;
    if (child && !child.killed) {
      child.kill(sig);
    }
  });
}

start();
