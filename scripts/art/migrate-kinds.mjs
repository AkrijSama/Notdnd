// ---------------------------------------------------------------------------
// ONE-SHOT MIGRATION — library kind vocabulary v1 -> v2 (art-pipeline-v2).
//
//   npc-body     -> fullbody
//   npc-portrait -> portrait
//
// Every sidecar is rewritten through buildSidecar (schema normalize) so all
// assets gain the new identityRef:null field; world / style / tags / rating /
// checkout / workflow / promptUsed / creator / origin / createdAt are preserved.
// Idempotent — a second run remaps nothing (no npc-* remain) and is a clean
// no-op rewrite. Operates on the library at NOTDND_ASSET_LIBRARY_ROOT (default
// data/assets/library), which is gitignored runtime data.
//
//   node scripts/art/migrate-kinds.mjs
// ---------------------------------------------------------------------------

import { allAssets, addAsset } from "./library.mjs";

export const KIND_REMAP = Object.freeze({ "npc-body": "fullbody", "npc-portrait": "portrait" });

function census(assets) {
  const out = {};
  for (const a of assets) {
    out[a.kind] = (out[a.kind] || 0) + 1;
  }
  return out;
}

// Returns { total, remapped, before:{kind:count}, after:{kind:count} }.
export function migrateKinds() {
  const assets = allAssets();
  const before = census(assets);
  let remapped = 0;
  const written = [];
  for (const a of assets) {
    const newKind = KIND_REMAP[a.kind] || a.kind;
    if (newKind !== a.kind) {
      remapped += 1;
    }
    written.push(addAsset({ ...a, kind: newKind }));
  }
  return { total: assets.length, remapped, before, after: census(written) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = migrateKinds();
  console.log(`migrate-kinds: ${r.total} sidecars, ${r.remapped} remapped`);
  console.log("  before:", JSON.stringify(r.before));
  console.log("  after :", JSON.stringify(r.after));
}
