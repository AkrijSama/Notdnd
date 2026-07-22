// GUARD (JOB 2.4): a hand-rolled fetch to an /api/ endpoint bypasses the authed wrapper
// (src/api/client.js) and 401s silently — the world-card divergence, and a CLASS. This
// test fails if any src/ file OTHER than the wrapper calls fetch() on an /api/ path.
//
// HONEST LIMITS: this is a textual scan. It catches the common form
// `fetch("/api/…")` / `fetch(\`/api/…\`)`. It does NOT catch: an aliased fetch
// (`const f = fetch; f("/api/…")`), a URL built elsewhere and passed in as a variable,
// or a non-fetch transport (the realtime WebSocket in src/realtime/client.js carries auth
// via setToken and is out of scope here). It is a tripwire for the obvious regression, not
// a proof of absence. A bare fetch to a STATIC path (e.g. /data/roadmap-public.json, no
// auth) is allowed — the bug is auth-bypass of API endpoints, not static-file reads.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const WRAPPER = path.join(SRC, "api", "client.js"); // the ONE place fetch() to /api/ is allowed

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else if (entry.isFile() && p.endsWith(".js")) out.push(p);
  }
  return out;
}

test("no src/ file except the api wrapper calls fetch() on an /api/ endpoint", () => {
  // fetch( ... "/api/..." ... ) with a string or template-literal URL argument.
  const RE = /\bfetch\(\s*[`"'][^`"')]*\/api\//g;
  const offenders = [];
  for (const file of walk(SRC)) {
    if (path.resolve(file) === path.resolve(WRAPPER)) continue;
    const text = fs.readFileSync(file, "utf8");
    text.split("\n").forEach((line, i) => {
      RE.lastIndex = 0;
      if (RE.test(line)) offenders.push(`${path.relative(SRC, file)}:${i + 1}  ${line.trim().slice(0, 120)}`);
    });
  }
  assert.deepEqual(offenders, [], "route these through the authed api client (src/api/client.js) instead of a bare fetch:\n" + offenders.join("\n"));
});
