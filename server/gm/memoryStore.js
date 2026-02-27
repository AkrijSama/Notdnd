import fs from "node:fs";
import path from "node:path";

const DOC_FILES = {
  human: "human-gm.md",
  agent: "agent-gm.md",
  timeline: "shared-timeline.md"
};

const DOC_TITLES = {
  human: "Human GM Guide",
  agent: "Agent GM Guide",
  timeline: "Shared Timeline"
};

function memoryRoot() {
  return process.env.NOTDND_MEMORY_ROOT
    ? path.resolve(process.env.NOTDND_MEMORY_ROOT)
    : path.resolve(process.cwd(), "server/campaign-memory");
}

function campaignDir(campaignId) {
  return path.join(memoryRoot(), String(campaignId || "unknown-campaign"));
}

function docPath(campaignId, docKey) {
  const fileName = DOC_FILES[docKey];
  if (!fileName) {
    throw new Error(`Unsupported memory doc: ${docKey}`);
  }
  return path.join(campaignDir(campaignId), fileName);
}

function ensureDir(campaignId) {
  fs.mkdirSync(campaignDir(campaignId), { recursive: true });
}

function defaultDocContent(campaignId, docKey) {
  const title = DOC_TITLES[docKey] || docKey;
  return `# ${title}\n\n- Campaign: ${campaignId}\n- Add plot devices, consequences, and new developments here.\n`;
}

function tokenize(value) {
  return String(value || "")
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length >= 3);
}

function unique(values) {
  return [...new Set(values)];
}

function splitMarkdown(content) {
  const source = String(content || "");
  const lines = source.split(/\r?\n/);
  const chunks = [];
  let heading = "Document";
  let buffer = [];

  function pushChunk() {
    const text = buffer.join("\n").trim();
    if (!text) {
      return;
    }
    chunks.push({
      heading,
      text,
      keywords: unique(tokenize(`${heading} ${text}`)).slice(0, 32)
    });
  }

  for (const line of lines) {
    const match = line.match(/^\s{0,3}(#{1,3})\s+(.+)$/);
    if (match) {
      pushChunk();
      heading = match[2].trim();
      buffer = [];
      continue;
    }
    buffer.push(line);
  }

  pushChunk();
  return chunks;
}

function scoreChunk(queryTokens, chunk) {
  const chunkTokenSet = new Set(chunk.keywords || []);
  let score = 0;
  for (const token of queryTokens) {
    if (chunkTokenSet.has(token)) {
      score += token.length >= 7 ? 4 : 2;
    }
    if (String(chunk.heading || "").toLowerCase().includes(token)) {
      score += 3;
    }
    if (String(chunk.text || "").toLowerCase().includes(token)) {
      score += 1;
    }
  }
  return score;
}

export function ensureCampaignMemoryDocs(campaignId, seedDocs = {}) {
  ensureDir(campaignId);
  for (const docKey of Object.keys(DOC_FILES)) {
    const targetPath = docPath(campaignId, docKey);
    if (!fs.existsSync(targetPath)) {
      fs.writeFileSync(targetPath, seedDocs[docKey] || defaultDocContent(campaignId, docKey), "utf8");
    }
  }
}

export function listCampaignMemoryDocs(campaignId) {
  ensureCampaignMemoryDocs(campaignId);
  return Object.keys(DOC_FILES).map((docKey) => {
    const targetPath = docPath(campaignId, docKey);
    const stat = fs.statSync(targetPath);
    return {
      key: docKey,
      title: DOC_TITLES[docKey],
      path: targetPath,
      content: fs.readFileSync(targetPath, "utf8"),
      updatedAt: stat.mtimeMs
    };
  });
}

export function writeCampaignMemoryDoc(campaignId, docKey, content) {
  ensureCampaignMemoryDocs(campaignId);
  const targetPath = docPath(campaignId, docKey);
  fs.writeFileSync(targetPath, String(content || ""), "utf8");
  const stat = fs.statSync(targetPath);
  return {
    key: docKey,
    title: DOC_TITLES[docKey],
    path: targetPath,
    content: fs.readFileSync(targetPath, "utf8"),
    updatedAt: stat.mtimeMs
  };
}

export function searchCampaignMemory(campaignId, query, { docKey = null, limit = 5 } = {}) {
  ensureCampaignMemoryDocs(campaignId);
  const queryTokens = unique(tokenize(query));
  if (queryTokens.length === 0) {
    return [];
  }

  const docs = listCampaignMemoryDocs(campaignId).filter((doc) => !docKey || doc.key === docKey);
  const scored = [];

  for (const doc of docs) {
    for (const chunk of splitMarkdown(doc.content)) {
      const score = scoreChunk(queryTokens, chunk);
      if (score <= 0) {
        continue;
      }
      scored.push({
        docKey: doc.key,
        title: doc.title,
        path: doc.path,
        heading: chunk.heading,
        text: chunk.text.slice(0, 500),
        keywords: chunk.keywords.slice(0, 12),
        score
      });
    }
  }

  return scored.sort((left, right) => right.score - left.score).slice(0, Math.max(1, limit));
}
