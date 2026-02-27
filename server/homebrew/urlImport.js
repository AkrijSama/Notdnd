const MAX_IMPORT_BYTES = Number(process.env.NOTDND_IMPORT_MAX_BYTES || 1_200_000);

function assertAllowedProtocol(url) {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http and https URLs are supported.");
  }
}

export function validateImportUrl(rawUrl) {
  const value = String(rawUrl || "").trim();
  if (!value) {
    throw new Error("url is required");
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Invalid URL.");
  }

  assertAllowedProtocol(parsed);
  return parsed;
}

export async function fetchHomebrewUrl(url, { fetchImpl = fetch } = {}) {
  const parsed = validateImportUrl(url);

  const response = await fetchImpl(parsed.toString(), {
    method: "GET",
    headers: {
      "User-Agent": "notdnd-import/1.0",
      Accept: "application/json,text/plain,text/markdown,text/*,*/*"
    },
    signal: AbortSignal.timeout(12_000)
  });

  if (!response.ok) {
    throw new Error(`Import fetch failed with status ${response.status}`);
  }

  const contentType = String(response.headers.get("content-type") || "").toLowerCase();
  const text = await response.text();

  if (Buffer.byteLength(text, "utf8") > MAX_IMPORT_BYTES) {
    throw new Error(`Remote document too large (max ${MAX_IMPORT_BYTES} bytes).`);
  }

  const pathname = parsed.pathname || "/import.txt";
  const fileName = pathname.split("/").filter(Boolean).pop() || "import.txt";

  return {
    sourceUrl: parsed.toString(),
    file: {
      name: fileName,
      content: text
    },
    contentType
  };
}
