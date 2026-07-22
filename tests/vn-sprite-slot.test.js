import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { renderSoloDialogueOverlay, wireVnSpriteImage } from "../src/components/soloSceneShell.js";

// vn-sprite-slot: the VN dialogue layer's character-sprite surface. It consumes the
// per-speaker full-body sprite the payload already exposes (scene.vnBodyUri), falls
// back to the 2:3 bust portrait, and renders NOTHING when there's no image (the "S"
// glyph is gone). Tests are string/CSS-based (the client tests carry no DOM engine).

const CSS = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const baseTalk = { npcId: "vex", speakerName: "Vex", expression: "neutral", line: "Well met.", expressionVariants: {} };
const stateWith = (talk = {}, scene = {}) => ({
  dialogueActive: true,
  scene: { cast: [], ...scene },
  talkResult: { ...baseTalk, ...talk }
});

// ── (a) a sprite URL renders an <img> in the 2:3 sprite container ──────────────
test("(a) a payload sprite URL renders an <img> in the 2:3 sprite container", () => {
  const html = renderSoloDialogueOverlay(stateWith({}, { vnBodyUri: "/sprites/vex_fullbody.png" }));
  assert.match(html, /class="solo-vn-sprite"/, "sprite container renders");
  assert.match(html, /class="solo-vn-sprite-img[^"]*"[^>]*src="\/sprites\/vex_fullbody\.png"/, "the <img> carries the sprite src");
  assert.match(html, /data-solo-vn-sprite/, "the load/error hook is present");
  // The 2:3 surface is enforced in CSS: contain (never crops a face) + ratio-driven
  // width (height fills, width follows) so an 832x1216 sprite keeps its 2:3.
  assert.match(CSS, /\.solo-vn-sprite-img\s*\{[^}]*object-fit:\s*contain/s, "object-fit: contain");
  assert.match(CSS, /\.solo-vn-sprite-img\s*\{[^}]*height:\s*100%[^}]*width:\s*auto/s, "height fills, width follows the ratio");
  assert.match(CSS, /\.solo-vn-sprite-img\s*\{[^}]*background:\s*transparent/s, "transparent-bg (PNG alpha cut-outs)");
});

test("the full-body sprite (vnBodyUri) is preferred over the bust portrait", () => {
  const html = renderSoloDialogueOverlay(
    stateWith({}, { cast: [{ npcId: "vex", portraitUri: "/bust.png" }], vnBodyUri: "/fullbody.png" })
  );
  // the SPRITE uses the full-body sprite...
  assert.match(html, /class="solo-vn-sprite-img[^"]*"[^>]*src="\/fullbody\.png"/);
  // ...and NOT the bust. Scope the exclusion to the sprite <img>: the bust now legitimately
  // appears in the NPC FACE THUMBNAIL (.solo-vn-face, owner HUD arrangement 2026-07-22), a
  // separate cluster element that IS the speaker's face — so a whole-overlay /bust/ exclusion
  // would wrongly fail on it.
  assert.doesNotMatch(html, /class="solo-vn-sprite-img[^"]*"[^>]*src="\/bust\.png"/);
});

test("falls back to the 2:3 bust portrait when there is no full-body sprite yet", () => {
  const html = renderSoloDialogueOverlay(stateWith({}, { cast: [{ npcId: "vex", portraitUri: "/bust.png" }] }));
  assert.match(html, /class="solo-vn-sprite-img[^"]*"[^>]*src="\/bust\.png"/);
});

// ── (b) a null URL renders no visible slot (the "S" is gone) ───────────────────
test('(b) a null sprite URL renders NO visible slot — no "S" glyph, no placeholder, no container', () => {
  const html = renderSoloDialogueOverlay(stateWith({}, {})); // no vnBodyUri, no cast portrait
  assert.doesNotMatch(html, /solo-vn-sprite/, "no sprite container or <img>");
  assert.doesNotMatch(html, /Portrait incoming/, "no placeholder text");
  assert.doesNotMatch(html, /solo-vn-portrait-placeholder/, "no placeholder markup");
  // The dialogue layer is otherwise exactly as before — the textbox still renders.
  assert.match(html, /class="solo-vn-box"/);
  assert.match(html, /data-solo-dialogue-reply-input/);
});

// ── (c) a failed image load degrades to the empty state ───────────────────────
test("(c) a failed sprite load removes the sprite (empty state, never a broken-image icon)", () => {
  const events = {};
  let hostRemoved = false;
  const host = { remove() { hostRemoved = true; } };
  const img = {
    dataset: {},
    classList: { add() {} },
    complete: false,
    addEventListener(ev, fn) { events[ev] = fn; },
    closest(sel) { return sel === ".solo-vn-sprite" ? host : null; },
    remove() {}
  };
  wireVnSpriteImage(img);
  assert.equal(typeof events.error, "function", "an error handler is wired");
  events.error(); // the sprite image failed to load
  assert.equal(hostRemoved, true, "the sprite container is removed → empty state");
});

test("(c2) a successful load fades the sprite in (is-loaded)", () => {
  const events = {};
  let added = null;
  const img = {
    dataset: {}, complete: false,
    classList: { add(c) { added = c; } },
    addEventListener(ev, fn) { events[ev] = fn; },
    closest() { return null; }, remove() {}
  };
  wireVnSpriteImage(img);
  events.load();
  assert.equal(added, "is-loaded");
  // CSS backs the fade: img starts transparent, .is-loaded reveals it.
  assert.match(CSS, /\.solo-vn-sprite-img\s*\{[^}]*opacity:\s*0/s);
  assert.match(CSS, /\.solo-vn-sprite-img\.is-loaded\s*\{[^}]*opacity:\s*1/s);
});

test("wireVnSpriteImage reveals an already-complete (cached) image and is idempotent", () => {
  let addCount = 0;
  const img = {
    dataset: {}, complete: true, naturalWidth: 100,
    classList: { add() { addCount += 1; } },
    addEventListener() {}, closest() { return null; }, remove() {}
  };
  wireVnSpriteImage(img);
  assert.ok(addCount >= 1, "a cached image is revealed immediately");
  wireVnSpriteImage(img); // second call is a no-op (dataset guard)
  assert.equal(img.dataset.vnWired, "1");
});

// ── (d) the sprite never overlaps the dialogue textbox (computed geometry) ─────
test("(d) the sprite container never overlaps the textbox @ 3440x1440 and 1440x900", () => {
  const boxReserve = Number((CSS.match(/--vn-box-h:\s*(\d+)px/) || [])[1]);
  const clearance = Number(
    (CSS.match(/\.solo-vn-sprite\s*\{[^}]*bottom:\s*calc\(var\(--vn-box-h[^)]*\)\s*\+\s*(\d+)px/s) || [])[1]
  );
  const spriteTop = Number((CSS.match(/\.solo-vn-sprite\s*\{[^}]*\btop:\s*(\d+)px/s) || [])[1]);
  const spriteRight = Number((CSS.match(/\.solo-vn-sprite\s*\{[^}]*\bright:\s*(\d+)px/s) || [])[1]);
  assert.ok(boxReserve > 0, "--vn-box-h parsed");
  assert.ok(Number.isFinite(clearance), "sprite bottom clearance parsed");
  assert.ok(Number.isFinite(spriteTop) && Number.isFinite(spriteRight), "sprite top/right parsed");

  const spriteBottomFromFloor = boxReserve + clearance; // px above the stage bottom
  const overlaps = (a, b) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;

  for (const { w, h } of [{ w: 3440, h: 1440 }, { w: 1440, h: 900 }]) {
    const stageW = w - 340; // scene column ≈ viewport minus the sidebar
    const stageH = Math.round(h * 0.35); // the stage claims ~35vh (owner spec)
    // textbox: full-width band across the stage bottom, height = the reserved band.
    const box = { x0: 0, y0: stageH - boxReserve, x1: stageW, y1: stageH };
    // sprite: right-anchored; width conservatively capped at max-width (real width,
    // = height×2/3, is smaller — so a non-overlap here implies the real one too).
    const spriteW = Math.min(0.4 * stageW, 420);
    const sprite = {
      x0: stageW - spriteRight - spriteW,
      y0: spriteTop,
      x1: stageW - spriteRight,
      y1: stageH - spriteBottomFromFloor
    };
    assert.ok(!overlaps(sprite, box), `no sprite/textbox overlap at ${w}x${h}`);
    assert.ok(sprite.y1 <= box.y0, `sprite bottom clears the textbox top at ${w}x${h}`);
    assert.ok(sprite.x0 >= 0 && sprite.x1 <= stageW, `sprite within stage width at ${w}x${h}`);
    assert.ok(sprite.y0 >= 0 && sprite.y1 <= stageH, `sprite within stage height at ${w}x${h}`);
  }
});

// ── (e) the interactive-element sweep survives (reply/End/textbox/panel) ───────
test("(e) the VN overlay keeps its interactive elements alongside the sprite", () => {
  const html = renderSoloDialogueOverlay(stateWith({ line: "Hail." }, { vnBodyUri: "/s.png" }));
  assert.match(html, /data-solo-dialogue-reply-input/, "reply input");
  assert.match(html, /data-solo-dialogue-reply-submit/, "reply submit");
  assert.match(html, /data-solo-dialogue-end/, "End control");
  assert.match(html, /data-solo-dialogue-panel/, "panel (skip-typewriter) hook");
  assert.match(html, /data-solo-dialogue-text/, "typewriter target");
  assert.match(html, /class="solo-vn-sprite"/, "…and the sprite renders in the same overlay");
});

// ── item 3: VN idle "breathing" animation ─────────────────────────────────────
test("(item 3) the breathing class is applied when a sprite exists", () => {
  const html = renderSoloDialogueOverlay(stateWith({}, { vnBodyUri: "/sprites/vex.png" }));
  assert.match(html, /class="solo-vn-sprite-img solo-vn-sprite-breathe"/, "sprite <img> carries the breathe class");
});

test("(item 3) the breathing class is absent in the empty state", () => {
  const html = renderSoloDialogueOverlay(stateWith({}, {})); // no sprite
  assert.doesNotMatch(html, /solo-vn-sprite-breathe/, "no breathe class when there is no sprite");
});

test("(item 3) breathing is CSS-only, GPU-cheap (transform), and disabled under reduced-motion", () => {
  // the loop: scale ~1.015 + a ≤2px vertical drift, 4s ease-in-out infinite, transform only
  assert.match(CSS, /@keyframes soloVnBreathe[\s\S]*?scale\(1\.015\)[\s\S]*?translateY\(-2px\)/);
  assert.match(CSS, /\.solo-vn-sprite-breathe\s*\{[^}]*animation:\s*soloVnBreathe\s+4s\s+ease-in-out\s+infinite/s);
  assert.match(CSS, /transform-origin:\s*center bottom/); // feet planted (grows upward)
  // reduced-motion disables it entirely
  assert.match(CSS, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.solo-vn-sprite-breathe\s*\{\s*animation:\s*none/);
});
