// ---------------------------------------------------------------------------
// WALK-DOOR HARNESS — the MODEL (pure, no HTTP, no AI, no server import).
//
// WHY THIS FILE EXISTS: four owner walks died on defects the auto-harness should
// have caught. The governing diagnosis (owner, 2026-07-22): the harness verifies
// the layer BENEATH the player. Function-verified is not door-verified;
// server-truth is not pixel-truth. Class-5 (the Babel world card served a bundled
// default for weeks) passed every check because the checks called resolveLibraryArt
// in Node — they never issued the request a browser issues, without its auth token.
//
// This module makes the route-inventory EXPLICIT: every player-facing art surface,
// how the CLIENT actually resolves it, at what LAYER we verify it, and what a
// fallback firing means. A surface not in this registry is a surface no one is
// watching — the registry-completeness test (tests/walk-door-harness.test.js) fails
// if a known surface is missing.
// ---------------------------------------------------------------------------

// ── THE VERIFICATION LAYERS (Job 1.1) ────────────────────────────────────────
// Ordered weakest→strongest for the coverage gate. A surface's verifiedAtLayer is
// the DEEPEST layer its check actually reaches. Anything at or below HTTP_AUTHED is
// NOT door-verified for a guest/real-first-user.
export const LAYERS = Object.freeze({
  FUNCTION: {
    id: "function", rank: 0,
    catches: "logic of a resolver/helper in isolation",
    misses: "HTTP routing, auth, the client fetch, what bytes actually ship, how it renders"
  },
  SERVER_STATE: {
    id: "server-state", rank: 1,
    catches: "run/db state correctness after an operation",
    misses: "HTTP delivery to the client, the door's auth, the client, render/pixels"
  },
  HTTP_AUTHED: {
    id: "http-authed", rank: 2,
    catches: "an authed endpoint's payload when a valid token IS sent",
    misses: "what a GUEST / raw client fetch (no token) receives — the class-5 shape"
  },
  HTTP_GUEST: {
    id: "http-guest", rank: 3,
    catches: "the auth-gate divergence: an endpoint that 401s for the request the CLIENT actually issues",
    misses: "how the bytes are displayed (crop/CSS), the rendered DOM"
  },
  SERVED_BYTES: {
    id: "served-bytes", rank: 4,
    catches: "the WRONG asset / a silent fallback actually reaching the door (sha256 of served bytes)",
    misses: "how those bytes are laid out on screen (crop, CSS box, composition)"
  },
  RENDERED_DOM: {
    id: "rendered-dom", rank: 5,
    catches: "client-render defects, whether the swap/CSS class actually applied in a DOM",
    misses: "actual pixels / visual composition / taste"
  },
  PIXELS: {
    id: "pixels", rank: 6,
    catches: "the visual result a human sees (crop, framing, composition)",
    misses: "nothing structural — but cannot judge taste/fun/pacing"
  }
});
// The gate line: a player-facing surface verified only here or below is UNVERIFIED
// for a walk (the class-5 hole lived entirely below this line).
export const DOOR_LAYER_RANK = LAYERS.HTTP_GUEST.rank;

// ── COOK DIMENSIONS per kind ─────────────────────────────────────────────────
// CORRECTED (walk-fix): the LIVE comfyui path uses `dimsFor(recipe, kind)`
// (scripts/art/generate.mjs), which OVERRIDES the imageWorker.js caller constants.
// The earlier harness used those constants (e.g. portrait 512x768) and UNDER-reported
// the portrait crop. The real cook aspects are below.
export const COOK = Object.freeze({
  "world-card": { dims: [1344, 768], ref: "generate.mjs dimsFor 'world-card' → KIND_DIMENSIONS 1344x768" },
  scene: { dims: [1344, 768], ref: "generate.mjs dimsFor 'scene' → KIND_DIMENSIONS 1344x768" },
  // kind='portrait' → dimsFor returns 896x1152 for BOTH bust and player on the comfyui path
  // (the imageWorker 512x768/1024x1024 constants are the pollinations-path caller dims and
  // are overridden). The pipeline's portrait dims are inconsistent — reported as a finding.
  "portrait-bust": { dims: [896, 1152], ref: "generate.mjs dimsFor 'portrait' → KIND_DIMENSIONS 896x1152 (recipe; overrides imageWorker 512x768)" },
  "portrait-player": { dims: [896, 1152], ref: "generate.mjs dimsFor 'portrait' → 896x1152 (comfyui; imageWorker constant is 1024x1024 for pollinations only)" },
  fullbody: { dims: [832, 1216], ref: "generate.mjs dimsFor 'fullbody' → 832x1216" }
});

// ── DISPLAY BOXES per surface (from src/styles.css) ──────────────────────────
// aspect = width/height. A `null` aspect means viewport-dependent — then `evalAspect`
// takes a reference viewport. `ref` is the CSS file:line.
// objectFit determines the failure mode: "cover" CROPS a mismatch (content cut — a hard
// finding); "contain" LETTERBOXES it (empty space — nothing cut, the owner's law holds).
export const DISPLAY = Object.freeze({
  "world-card-lobby": { fixedHeight: 150, widthHint: 260, objectFit: "cover", ref: "src/styles.css .onb-world-card-art (100% x 150px, object-fit cover)" },
  // walk-fix: the stage scene box now holds the 1344x768 cook aspect (fixed 7:4) and the
  // img is object-fit:contain — nothing is ever cut.
  scene: { aspect: 1344 / 768, objectFit: "contain", ref: "src/styles.css .solo-stage .solo-scene-art (aspect 1344/768; img object-fit contain — walk-fix)" },
  "portrait-frame": { aspect: 512 / 768, objectFit: "contain", ref: "src/styles.css .frame-portrait (2:3) + .solo-portrait-img object-fit contain — walk-fix" },
  "vn-sprite": { aspect: 832 / 1216, objectFit: "cover", ref: "src/styles.css .solo-vn-sprite-img (2:3 source fills height)" }
});

// crop math: cookAspect vs displayAspect (both = width/height). Returns axis + %.
export function cropInfo(cookAspect, displayAspect) {
  if (!(cookAspect > 0) || !(displayAspect > 0)) return { axis: "unknown", cropPct: null, shownPct: null };
  if (Math.abs(cookAspect - displayAspect) < 1e-6) return { axis: "none", cropPct: 0, shownPct: 100 };
  if (displayAspect > cookAspect) {
    // display box is WIDER than the source → source cropped TOP/BOTTOM.
    const shown = cookAspect / displayAspect;
    return { axis: "vertical (top/bottom)", cropPct: round1((1 - shown) * 100), shownPct: round1(shown * 100) };
  }
  // display box is NARROWER (taller) than the source → source cropped LEFT/RIGHT.
  const shown = displayAspect / cookAspect;
  return { axis: "horizontal (sides)", cropPct: round1((1 - shown) * 100), shownPct: round1(shown * 100) };
}
function round1(n) { return Math.round(n * 10) / 10; }

// Resolve a surface's display aspect at a reference viewport (for variable boxes).
// referenceViewport = { width, height } — the container is treated as full-bleed
// (width) for the scene strip; height uses the CSS clamp against 35vh.
export function evalDisplayAspect(displaySpec, referenceViewport) {
  if (typeof displaySpec.aspect === "number") return displaySpec.aspect;
  if (displaySpec.fixedHeight) return displaySpec.widthHint / displaySpec.fixedHeight;
  if (displaySpec.variable) {
    const [minH, maxH] = displaySpec.heightClamp;
    const vhH = Math.round(referenceViewport.height * 0.35);
    const h = Math.max(minH, Math.min(maxH, vhH));
    return referenceViewport.width / h; // full-bleed width
  }
  return null;
}

// ── THE SURFACE REGISTRY (the route-inventory made explicit) ─────────────────
// clientResolution.kind:
//   "separate-fetch" — the client issues its OWN request for the art URL (the
//        class-5 shape: divergence possible if that request's auth ≠ the payload's).
//   "authed-payload" — the art URL rides INSIDE the authed scene/turn/onboarding
//        payload the browser already receives (no separate art request). The byte
//        serve (/data/assets/library/*.png) is PUBLIC, so once the URL is in the
//        authed payload the bytes reach the door — divergence is impossible here.
//   "static" — a bundled path with no fetch.
export const SURFACES = Object.freeze([
  {
    id: "world-card",
    label: "Lobby world-select card (Babel)",
    playerFacing: true,
    clientResolution: {
      kind: "separate-fetch",
      request: { method: "GET", path: "/api/art/library?world=babel&kind=world-card" },
      // CLI-1 fixed the bare-fetch (bindWorldCardArt → apiClient.artLibrary, token attached).
      // walk-fix then made the endpoint PUBLIC for published world-cards, so a GUEST (no
      // token) now gets the real card too. The harness still replays BOTH doors (authed +
      // guest) and asserts served bytes; either serving the wrong asset is a defect.
      carriesAuth: true,
      guestDegrades: false, // walk-fix: /api/art/library world-card reads are public for published worlds
      ref: "src/components/onboardingFlow.js bindWorldCardArt → apiClient.artLibrary; endpoint server/index.js public for published world-cards (isPublishedWorldCard)"
    },
    deceptiveFallback: { asset: "/public/assets/art-illustrated.jpg", ref: "src/components/onboardingFlow.js:114 WORLD_SELECT_CARDS[0].art" },
    intendedResolver: { server: "resolveLibraryArt({world:'babel',kind:'world-card'})", ref: "server/solo/artLibrary.js:26 WORLD_CARD_PIN → w7_worldcard_obsidian_tower_anime" },
    cookKey: "world-card",
    displayKey: "world-card-lobby",
    // The door check can run WITHOUT a live run (it is a lobby fetch).
    byteCheckable: true
  },
  {
    id: "scene",
    label: "In-game location background",
    playerFacing: true,
    clientResolution: { kind: "authed-payload", payloadField: "scene.locationImageUri", carriesAuth: true, ref: "server/solo/scene.js:1452 resolveLocationImageUri; client via src/api/client.js (Bearer)" },
    deceptiveFallback: null, // honest: "Painting the scene…" vignette (soloSceneShell.js:2126)
    intendedResolver: { server: "resolveSceneArtForRun(run, location)", ref: "server/solo/artLibrary.js resolveSceneArtForRun" },
    cookKey: "scene",
    displayKey: "scene",
    byteCheckable: false // needs a run WITH committed scene art (a cook) — not run (no-cook constraint)
  },
  {
    id: "npc-portrait",
    label: "NPC bust portrait (cast roster)",
    playerFacing: true,
    clientResolution: { kind: "authed-payload", payloadField: "scene.cast[].portraitUri", carriesAuth: true, ref: "server/solo/scene.js:682; client Bearer" },
    deceptiveFallback: null, // honest: initial-letter glyph "Cooking your portrait…" (soloSceneShell.js:2796)
    intendedResolver: { server: "resolveNpcFaceFromLibrary(run,npcId,'portrait')", ref: "server/solo/artLibrary.js" },
    cookKey: "portrait-bust",
    displayKey: "portrait-frame",
    byteCheckable: false
  },
  {
    id: "player-portrait",
    label: "Player bust portrait (scene dock)",
    playerFacing: true,
    clientResolution: { kind: "authed-payload", payloadField: "scene.player.portraitUri", carriesAuth: true, ref: "server/solo/scene.js:868; client Bearer" },
    deceptiveFallback: null, // honest: "Cooking your portrait…" spinner (soloSceneShell.js:1937)
    intendedResolver: { server: "run.player.portraitUri", ref: "server/solo/scene.js:868" },
    cookKey: "portrait-player",
    displayKey: "portrait-frame",
    byteCheckable: false
  },
  {
    id: "fullbody",
    label: "Fullbody / VN sprite (dialogue overlay)",
    playerFacing: true,
    clientResolution: { kind: "authed-payload", payloadField: "scene.vnBodyUri", carriesAuth: true, ref: "server/solo/scene.js:1448 resolveVnBodyUri; client Bearer" },
    deceptiveFallback: null, // honest: renders nothing; wireVnSpriteImage removes broken sprite (soloSceneShell.js:3168)
    intendedResolver: { server: "resolveNpcFaceFromLibrary(run,npcId,'fullbody')", ref: "server/solo/artLibrary.js" },
    cookKey: "fullbody",
    displayKey: "vn-sprite",
    byteCheckable: false
  },
  {
    id: "enemy-fullbody",
    label: "Enemy fullbody (battle card)",
    playerFacing: true,
    clientResolution: { kind: "authed-payload", payloadField: "enemies[].bodyUri", carriesAuth: true, ref: "server/solo/scene.js; soloSceneShell.js:2935; client Bearer" },
    deceptiveFallback: null, // honest: initial-letter "Reading its shape…" (soloSceneShell.js:2937)
    intendedResolver: { server: "resolveNpcFaceFromLibrary(run,npcId,'fullbody')", ref: "server/solo/artLibrary.js" },
    cookKey: "fullbody",
    displayKey: "vn-sprite",
    byteCheckable: false
  },
  {
    id: "item",
    label: "Item",
    playerFacing: true,
    clientResolution: { kind: "static", ref: "soloSceneShell.js:1579 — items render as text only, NO image surface" },
    deceptiveFallback: null,
    intendedResolver: null,
    cookKey: null,
    displayKey: null,
    byteCheckable: false,
    noArt: true
  }
]);

// ── SILENT FALLBACK INVENTORY (Job 4) ────────────────────────────────────────
// classification: "deceptive" = a finished-looking substitute indistinguishable
// from success (an architectural defect — needs a code change to become loud);
// "honest" = a visible not-ready/absent state (a spinner/glyph/empty), fine as-is.
export const SILENT_FALLBACKS = Object.freeze([
  {
    id: "world-card-pending-placeholder",
    classification: "honest", // walk-fix RESOLVED the deceptive case:
    trigger: "world-card art unresolved (null uri, or a rare error) → the card shows a VISIBLE data-art-pending hatch, and the ENDPOINT is now public for published worlds so a guest gets the real card",
    userSees: "a muted 'no art yet' placeholder (data-art-pending) — a loud absence, never a plausible wrong image. The bundled bust (art-illustrated.jpg) is decoupled from card duty (style-sample only).",
    ref: "src/components/onboardingFlow.js renderWorldCard (data-art-pending) + bindWorldCardArt; styles.css .onb-world-card-art[data-art-pending]",
    harnessDetects: true, // the served-bytes door check (both replays) still guards it
    recommend: "none — the deceptive fallback was removed (walk-fix): public endpoint for published world-cards + a visible pending placeholder + the bust decoupled from card duty. tests/world-select-cards.test.js no longer blesses the static default."
  },
  { id: "scene-pending", classification: "honest", trigger: "no locationImageUri yet", userSees: "'Painting the scene…' vignette", ref: "src/components/soloSceneShell.js:2126", harnessDetects: true, recommend: "none (honest pending)" },
  { id: "npc-portrait-pending", classification: "honest", trigger: "no portraitUri", userSees: "initial-letter glyph 'Cooking your portrait…'", ref: "src/components/soloSceneShell.js:2796", harnessDetects: true, recommend: "none" },
  { id: "player-portrait-pending", classification: "honest", trigger: "no portraitUri", userSees: "'Cooking your portrait…' spinner", ref: "src/components/soloSceneShell.js:1937", harnessDetects: true, recommend: "none" },
  { id: "vn-sprite-empty", classification: "honest", trigger: "no spriteUri / img error", userSees: "nothing (sprite container removed)", ref: "src/components/soloSceneShell.js:3168", harnessDetects: true, recommend: "none" },
  { id: "enemy-body-pending", classification: "honest", trigger: "no bodyUri", userSees: "initial-letter 'Reading its shape…'", ref: "src/components/soloSceneShell.js:2937", harnessDetects: true, recommend: "none" }
]);

// A served-bytes verdict: does what the door served match the intended asset?
export function servedBytesVerdict({ surfaceId, servedSha, intendedSha, servedFrom, fallbackAsset }) {
  const isFallback = fallbackAsset && servedFrom && servedFrom.includes(fallbackAsset.replace(/^\//, ""));
  const match = Boolean(servedSha && intendedSha && servedSha === intendedSha);
  return {
    surfaceId, match, servedSha, intendedSha, servedFrom,
    // Job 3.2: a fallback firing when a real asset exists is a FAILURE, not a graceful degrade.
    failure: !match,
    reason: match ? "served bytes == intended asset"
      : isFallback ? `SILENT FALLBACK FIRED: door served ${fallbackAsset} (sha ${short(servedSha)}), intended ${short(intendedSha)}`
      : `served bytes (${short(servedSha)}) ≠ intended (${short(intendedSha)})`
  };
}
function short(s) { return s ? String(s).slice(0, 12) : "—"; }

// The door layer ADEQUATE for a surface depends on how the client resolves its art:
//   separate-fetch  → SERVED_BYTES  (the class-5 shape: a divergence AND a deceptive
//                     fallback are both possible, so nothing short of the served bytes
//                     from the client's ACTUAL request suffices).
//   authed-payload  → HTTP_AUTHED   (the URI rides the authed payload the browser
//                     already gets; the byte serve is public; there is NO guest-
//                     divergence class and (verified) NO deceptive fallback — so the
//                     route layer is adequate. Byte-level remains an honest gap, listed
//                     in UNVERIFIED, but it cannot hide a class-5.).
export function requiredDoorRank(surfaceKind) {
  if (surfaceKind === "separate-fetch") return LAYERS.SERVED_BYTES.rank;
  if (surfaceKind === "authed-payload") return LAYERS.HTTP_AUTHED.rank;
  return LAYERS.HTTP_AUTHED.rank;
}

// ── COVERAGE VERDICT (Job 6.2) ───────────────────────────────────────────────
// WALK-READY requires: no FAIL, AND every player-facing surface reached the door
// layer ADEQUATE FOR ITS KIND. A surface below its adequate door layer blocks.
export function coverageVerdict(surfaceResults) {
  const fails = surfaceResults.filter((r) => r.status === "FAIL");
  const belowDoor = surfaceResults.filter(
    (r) => r.playerFacing && !r.noArt && r.reachedLayerRank < requiredDoorRank(r.clientKind)
  );
  const walkReady = fails.length === 0 && belowDoor.length === 0;
  return {
    walkReady,
    fails: fails.map((f) => f.id),
    unverifiedBelowDoor: belowDoor.map((b) => ({ id: b.id, reachedLayer: b.reachedLayer, why: b.why })),
    // Job 1.4 headline number: player-facing surfaces verified only below the HTTP layer.
    belowHttpCount: surfaceResults.filter((r) => r.playerFacing && !r.noArt && r.reachedLayerRank < LAYERS.HTTP_AUTHED.rank).length
  };
}

// What this harness structurally CANNOT catch (Job 6.3) — stated so a green run is
// never read as "the owner can walk".
export const CANNOT_CATCH = Object.freeze([
  // The rendered-DOM/console gap is NOW CLOSED by the browser stage (headless Chrome/CDP):
  // it reads real img.naturalWidth/Height, captures every console entry, and fails on any
  // error / failed request / websocket drop. What remains structurally out of reach:
  "Actual pixels / visual composition: framing, crop as a human perceives it, whether an image 'looks right', anatomy, or style fidelity. The browser stage proves an image RENDERED (non-zero dimensions) — never that it renders WELL.",
  "A LIVE portrait/scene cook driven to completion: the stage reaches the character-creation identity step (where JOB 1's error text WOULD render, and is scanned for) but does not drive the full race/class/style wizard through a ~50s generation. The naturalWidth render-assertion is proven on committed art (lobby world-card, live-run scene when present); a freshly-cooking image is verified by the ABSENCE of its error state, not by waiting for its pixels.",
  "Taste, fun, pacing, prose quality, emotional payoff — outside any structural harness.",
  "Viewports not driven: the browser stage runs one desktop size (1440×900). Mobile/tablet reflow, touch, and small-screen crop are unverified.",
  "Defects on pages/states the stage never navigates to (only lobby, character-creation, and — when a run id is supplied — one live run are visited; deep sub-flows and modal states beyond those are unseen).",
  "Long-session coherence that only emerges across many turns (this run drives short, scripted turns).",
  "Any paid-model narration quality (turns run deterministic/placeholder at $0 by default)."
]);
