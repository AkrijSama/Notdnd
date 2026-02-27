import { isCanonicalHomebrewJson, validateHomebrewJsonDocument } from "./schema.js";

function normalizeName(value) {
  return String(value || "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function slugify(value) {
  return normalizeName(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "entry";
}

function uniqueNames(values) {
  const seen = new Set();
  const result = [];

  for (const raw of values || []) {
    const value = normalizeName(raw);
    if (!value) {
      continue;
    }
    const key = value.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(value);
  }

  return result;
}

function uniqueObjects(values, keyFn) {
  const seen = new Set();
  const result = [];
  for (const value of values || []) {
    if (!value || typeof value !== "object") {
      continue;
    }
    const key = String(keyFn(value) || "");
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(value);
  }
  return result;
}

function titleFromFileName(name = "Homebrew Import") {
  return String(name)
    .replace(/\.[^.]+$/, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractByRegex(text, pattern) {
  const output = [];
  for (const match of text.matchAll(pattern)) {
    output.push(match[1]);
  }
  return uniqueNames(output);
}

function extractChapters(text) {
  const headings = [];
  for (const match of text.matchAll(/^\s{0,3}#{1,3}\s+(.+)$/gm)) {
    headings.push(match[1]);
  }

  if (headings.length > 0) {
    return uniqueNames(headings).slice(0, 20);
  }

  const chapterish = [];
  for (const match of text.matchAll(/(?:^|\n)\s*(?:chapter|act|part)\s+([0-9ivx]+|one|two|three|four|five|six|seven|eight|nine|ten)\s*[:\-]?\s*([^\n]*)/gi)) {
    const left = String(match[1] || "").trim();
    const right = String(match[2] || "").trim();
    chapterish.push(right ? `Chapter ${left}: ${right}` : `Chapter ${left}`);
  }

  return uniqueNames(chapterish).slice(0, 20);
}

function extractMarkdownSections(text) {
  const source = String(text || "");
  const lines = source.split(/\r?\n/);
  const sections = [];
  let current = null;

  function pushCurrent() {
    if (!current) {
      return;
    }
    current.body = current.body.trim();
    sections.push(current);
  }

  for (const line of lines) {
    const heading = line.match(/^\s{0,3}(#{1,3})\s+(.+)$/);
    if (heading) {
      pushCurrent();
      current = {
        title: normalizeName(heading[2]),
        level: heading[1].length,
        body: ""
      };
      continue;
    }

    if (!current) {
      current = {
        title: "Overview",
        level: 1,
        body: ""
      };
    }

    current.body += `${line}\n`;
  }

  pushCurrent();
  return sections.filter((entry) => entry.title || entry.body);
}

function summarizeTextBlock(text, fallback = "") {
  const cleaned = String(text || "")
    .replace(/[`*_>#-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) {
    return fallback;
  }
  const sentence = cleaned.match(/(.{40,220}?[.!?])(?:\s|$)/);
  if (sentence) {
    return sentence[1].trim();
  }
  return cleaned.slice(0, 220).trim();
}

function tokenize(value) {
  return uniqueNames(
    String(value || "")
      .toLowerCase()
      .split(/[^a-z0-9']+/)
      .filter((entry) => entry.length >= 3)
  );
}

function inferRoleFromName(name) {
  const lowered = String(name || "").toLowerCase();
  if (lowered.includes("captain") || lowered.includes("warden") || lowered.includes("keeper")) {
    return "guide";
  }
  if (lowered.includes("lord") || lowered.includes("cult") || lowered.includes("warlock")) {
    return "villain";
  }
  return "ally";
}

function newEntityShape() {
  return {
    classes: [],
    monsters: [],
    spells: [],
    npcs: [],
    locations: []
  };
}

function newIndexShape() {
  return {
    chapters: [],
    scenes: [],
    encounters: [],
    npcs: [],
    items: [],
    rules: [],
    starterOptions: []
  };
}

function entityTotal(entities) {
  return (
    entities.classes.length +
    entities.monsters.length +
    entities.spells.length +
    entities.npcs.length +
    entities.locations.length
  );
}

function confidenceBand(score) {
  if (score >= 80) {
    return "high";
  }
  if (score >= 60) {
    return "medium";
  }
  return "low";
}

function computeDocumentConfidence({ mode, canonical, chaptersCount, entitiesCount, warningsCount, failed }) {
  if (failed) {
    return {
      score: 0,
      band: "low"
    };
  }

  let score = 35;

  if (mode === "text") {
    score += 10;
  }
  if (mode === "json") {
    score += 15;
  }
  if (canonical) {
    score += 25;
  }

  score += Math.min(20, entitiesCount * 4);
  score += Math.min(10, chaptersCount * 2);
  score -= Math.min(20, warningsCount * 5);

  const bounded = Math.max(0, Math.min(100, score));
  return {
    score: bounded,
    band: confidenceBand(bounded)
  };
}

function buildIndexes({ bookTitle, entities, chapters, text = "" }) {
  const indexes = newIndexShape();
  const sections = extractMarkdownSections(text);

  const chapterTitles = uniqueNames(chapters.length > 0 ? chapters : sections.map((section) => section.title)).slice(0, 12);
  indexes.chapters = chapterTitles.map((title, idx) => {
    const section = sections.find((entry) => entry.title.toLowerCase() === title.toLowerCase());
    const summary = summarizeTextBlock(section?.body, `${title} anchors a playable scene for the party.`);
    return {
      id: `chapter-${slugify(bookTitle)}-${idx + 1}`,
      title,
      bookTitle,
      summary,
      keywords: uniqueNames([title, ...tokenize(summary).slice(0, 8)])
    };
  });

  const locationPool = uniqueNames(entities.locations);
  const monsterPool = uniqueNames(entities.monsters);
  const npcPool = uniqueNames(entities.npcs);
  const itemPool = uniqueNames(extractByRegex(text, /(?:^|\n)\s*(?:item|loot|reward|treasure)\s*[:\-]\s*([A-Za-z][A-Za-z0-9'()\- ]{1,100})/gi));
  const encounterNames = uniqueNames(extractByRegex(text, /(?:^|\n)\s*(?:encounter|battle|ambush|boss)\s*[:\-]\s*([A-Za-z][A-Za-z0-9'()\- ]{1,100})/gi));
  const ruleNames = uniqueNames(extractByRegex(text, /(?:^|\n)\s*(?:rule|mechanic|hazard)\s*[:\-]\s*([A-Za-z][A-Za-z0-9'()\- ]{1,100})/gi));
  const hooks = uniqueNames(extractByRegex(text, /(?:^|\n)\s*(?:hook|goal|objective)\s*[:\-]\s*([A-Za-z][A-Za-z0-9'(),\- ]{1,120})/gi));

  indexes.scenes = indexes.chapters.slice(0, 4).map((chapter, idx) => {
    const locationName = locationPool[idx % Math.max(locationPool.length, 1)] || `${chapter.title} Site`;
    const leadNpc = npcPool[idx % Math.max(npcPool.length, 1)] || "Local Guide";
    return {
      id: `scene-${slugify(bookTitle)}-${idx + 1}`,
      name: `${chapter.title} at ${locationName}`,
      bookTitle,
      chapterTitle: chapter.title,
      locationName,
      summary: `${chapter.summary} ${leadNpc} can surface the central choice in this scene.`.trim(),
      objective: hooks[idx % Math.max(hooks.length, 1)] || `Resolve the pressure point inside ${locationName}.`,
      keywords: uniqueNames([chapter.title, locationName, leadNpc, ...chapter.keywords])
    };
  });

  indexes.encounters = uniqueObjects(
    [...encounterNames.map((name) => ({ name })), ...monsterPool.slice(0, 6).map((monster) => ({ name: `${monster} Skirmish`, monster }))],
    (entry) => entry.name.toLowerCase()
  )
    .slice(0, 6)
    .map((entry, idx) => ({
      id: `encounter-${slugify(bookTitle)}-${idx + 1}`,
      name: entry.name,
      bookTitle,
      difficulty: ["Easy", "Medium", "Hard"][idx % 3],
      monsters: uniqueNames([entry.monster || monsterPool[idx % Math.max(monsterPool.length, 1)] || "Bandit Scout"]).slice(0, 3),
      summary: `Escalation beats for ${entry.name} built from ${bookTitle}.`,
      keywords: uniqueNames([entry.name, ...(entry.monster ? [entry.monster] : []), ...monsterPool.slice(0, 2)])
    }));

  indexes.npcs = npcPool.slice(0, 8).map((name, idx) => ({
    id: `npc-${slugify(bookTitle)}-${idx + 1}`,
    name,
    role: inferRoleFromName(name),
    summary: `${name} carries a table-facing agenda inside ${bookTitle}.`,
    keywords: uniqueNames([name, inferRoleFromName(name), ...(locationPool[idx % Math.max(locationPool.length, 1)] ? [locationPool[idx % locationPool.length]] : [])])
  }));

  indexes.items = itemPool.slice(0, 8).map((name, idx) => ({
    id: `item-${slugify(bookTitle)}-${idx + 1}`,
    name,
    kind: "item",
    summary: `${name} can be seeded as loot or a plot key.`,
    keywords: uniqueNames([name, "loot", "reward"])
  }));

  indexes.rules = ruleNames.slice(0, 8).map((name, idx) => ({
    id: `rule-${slugify(bookTitle)}-${idx + 1}`,
    name,
    summary: `${name} should be surfaced when adjudicating this homebrew.`,
    keywords: uniqueNames([name, "rule", "mechanic"])
  }));

  indexes.starterOptions = uniqueObjects(
    entities.classes.slice(0, 6).map((className, idx) => ({
      id: `starter-${slugify(bookTitle)}-${idx + 1}`,
      className,
      hook: hooks[idx % Math.max(hooks.length, 1)] || `Tie ${className} directly into the opening pressure point.`,
      spell: entities.spells[idx % Math.max(entities.spells.length, 1)] || null,
      keywords: uniqueNames([className, ...(entities.spells[idx % Math.max(entities.spells.length, 1)] ? [entities.spells[idx % entities.spells.length]] : [])])
    })),
    (entry) => entry.className.toLowerCase()
  );

  return indexes;
}

function parseCanonicalJson(file, parsedValue) {
  const validation = validateHomebrewJsonDocument(parsedValue);
  if (!validation.ok) {
    throw new Error(validation.errors.join(" "));
  }

  const normalized = validation.normalized;
  const entities = {
    classes: uniqueNames(normalized.entities.classes),
    monsters: uniqueNames(normalized.entities.monsters),
    spells: uniqueNames(normalized.entities.spells),
    npcs: uniqueNames(normalized.entities.npcs),
    locations: uniqueNames(normalized.entities.locations)
  };

  const book = {
    title: normalized.book.title || titleFromFileName(file.name),
    type: "Homebrew",
    tags: uniqueNames(["imported", "homebrew", "json", ...(normalized.book.tags || [])]),
    chapters: uniqueNames(normalized.book.chapters).length > 0 ? uniqueNames(normalized.book.chapters).slice(0, 20) : ["Overview", "Rules", "Creatures"]
  };

  return {
    book,
    entities,
    indexes: buildIndexes({
      bookTitle: book.title,
      entities,
      chapters: book.chapters,
      text: `${book.chapters.join("\n")}\n${entities.npcs.join("\n")}\n${entities.locations.join("\n")}`
    }),
    warnings: validation.warnings,
    canonical: true
  };
}

function parseLegacyJson(file, parsed) {
  const entities = newEntityShape();
  const chapters = [];
  const tags = ["imported", "homebrew", "json", "legacy"];
  const items = [];
  const encounters = [];
  const rules = [];

  function absorbEntityArray(target, input) {
    if (!Array.isArray(input)) {
      return;
    }
    for (const entry of input) {
      if (typeof entry === "string") {
        target.push(entry);
      } else if (entry && typeof entry === "object") {
        target.push(entry.name || entry.title || "");
      }
    }
  }

  absorbEntityArray(entities.classes, parsed.classes);
  absorbEntityArray(entities.monsters, parsed.monsters || parsed.creatures || parsed.enemies);
  absorbEntityArray(entities.spells, parsed.spells);
  absorbEntityArray(entities.npcs, parsed.npcs || parsed.characters);
  absorbEntityArray(entities.locations, parsed.locations || parsed.regions);
  absorbEntityArray(chapters, parsed.chapters || parsed.sections);
  absorbEntityArray(items, parsed.items || parsed.loot || parsed.rewards);
  absorbEntityArray(encounters, parsed.encounters || parsed.battles);
  absorbEntityArray(rules, parsed.rules || parsed.mechanics || parsed.hazards);

  if (Array.isArray(parsed.entries)) {
    for (const entry of parsed.entries) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const type = String(entry.type || "").toLowerCase();
      const name = entry.name || entry.title || "";
      if (!name) {
        continue;
      }
      if (type.includes("class")) {
        entities.classes.push(name);
      } else if (type.includes("monster") || type.includes("creature") || type.includes("enemy")) {
        entities.monsters.push(name);
      } else if (type.includes("spell")) {
        entities.spells.push(name);
      } else if (type.includes("npc") || type.includes("character")) {
        entities.npcs.push(name);
      } else if (type.includes("location") || type.includes("region") || type.includes("city")) {
        entities.locations.push(name);
      } else if (type.includes("item") || type.includes("loot") || type.includes("reward")) {
        items.push(name);
      } else if (type.includes("encounter") || type.includes("battle")) {
        encounters.push(name);
      } else if (type.includes("rule") || type.includes("mechanic") || type.includes("hazard")) {
        rules.push(name);
      }
    }
  }

  const book = {
    title: titleFromFileName(file.name),
    type: "Homebrew",
    tags,
    chapters: uniqueNames(chapters).length > 0 ? uniqueNames(chapters).slice(0, 20) : ["Overview", "Rules", "Creatures"]
  };

  const normalizedEntities = {
    classes: uniqueNames(entities.classes),
    monsters: uniqueNames(entities.monsters),
    spells: uniqueNames(entities.spells),
    npcs: uniqueNames(entities.npcs),
    locations: uniqueNames(entities.locations)
  };

  const indexes = buildIndexes({
    bookTitle: book.title,
    entities: normalizedEntities,
    chapters: book.chapters,
    text: `${book.chapters.join("\n")}\n${items.join("\n")}\n${encounters.join("\n")}\n${rules.join("\n")}`
  });

  indexes.items = uniqueObjects(
    [...indexes.items, ...uniqueNames(items).map((name, idx) => ({
      id: `item-${slugify(book.title)}-legacy-${idx + 1}`,
      name,
      kind: "item",
      summary: `${name} imported from legacy JSON.`,
      keywords: uniqueNames([name, "legacy", "loot"])
    }))],
    (entry) => entry.name.toLowerCase()
  );
  indexes.encounters = uniqueObjects(
    [...indexes.encounters, ...uniqueNames(encounters).map((name, idx) => ({
      id: `encounter-${slugify(book.title)}-legacy-${idx + 1}`,
      name,
      bookTitle: book.title,
      difficulty: "Medium",
      monsters: normalizedEntities.monsters.slice(0, 2),
      summary: `${name} imported from legacy JSON.`,
      keywords: uniqueNames([name, ...normalizedEntities.monsters.slice(0, 2)])
    }))],
    (entry) => entry.name.toLowerCase()
  );
  indexes.rules = uniqueObjects(
    [...indexes.rules, ...uniqueNames(rules).map((name, idx) => ({
      id: `rule-${slugify(book.title)}-legacy-${idx + 1}`,
      name,
      summary: `${name} imported from legacy JSON.`,
      keywords: uniqueNames([name, "legacy", "rule"])
    }))],
    (entry) => entry.name.toLowerCase()
  );

  return {
    book,
    entities: normalizedEntities,
    indexes,
    warnings: ["Using legacy JSON parser mode. Prefer canonical schemaVersion 1.0."],
    canonical: false
  };
}

function parseJsonDocument(file) {
  const parsed = JSON.parse(file.content);
  if (isCanonicalHomebrewJson(parsed)) {
    return parseCanonicalJson(file, parsed);
  }

  return parseLegacyJson(file, parsed);
}

function parseTextDocument(file) {
  const text = String(file.content || "");
  const loweredName = String(file.name || "").toLowerCase();

  const entities = {
    classes: extractByRegex(text, /(?:^|\n)\s*(?:class|subclass)\s*[:\-]\s*([A-Za-z][A-Za-z0-9'()\- ]{1,80})/gi),
    monsters: extractByRegex(text, /(?:^|\n)\s*(?:monster|creature|enemy)\s*[:\-]\s*([A-Za-z][A-Za-z0-9'()\- ]{1,80})/gi),
    spells: extractByRegex(text, /(?:^|\n)\s*(?:spell)\s*[:\-]\s*([A-Za-z][A-Za-z0-9'()\- ]{1,80})/gi),
    npcs: extractByRegex(text, /(?:^|\n)\s*(?:npc|character)\s*[:\-]\s*([A-Za-z][A-Za-z0-9'()\- ]{1,80})/gi),
    locations: extractByRegex(text, /(?:^|\n)\s*(?:location|region|city|town)\s*[:\-]\s*([A-Za-z][A-Za-z0-9'()\- ]{1,80})/gi)
  };

  const chapters = extractChapters(text);
  const tags = ["imported", "homebrew", loweredName.endsWith(".md") ? "markdown" : "text"];
  const warnings = [];
  if (entityTotal(entities) === 0) {
    warnings.push("No tagged entities found in text. Use markers like 'Monster: Name' and 'Spell: Name'.");
  }
  if (chapters.length === 0) {
    warnings.push("No markdown headers or chapter markers found.");
  }

  const book = {
    title: titleFromFileName(file.name),
    type: "Homebrew",
    tags,
    chapters: chapters.length > 0 ? chapters : ["Overview", "Rules", "Creatures", "Adventure Hooks"]
  };

  return {
    book,
    entities,
    indexes: buildIndexes({
      bookTitle: book.title,
      entities,
      chapters: book.chapters,
      text
    }),
    warnings,
    canonical: false
  };
}

function mergeEntities(target, source) {
  return {
    classes: uniqueNames([...(target.classes || []), ...(source.classes || [])]),
    monsters: uniqueNames([...(target.monsters || []), ...(source.monsters || [])]),
    spells: uniqueNames([...(target.spells || []), ...(source.spells || [])]),
    npcs: uniqueNames([...(target.npcs || []), ...(source.npcs || [])]),
    locations: uniqueNames([...(target.locations || []), ...(source.locations || [])])
  };
}

function mergeIndexes(target, source) {
  return {
    chapters: uniqueObjects([...(target.chapters || []), ...(source.chapters || [])], (entry) => `${entry.bookTitle}:${entry.title}`),
    scenes: uniqueObjects([...(target.scenes || []), ...(source.scenes || [])], (entry) => `${entry.bookTitle}:${entry.name}`),
    encounters: uniqueObjects([...(target.encounters || []), ...(source.encounters || [])], (entry) => `${entry.bookTitle}:${entry.name}`),
    npcs: uniqueObjects([...(target.npcs || []), ...(source.npcs || [])], (entry) => `${entry.name}:${entry.role}`),
    items: uniqueObjects([...(target.items || []), ...(source.items || [])], (entry) => entry.name),
    rules: uniqueObjects([...(target.rules || []), ...(source.rules || [])], (entry) => entry.name),
    starterOptions: uniqueObjects([...(target.starterOptions || []), ...(source.starterOptions || [])], (entry) => entry.className)
  };
}

export function parseHomebrewDocuments(files = []) {
  const parsedBooks = [];
  let parsedEntities = newEntityShape();
  let parsedIndexes = newIndexShape();
  const diagnostics = [];

  for (const file of files) {
    if (!file || typeof file !== "object") {
      continue;
    }

    const name = String(file.name || "homebrew.txt");
    const content = String(file.content || "");
    const isJson = name.toLowerCase().endsWith(".json");

    try {
      const parsed = isJson ? parseJsonDocument({ name, content }) : parseTextDocument({ name, content });

      parsedBooks.push(parsed.book);
      parsedEntities = mergeEntities(parsedEntities, parsed.entities);
      parsedIndexes = mergeIndexes(parsedIndexes, parsed.indexes || newIndexShape());

      const docConfidence = computeDocumentConfidence({
        mode: isJson ? "json" : "text",
        canonical: Boolean(parsed.canonical),
        chaptersCount: parsed.book.chapters.length,
        entitiesCount: entityTotal(parsed.entities),
        warningsCount: parsed.warnings.length,
        failed: false
      });

      diagnostics.push({
        name,
        mode: isJson ? "json" : "text",
        status: "ok",
        canonical: Boolean(parsed.canonical),
        warnings: parsed.warnings,
        confidence: docConfidence
      });
    } catch (error) {
      const docConfidence = computeDocumentConfidence({
        mode: isJson ? "json" : "text",
        canonical: false,
        chaptersCount: 0,
        entitiesCount: 0,
        warningsCount: 1,
        failed: true
      });

      diagnostics.push({
        name,
        mode: isJson ? "json" : "text",
        status: "failed",
        canonical: false,
        warnings: [],
        error: String(error.message || error),
        confidence: docConfidence
      });
    }
  }

  const summary = {
    documents: files.length,
    books: parsedBooks.length,
    classes: parsedEntities.classes.length,
    monsters: parsedEntities.monsters.length,
    spells: parsedEntities.spells.length,
    npcs: parsedEntities.npcs.length,
    locations: parsedEntities.locations.length,
    chapters: parsedIndexes.chapters.length,
    scenes: parsedIndexes.scenes.length,
    encounters: parsedIndexes.encounters.length,
    items: parsedIndexes.items.length,
    rules: parsedIndexes.rules.length,
    starterOptions: parsedIndexes.starterOptions.length
  };

  const scored = diagnostics.filter((entry) => entry.status === "ok");
  const avgScore = scored.length > 0 ? Math.round(scored.reduce((sum, entry) => sum + entry.confidence.score, 0) / scored.length) : 0;
  const failedCount = diagnostics.filter((entry) => entry.status === "failed").length;

  const confidenceWarnings = [];
  if (failedCount > 0) {
    confidenceWarnings.push(`${failedCount} file(s) failed to parse.`);
  }
  if (avgScore < 60) {
    confidenceWarnings.push("Low parse confidence. Review extracted entities before launch.");
  }
  if (summary.monsters === 0) {
    confidenceWarnings.push("No monsters extracted; encounter generation may be generic.");
  }
  if (summary.scenes === 0) {
    confidenceWarnings.push("No scene scaffolds extracted; quickstart scenes will be synthetic.");
  }

  return {
    books: parsedBooks,
    entities: parsedEntities,
    indexes: parsedIndexes,
    summary,
    confidence: {
      score: avgScore,
      band: confidenceBand(avgScore),
      warnings: confidenceWarnings
    },
    diagnostics
  };
}
