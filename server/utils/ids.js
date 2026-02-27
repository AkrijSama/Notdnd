export function uid(prefix = "id") {
  const random = Math.random().toString(36).slice(2, 9);
  const stamp = Date.now().toString(36);
  return `${prefix}_${stamp}_${random}`;
}
