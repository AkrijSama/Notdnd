import { isCanonicalHomebrewJson, validateHomebrewJsonDocument } from "./schema.js";

function normalizeName(value) {
  return String(value || "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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

function newEntityShape() {
  return {
    classes: [],
    monsters: [],
    spells: [],
    npcs: [],
    locations: []
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

  return {
    book: {
      title: normalized.book.title || titleFromFileName(file.name),
      type: "Homebrew",
      tags: uniqueNames(["imported", "homebrew", "json", ...(normalized.book.tags || [])]),
      chapters: uniqueNames(normalized.book.chapters).length > 0 ? uniqueNames(normalized.book.chapters).slice(0, 20) : ["Overview", "Rules", "Creatures"]
    },
    entities,
    warnings: validation.warnings,
    canonical: true
  };
}

function parseLegacyJson(file, parsed) {
  const entities = newEntityShape();
  const chapters = [];
  const tags = ["imported", "homebrew", "json", "legacy"];

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
      }
    }
  }

  return {
    book: {
      title: titleFromFileName(file.name),
      type: "Homebrew",
      tags,
      chapters: uniqueNames(chapters).length > 0 ? uniqueNames(chapters).slice(0, 20) : ["Overview", "Rules", "Creatures"]
    },
    entities: {
      classes: uniqueNames(entities.classes),
      monsters: uniqueNames(entities.monsters),
      spells: uniqueNames(entities.spells),
      npcs: uniqueNames(entities.npcs),
      locations: uniqueNames(entities.locations)
    },
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

  return {
    book: {
      title: titleFromFileName(file.name),
      type: "Homebrew",
      tags,
      chapters: chapters.length > 0 ? chapters : ["Overview", "Rules", "Creatures", "Adventure Hooks"]
    },
    entities,
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

export function parseHomebrewDocuments(files = []) {
  const parsedBooks = [];
  let parsedEntities = newEntityShape();

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
    locations: parsedEntities.locations.length
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

  return {
    books: parsedBooks,
    entities: parsedEntities,
    summary,
    confidence: {
      score: avgScore,
      band: confidenceBand(avgScore),
      warnings: confidenceWarnings
    },
    diagnostics
  };
}
