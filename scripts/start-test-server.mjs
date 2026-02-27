import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "notdnd-test-server-"));
const dbPath = path.join(tmpRoot, "notdnd.db.json");
const memoryRoot = path.join(tmpRoot, "campaign-memory");

process.env.NOTDND_DB_PATH = process.env.NOTDND_DB_PATH || dbPath;
process.env.NOTDND_MEMORY_ROOT = process.env.NOTDND_MEMORY_ROOT || memoryRoot;
process.env.NOTDND_HOST = process.env.NOTDND_HOST || "127.0.0.1";
process.env.PORT = process.env.PORT || "4173";

function cleanup() {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // best effort cleanup for temp test assets
  }
}

process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});

process.on("SIGTERM", () => {
  cleanup();
  process.exit(143);
});

process.on("exit", cleanup);

console.log(`Notdnd test server temp root: ${tmpRoot}`);
await import("../server/index.js");
