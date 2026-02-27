export function uid(prefix = "id") {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}_${rand}`;
}

export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

export function titleCase(input) {
  return String(input)
    .split(" ")
    .filter(Boolean)
    .map((chunk) => chunk[0].toUpperCase() + chunk.slice(1).toLowerCase())
    .join(" ");
}

export function parseList(input) {
  return String(input)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function safeJsonParse(content, fallback) {
  try {
    return JSON.parse(content);
  } catch {
    return fallback;
  }
}

export function formatNow() {
  const dt = new Date();
  return `${dt.toLocaleDateString()} ${dt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}
