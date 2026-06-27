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
// SIGKILL) is restarted.
import { spawn } from "node:child_process";

let child = null;
let shuttingDown = false;

function start() {
  child = spawn(process.execPath, ["server/index.js"], { stdio: "inherit" });
  child.on("exit", (code, signal) => {
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
