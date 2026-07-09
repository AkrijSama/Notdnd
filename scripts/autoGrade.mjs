// AUTO-GRADE runner — drives an autonomous free-text session on the REAL GM
// (deepseek-v4-pro) and scores it against the manual walkthrough rubric, emitting
// a machine-actionable graded report to docs/grades/auto-grade-<timestamp>.md.
//
// This is the thin drive layer; the grading + detection lives in the shared pure
// module scripts/selfplayAudit.mjs (gradeSession / renderGradeReport), which
// reuses the existing phantom + invented-agent auditors. It EXTENDS the selfplay
// harness (same auth + world-run + action/scene pattern), it does not replace it.
//
// Usage:
//   node scripts/autoGrade.mjs                # short proof (4 turns) on :4173
//   TURNS=16 node scripts/autoGrade.mjs       # full pass (director's next step)
//   BASE=http://127.0.0.1:4173 TURNS=5 node scripts/autoGrade.mjs
//
// MODEL INTEGRITY: after each turn the runner reads /api/debug/status → gm.served
// (the model that ACTUALLY served the last turn) and tags fallback turns; the
// grader excludes them from the narration/coherence axes.
import { writeFileSync, mkdirSync, readdirSync, existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gradeSession, renderGradeReport, isRealGmModel } from "./selfplayAudit.mjs";

const BASE = process.env.BASE || "http://127.0.0.1:4173";
const TURNS = Math.max(1, Number(process.env.TURNS || 4));
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 90000);

// Where graded reports are written + discovered. ONE source of truth so writer and
// reader can never drift on the directory or the filename shape.
const GRADES_DIR = "docs/grades";
// Reports are named `auto-grade-<timestamp>.md` (see outPath below) — hyphenated,
// flat under docs/grades. A previous globstar attempt (`docs/**/autograde*.md`)
// found ZERO: Node's fs has no globstar, and the name is `auto-grade`, not
// `autograde`. Match the REAL shape with a plain readdir + prefix/suffix filter.
const GRADE_FILE_RE = /^auto-grade-.*\.md$/;

/**
 * Discover the existing graded reports under docs/grades. Returns sorted absolute-
 * within-repo paths. Empty (never throws) when the directory is absent.
 */
export function discoverGradeReports(dir = GRADES_DIR) {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((name) => GRADE_FILE_RE.test(name))
    .sort()
    .map((name) => `${dir}/${name}`);
}

async function call(path, { method = "GET", token, body } = {}) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  const t0 = Date.now();
  try {
    const res = await fetch(BASE + path, {
      method,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal
    });
    let json = null;
    try { json = await res.json(); } catch { json = null; }
    return { status: res.status, json, ms: Date.now() - t0 };
  } catch (err) {
    return { status: 0, json: { ok: false, _error: String(err?.message || err) }, ms: Date.now() - t0 };
  } finally {
    clearTimeout(to);
  }
}

const stamp = () => Math.random().toString(36).slice(2, 9);

// Compact fingerprint of every committed surface a narrated success could claim
// (mirrors selfplay's advancementSnapshot — the anti-narrate-into-void diff).
function snapshot(s) {
  s = s || {};
  const inv = Array.isArray(s.player?.inventory) ? s.player.inventory : [];
  const quests = Array.isArray(s.quests?.activeQuests) ? s.quests.activeQuests : [];
  return {
    loc: s.location?.locationId || null,
    discovered: Array.isArray(s.discoveredDetails) ? s.discoveredDetails.length : 0,
    inv: inv.map((i) => `${i.id || i.itemId}:${i.qty ?? i.quantity ?? 1}`).sort().join(","),
    quests: quests.map((q) => `${q.questId}@${q.stage ?? 0}:${q.status}`).sort().join(","),
    mainStage: s.quests?.mainQuest?.stage ?? null,
    xp: typeof s.player?.xp === "number" ? s.player.xp : 0,
    hp: s.player?.resources?.hitPoints?.current ?? s.player?.hitPoints?.current ?? null,
    objects: JSON.stringify(s.location?.flags?.objectStates || {}),
    cast: (s.cast || []).map((c) => c.displayName).sort().join(",")
  };
}

const worldTimeOf = (s) => s?.player?.worldTime || s?.worldTime || {};
const conditionCountOf = (s) => (s?.conditions || s?.player?.status?.conditions || s?.player?.conditions || []).length;
const narrationOf = (actionJson, sceneJson) =>
  String(actionJson?.gmNarration || sceneJson?.gmNarration?.narration?.body || sceneJson?.openingNarration || "").trim();

// The autonomous free-text script. Deliberately includes a repeated same-action
// failure (recycled-loop / failure-escalation bait) and a time/NPC beat. Longer
// runs cycle escalating pressure onto the same obstacle.
const SCRIPT = [
  "look around and take stock of where I am and who is here",
  "search the area carefully for anything hidden or useful",
  "try to force the locked door open with my shoulder",
  "throw my whole weight against the same locked door again",
  "approach whoever is nearest and ask them their name",
  "demand the stranger tell me what they know about this place",
  "wait by the door and watch the room for a long while",
  "search the door and its frame for a hidden catch or key"
];
const intentForTurn = (i) => SCRIPT[i % SCRIPT.length];

async function main() {
  console.log(`[auto-grade] BASE=${BASE}  TURNS=${TURNS}`);
  const dbg0 = await call("/api/debug/status");
  const sha = dbg0.json?.build?.sha || "?";
  const configuredModel = dbg0.json?.gm?.configuredModel || "?";
  console.log(`[auto-grade] tip ${sha}  configuredModel ${configuredModel}`);

  const reg = await call("/api/auth/register", { method: "POST", body: { email: `autograde_${stamp()}@notdnd.local`, password: "password123", displayName: "AutoGrade" } });
  const token = reg.json?.token;
  if (!token) throw new Error(`register failed: HTTP ${reg.status} ${JSON.stringify(reg.json).slice(0, 200)}`);

  const wr = await call("/api/onboarding/world-run", { method: "POST", token, body: {
    mode: "campaign",
    world: { name: "Ashfall Reach", tone: "grim dark fantasy", startingLocationName: "The Ember Tavern", startingLocationType: "tavern", flavor: "ash-choked frontier, old debts, colder gods" },
    character: { name: "Bram", race: "Human", characterClass: "Rogue", background: "Criminal", baseAbilityScores: { strength: 11, dexterity: 14, constitution: 12, intelligence: 12, wisdom: 11, charisma: 10 } }
  }});
  const runId = wr.json?.runId;
  if (!runId) throw new Error(`world-run failed: HTTP ${wr.status} ${JSON.stringify(wr.json).slice(0, 220)}`);
  console.log(`[auto-grade] run ${runId}`);

  const scene = () => call(`/api/solo/runs/${runId}/scene`, { token });
  const act = (intent) => call(`/api/solo/runs/${runId}/actions`, { method: "POST", token, body: { action: { type: "attempt", intent, actorId: "player" } } });

  const turns = [];
  // Ruler v2 run-level checks (name collisions, introduction beats) read the
  // committed run record — the action response carries it; keep the freshest.
  let lastRun = null;
  let prevSnap = snapshot((await scene()).json);
  for (let i = 0; i < TURNS; i += 1) {
    const intent = intentForTurn(i);
    const r = await act(intent);
    if (r.json?.run) lastRun = r.json.run;
    // The model that ACTUALLY served THIS turn.
    const served = (await call("/api/debug/status", { token })).json?.gm?.served || {};
    const sc = (await scene()).json;
    const snap = snapshot(sc);
    const wtBefore = null;
    const wt = worldTimeOf(sc);
    const model = served.model || "unknown";
    const fallback = served.fallback === true || served.local === true || !isRealGmModel(model);
    turns.push({
      n: i + 1,
      intent,
      narration: narrationOf(r.json, sc),
      model,
      fallback,
      latencyMs: typeof served.latencyMs === "number" ? served.latencyMs : r.ms,
      attemptResult: r.json?.attemptResult || sc?.latestAttemptResult || {},
      // Whether THIS turn produced a fresh attempt result. A reroute turn (search /
      // observe / move / take) commits via its own path and returns no attemptResult;
      // scene.latestAttemptResult then still holds the PREVIOUS attempt (stale). The
      // depth void-check must not read that stale success against a reroute turn.
      freshAttempt: Boolean(r.json?.attemptResult),
      searchResult: r.json?.searchResult || null,
      moved: r.json?.moved || null,
      takeResult: r.json?.takeResult || null,
      scene: sc,
      sceneBefore: prevSnap,
      sceneAfter: snap,
      worldTime: { ...wt, advanced: prevSnap ? true : undefined },
      conditionCount: conditionCountOf(sc)
    });
    console.log(`  T${i + 1} "${intent.slice(0, 42)}…"  model=${model}${fallback ? " (FALLBACK)" : ""}  ${(turns[i].latencyMs / 1000).toFixed(1)}s  roll=${turns[i].attemptResult?.checkResult ? `${turns[i].attemptResult.checkResult.total}v${turns[i].attemptResult.checkResult.dc}` : "—"}`);
    prevSnap = snap;
  }

  // Wall-clock of THIS grading run (not the server's start time) so each session
  // writes a unique report file.
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const graded = gradeSession(turns, { run: lastRun, meta: { runId, sha, drive: "free-text autoplay" } });
  console.log(`[auto-grade] ruler=${graded.ruler?.version}`);
  const report = renderGradeReport(graded, { timestamp, runId, sha, drive: "free-text autoplay" });

  mkdirSync(GRADES_DIR, { recursive: true });
  const outPath = `${GRADES_DIR}/auto-grade-${timestamp}.md`;
  writeFileSync(outPath, report + "\n");

  console.log("\n=== GRADES ===");
  for (const [k, a] of Object.entries(graded.axes)) {
    console.log(`  ${k.padEnd(10)} ${a.letter.padEnd(3)} ${a.numeric == null ? "—" : a.numeric}${a.invalid ? "  ⚠️ INVALID (fallback-heavy)" : ""}`);
  }
  console.log(`  model-integrity: ${graded.integrity.real}/${graded.integrity.total} real-deepseek, ${graded.integrity.fallback} fallback, valid=${graded.integrity.valid}`);
  console.log(`  findings: ${graded.findings.length}`);
  console.log(`\n[auto-grade] report → ${outPath}`);
  return graded.integrity.valid ? 0 : 0; // grading always exits 0; validity is reported in-band
}

// Only run the CLI when invoked DIRECTLY (`node scripts/autoGrade.mjs`), never on
// import — so tests can import discoverGradeReports without firing a grading run.
const invokedDirectly = Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
if (invokedDirectly) {
  if (process.argv.includes("--list")) {
    // `--list`: discover + print existing graded reports (no server call), using
    // the corrected pattern — confirms discovery matches the real files.
    const reports = discoverGradeReports();
    console.log(`[auto-grade] ${reports.length} report(s) in ${GRADES_DIR}:`);
    for (const p of reports) console.log(`  ${p}`);
    process.exit(0);
  } else {
    main().then((n) => process.exit(n)).catch((err) => { console.error("[auto-grade] ERROR:", err?.stack || err?.message || err); process.exit(2); });
  }
}
