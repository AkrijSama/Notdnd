// ═══════════════════════════════════════════════════════════════════════════
// THE WALL — art-path choke-point guard (owner ruling 2026-07-20: END the bug class).
//
// Every runtime image request flows through ONE pipeline:
//
//   route / worker job
//     → server/solo/imageWorker.js         (per-kind orchestration: prompt, seed, disk)
//       → server/ai/providers.js           generateImage / editImage  (provider policy)
//         → server/ai/comfyui.js           comfyuiImage: canonicalizeStyle →
//                                          sealPortraitPrompt (identity/monster/lane law)
//                                          → resolveValidatedComfyWorkflow (checkpoint)
//                                          → ComfyUI  (or pollinations/cloudflare)
//
// The bug class this ends (unsealed / wrong-lane / styleless / cross-style pixels) can
// ONLY recur by adding a NEW DOOR that reaches around this pipeline into the low-level
// generation primitives. This test greps the source tree for such a door: a new door
// FAILS THE SUITE BY EXISTING. That is the whole point — the choke-point is now enforced
// by construction, not by discipline.
//
// If you are here because this test failed: you added an import that bypasses the
// pipeline. Route your call through imageWorker (runtime) instead of importing the
// low-level module directly. If you genuinely need a new low-level consumer, that is an
// architecture change — add it to the allow-list HERE, in the same commit, with a reason.
// ═══════════════════════════════════════════════════════════════════════════
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Walk .js/.mjs under a dir, skipping node_modules + tests (the wall guards PRODUCTION
// wiring; tests legitimately import internals to assert on them).
function sourceFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (/\.(js|mjs)$/.test(entry.name) && !/\.test\.(js|mjs)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const ALL_SOURCES = [
  ...sourceFiles(path.join(repoRoot, "server")),
  ...sourceFiles(path.join(repoRoot, "src")),
  ...sourceFiles(path.join(repoRoot, "scripts"))
];

const rel = (f) => path.relative(repoRoot, f);

// A file "imports SYMBOL from MODULE" — matches a static import statement whose source
// path ends with MODULE and whose binding list includes SYMBOL. Import-based (not call-
// based) so code comments that merely mention a symbol never trip the wall.
function importsSymbolFrom(fileText, moduleBasename, symbol) {
  const re = new RegExp(
    `import\\s*\\{([^}]*)\\}\\s*from\\s*["'][^"']*${moduleBasename.replace(".", "\\.")}["']`,
    "g"
  );
  let m;
  while ((m = re.exec(fileText)) !== null) {
    const bindings = m[1].split(",").map((s) => s.trim().split(/\s+as\s+/)[0].trim());
    if (bindings.includes(symbol)) return true;
  }
  return false;
}

// ── RULE 1: the runtime image provider entry (providers.generateImage/editImage) is
// imported ONLY by the runtime worker. A route/module that imports it directly is a door.
test("WALL: only imageWorker imports the runtime image provider entry (generateImage/editImage)", () => {
  const ALLOWED = new Set(["server/solo/imageWorker.js"]);
  const offenders = [];
  for (const file of ALL_SOURCES) {
    const text = fs.readFileSync(file, "utf8");
    // Only care about imports from the RUNTIME providers module (ai/providers.js), NOT
    // the separate batch scripts/art/generate.mjs which owns its own generateImage.
    const fromRuntimeProviders = /from\s*["'][^"']*providers\.js["']/.test(text);
    if (!fromRuntimeProviders) continue;
    if (importsSymbolFrom(text, "providers.js", "generateImage") || importsSymbolFrom(text, "providers.js", "editImage")) {
      if (!ALLOWED.has(rel(file))) offenders.push(rel(file));
    }
  }
  assert.deepEqual(offenders, [], `New door(s) importing generateImage/editImage outside the pipeline: ${offenders.join(", ")}`);
});

// ── RULE 2: the sealed ComfyUI module (comfyui.js — seal + export resolution + the
// comfyuiImage provider) is imported ONLY by the provider policy layer (providers.js).
// Anything else reaching into it bypasses sealPortraitPrompt / resolveValidatedComfyWorkflow.
test("WALL: only providers.js imports the sealed comfyui module", () => {
  const ALLOWED = new Set(["server/ai/providers.js"]);
  const offenders = [];
  for (const file of ALL_SOURCES) {
    const text = fs.readFileSync(file, "utf8");
    if (/from\s*["'][^"']*comfyui\.js["']/.test(text)) {
      if (!ALLOWED.has(rel(file))) offenders.push(rel(file));
    }
  }
  assert.deepEqual(offenders, [], `New door(s) importing the sealed comfyui module directly: ${offenders.join(", ")}`);
});

// ── RULE 3: the seal + workflow-resolution primitives are DEFINED and used only inside
// comfyui.js. No other module may import them (importing = a parallel assembly path, the
// exact failure that produced the anime→Illustrious drift and the skull-demon lane).
test("WALL: seal + workflow-resolution primitives never imported outside comfyui.js", () => {
  const GUARDED = ["sealPortraitPrompt", "resolveValidatedComfyWorkflow", "comfyuiWorkflowForStyle", "defaultWorkflow"];
  const offenders = [];
  for (const file of ALL_SOURCES) {
    if (rel(file) === "server/ai/comfyui.js") continue;
    const text = fs.readFileSync(file, "utf8");
    for (const sym of GUARDED) {
      if (importsSymbolFrom(text, "comfyui.js", sym)) offenders.push(`${rel(file)}:${sym}`);
    }
  }
  assert.deepEqual(offenders, [], `Seal/resolution primitive imported outside comfyui.js: ${offenders.join(", ")}`);
});

// ── RULE 4: the choke-point files exist where the wall says they are (a rename that
// moved the pipeline without updating the wall would otherwise silently pass).
test("WALL: the choke-point modules exist at their guarded paths", () => {
  for (const f of ["server/solo/imageWorker.js", "server/ai/providers.js", "server/ai/comfyui.js"]) {
    assert.ok(fs.existsSync(path.join(repoRoot, f)), `choke-point module missing: ${f}`);
  }
});

// ── RULE 5 (topology): SEALED-OR-NOTHING. The provider fan-out for character/scene kinds
// must have exactly ONE live branch — the failover chain is DROPPED for sealed kinds. This
// catches a future RE-WIRING at the source level (behavior is also covered by
// sealed-or-nothing.test.js, but a topology guard fails the suite the moment the gate is
// deleted, before any behavioral path is even exercised). Asserts the gate is present in
// the failover-chain construction: sealed kinds → empty failover list.
test("WALL: the sealed-or-nothing gate exists in the provider fan-out (no fallback branch for sealed kinds)", () => {
  const providers = fs.readFileSync(path.join(repoRoot, "server/ai/providers.js"), "utf8");
  // The chain must be built from a failover list that is EMPTY when the kind is sealed.
  assert.match(providers, /SEALED_ONLY_KINDS/, "SEALED_ONLY_KINDS must gate the fan-out");
  assert.match(
    providers,
    /sealedOnly\s*\?\s*\[\s*\]/,
    "the failover list must be dropped (empty) for sealed kinds — deleting this gate re-opens the A6 fallback door"
  );
  // And the sealed set must actually name the identity/scene kinds.
  for (const k of ["portrait", "fullbody", "scene"]) {
    assert.match(providers, new RegExp(`["']${k}["']`), `SEALED_ONLY_KINDS must include ${k}`);
  }
});
