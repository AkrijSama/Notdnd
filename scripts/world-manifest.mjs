#!/usr/bin/env node
// WORLD-BOOK BILL OF MATERIALS — CLI.
//
//   node scripts/world-manifest.mjs babel            # printable manifest
//   node scripts/world-manifest.mjs babel --md       # owner-readable markdown
//   node scripts/world-manifest.mjs babel --json     # machine-readable
//   node scripts/world-manifest.mjs --all            # every scenario on disk
//
// "Authoring world #2 is form-filling, not archaeology" — this is the form's status page.
import fs from "node:fs";
import path from "node:path";
import { worldBookManifest, formatManifest, manifestMarkdown } from "../server/campaign/worldBookManifest.js";

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const ids = args.filter((a) => !a.startsWith("--"));

function scenarioIds() {
  const dir = path.resolve(process.cwd(), "server/campaign/scenarios");
  return fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => path.basename(f, ".json"));
}

const targets = flags.has("--all") ? scenarioIds() : ids.length ? ids : ["babel"];

let failed = false;
for (const id of targets) {
  let manifest;
  try {
    manifest = worldBookManifest(id);
  } catch (error) {
    console.error(`world-manifest: ${id}: ${error.message}`);
    failed = true;
    continue;
  }
  if (flags.has("--json")) console.log(JSON.stringify(manifest, null, 2));
  else if (flags.has("--md")) console.log(manifestMarkdown(manifest));
  else console.log(formatManifest(manifest));
  if (targets.length > 1) console.log("");
  // A violated {name,vibe}-plays law is a BUILD failure, not a note.
  if (!manifest.summary.lawHolds) {
    console.error(`world-manifest: ${id} VIOLATES the {name,vibe}-plays law (a slot has no default).`);
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
