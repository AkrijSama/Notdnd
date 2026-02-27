export const HOMEBREW_SCHEMA_VERSION = "1.0";

function toStringList(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => String(entry || "").trim())
    .filter(Boolean);
}

function normalizeCanonicalDocument(input) {
  const bookInput = input.book || {};
  const entitiesInput = input.entities || {};

  return {
    schemaVersion: String(input.schemaVersion || ""),
    book: {
      title: String(bookInput.title || "").trim(),
      tags: toStringList(bookInput.tags),
      chapters: toStringList(bookInput.chapters)
    },
    entities: {
      classes: toStringList(entitiesInput.classes),
      monsters: toStringList(entitiesInput.monsters),
      spells: toStringList(entitiesInput.spells),
      npcs: toStringList(entitiesInput.npcs),
      locations: toStringList(entitiesInput.locations)
    }
  };
}

export function isCanonicalHomebrewJson(value) {
  return Boolean(value && typeof value === "object" && value.schemaVersion && value.book && value.entities);
}

export function validateHomebrewJsonDocument(value) {
  const errors = [];
  const warnings = [];

  if (!value || typeof value !== "object") {
    errors.push("Document must be a JSON object.");
    return {
      ok: false,
      errors,
      warnings,
      normalized: null
    };
  }

  const normalized = normalizeCanonicalDocument(value);

  if (!normalized.schemaVersion) {
    errors.push("schemaVersion is required.");
  } else if (normalized.schemaVersion !== HOMEBREW_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${HOMEBREW_SCHEMA_VERSION}.`);
  }

  if (!normalized.book.title) {
    errors.push("book.title is required.");
  }

  const entityKeys = ["classes", "monsters", "spells", "npcs", "locations"];
  let totalEntities = 0;
  for (const key of entityKeys) {
    totalEntities += normalized.entities[key].length;
  }

  if (totalEntities === 0) {
    warnings.push("No entities detected in canonical JSON payload.");
  }

  if (normalized.book.chapters.length === 0) {
    warnings.push("book.chapters is empty; using default fallback chapters.");
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    normalized
  };
}
