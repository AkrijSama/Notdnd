export function tokenFromRequest(req) {
  const auth = String(req.headers.authorization || "").trim();
  if (auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }
  return null;
}

export function tokenFromUrl(req) {
  const baseUrl = `http://${req.headers.host || "localhost"}`;
  const url = new URL(req.url || "/", baseUrl);
  const token = url.searchParams.get("token");
  return token ? String(token).trim() : null;
}
