// PUBLIC ROADMAP PAGE — dedicated, scrollable, every-row-clickable roadmap view.
// Renders from data/roadmap-public.json (served static), NOT from hardcoded markup.
// Client tests are string-based: expand is asserted via a state flag -> HTML.
//
// STANDING LAW under test: statuses are exactly one of building | next | planned |
// long-term, and NO dates / NO percentages / NO em-dash appear anywhere in the
// rendered output OR the data file.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { renderRoadmapPage } from "../src/components/roadmapPage.js";
import { renderRoadmapZone } from "../src/components/homeZones.js";

const DATA_PATH = path.resolve("data/roadmap-public.json");
const RAW = fs.readFileSync(DATA_PATH, "utf8");
const DATA = JSON.parse(RAW);

const ALLOWED_STATUSES = ["building", "next", "planned", "long-term"];

// Banned tokens: any date pattern (ISO / 4-digit year / quarter / month name),
// any percentage, and the em-dash. Month names are matched capitalized (the way a
// date is written) so ordinary prose is not tripped.
const BANNED = [
  { name: "em-dash", re: /—/ },
  { name: "ISO date", re: /\b\d{4}-\d{2}-\d{2}\b/ },
  { name: "4-digit year", re: /\b(?:19|20)\d{2}\b/ },
  { name: "quarter (Q1-Q4)", re: /\bQ[1-4]\b/ },
  {
    name: "month name",
    re: /\b(January|February|March|April|May|June|July|August|September|October|November|December)\b/
  },
  { name: "percent sign", re: /%/ },
  { name: "the word percent", re: /\bpercent/i }
];

const allExpanded = Object.fromEntries(
  (DATA.sections || []).map((section) => [section.id, true])
);

test("renders the whole sealed roadmap from the data file (every section title)", () => {
  const html = renderRoadmapPage(DATA, {});
  assert.ok(Array.isArray(DATA.sections) && DATA.sections.length >= 8, "data carries the full roadmap");
  assert.match(html, /class="panel main roadmap-page"/);
  assert.match(html, new RegExp(DATA.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  for (const section of DATA.sections) {
    assert.ok(html.includes(section.title), `section title present: ${section.title}`);
  }
});

test("covers every required roadmap area", () => {
  const html = renderRoadmapPage(DATA, allExpanded).toLowerCase();
  const required = [
    "combat",
    "bestiary",
    "romance",
    "world", // creator worlds
    "community",
    "multiplayer",
    "rulebook",
    "narration",
    "20,000" // ads promise + milestone counter
  ];
  for (const needle of required) {
    assert.ok(html.includes(needle), `roadmap covers: ${needle}`);
  }
});

test("milestone counters render (label + value)", () => {
  const html = renderRoadmapPage(DATA, {});
  assert.match(html, /class="roadmap-milestones"/);
  for (const m of DATA.milestones || []) {
    assert.ok(html.includes(m.value), `milestone value present: ${m.value}`);
    assert.ok(html.includes(m.label), `milestone label present: ${m.label}`);
  }
});

test("rows are clickable disclosures; detail is gated on the expand state flag", () => {
  const first = DATA.sections[0];
  const collapsed = renderRoadmapPage(DATA, {});
  // Every row is a real button carrying the delegated action + its id.
  assert.match(collapsed, /data-action="toggle-roadmap-row"/);
  assert.ok(collapsed.includes(`data-roadmap-id="${first.id}"`));
  assert.match(collapsed, /aria-expanded="false"/);
  // Collapsed: the detail blurb is ABSENT from the DOM.
  assert.ok(
    !collapsed.includes(first.detail),
    "collapsed row does not emit its detail blurb"
  );

  // Flip the state flag for one row -> that row's blurb appears + aria updates.
  const opened = renderRoadmapPage(DATA, { [first.id]: true });
  assert.ok(opened.includes(first.detail), "expanded row emits its detail blurb");
  assert.match(opened, /aria-expanded="true"/);
  assert.ok(opened.includes(`id="roadmap-detail-${first.id}"`));
  assert.match(opened, /class="roadmap-row roadmap-row--[a-z-]+ is-open"/);
});

test("all four statuses render a labelled pill with its own class", () => {
  const html = renderRoadmapPage(DATA, {});
  const used = new Set((DATA.sections || []).map((s) => String(s.status)));
  for (const status of used) {
    assert.ok(ALLOWED_STATUSES.includes(status), `status is legal: ${status}`);
    assert.match(html, new RegExp(`roadmap-row-status--${status}`));
  }
});

test("empty / null / absent data is an honest page, never a dead end", () => {
  for (const empty of [null, undefined, {}, { sections: [] }]) {
    const html = renderRoadmapPage(empty, {});
    assert.match(html, /roadmap-empty/, "shows an empty state");
    assert.match(html, /data-action="close-roadmap"/, "keeps a Back control");
  }
});

test("the teaser links out to the full page (open-roadmap)", () => {
  const html = renderRoadmapZone([
    { title: "Combat", description: "Turn-based battles", status: "building" }
  ]);
  assert.match(html, /data-action="open-roadmap"/);
  assert.match(html, /See the full roadmap/);
});

test("NO banned tokens in the rendered output (all rows expanded)", () => {
  const html = renderRoadmapPage(DATA, allExpanded);
  for (const { name, re } of BANNED) {
    assert.doesNotMatch(html, re, `rendered output is free of ${name}`);
  }
});

test("NO banned tokens in the data file (raw text)", () => {
  for (const { name, re } of BANNED) {
    assert.doesNotMatch(RAW, re, `data/roadmap-public.json is free of ${name}`);
  }
});

test("the data file is owner-safe and structurally sound", () => {
  assert.equal(typeof DATA.title, "string");
  assert.ok(Array.isArray(DATA.sections) && DATA.sections.length > 0);
  const seen = new Set();
  for (const section of DATA.sections) {
    assert.equal(typeof section.id, "string");
    assert.ok(section.id.trim(), "section has an id");
    assert.ok(!seen.has(section.id), `section id is unique: ${section.id}`);
    seen.add(section.id);
    assert.equal(typeof section.title, "string");
    assert.ok(
      ALLOWED_STATUSES.includes(section.status),
      `status is one of the four sealed values: ${section.status}`
    );
  }
});
