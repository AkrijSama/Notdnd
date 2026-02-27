import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const port = Number(process.env.E2E_PORT || process.env.PORT || 4274);
const host = process.env.NOTDND_HOST || process.env.HOST || "127.0.0.1";
const baseUrl = `http://${host}:${port}`;
const require = createRequire(import.meta.url);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function locatePlaywrightEntry() {
  if (process.env.PLAYWRIGHT_ENTRY && fs.existsSync(process.env.PLAYWRIGHT_ENTRY)) {
    return process.env.PLAYWRIGHT_ENTRY;
  }

  const home = os.homedir();
  const npxRoot = path.join(home, ".npm", "_npx");
  const candidates = [];
  if (fs.existsSync(npxRoot)) {
    for (const entry of fs.readdirSync(npxRoot)) {
      const candidate = path.join(npxRoot, entry, "node_modules", "playwright", "index.js");
      if (fs.existsSync(candidate)) {
        candidates.push(candidate);
      }
    }
  }

  const globals = [
    "/usr/lib/node_modules/playwright/index.js",
    "/usr/local/lib/node_modules/playwright/index.js"
  ].filter((entry) => fs.existsSync(entry));
  candidates.push(...globals);

  if (candidates.length === 0) {
    throw new Error("Could not locate Playwright package. Run `npx playwright --version` once or set PLAYWRIGHT_ENTRY.");
  }

  candidates.sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs);
  return candidates[0];
}

const playwright = require(locatePlaywrightEntry());
const { chromium } = playwright;

function locateBrowserExecutable() {
  const candidates = [
    process.env.GOOGLE_CHROME_BIN,
    process.env.CHROME_BIN,
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser"
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

async function request(pathname, { method = "GET", token = "", body } = {}) {
  const headers = {};
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const payload = await response.json();
  if (!response.ok || payload.ok === false) {
    throw new Error(`${method} ${pathname} failed: ${payload.error || response.status}`);
  }
  return payload;
}

async function waitForHealth(timeoutMs = 15000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const health = await request("/api/health");
      if (health.ok) {
        return health;
      }
    } catch {
      // keep retrying until server is ready
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Server did not become healthy at ${baseUrl} within ${timeoutMs}ms`);
}

async function waitForText(page, selector, text, timeoutMs = 15000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const content = (await page.locator(selector).textContent()) || "";
    if (content.includes(text)) {
      return content;
    }
    await page.waitForTimeout(250);
  }
  throw new Error(`Timed out waiting for text \"${text}\" in ${selector}`);
}

async function waitForCount(page, selector, expectedMin, timeoutMs = 15000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const count = await page.locator(selector).count();
    if (count >= expectedMin) {
      return count;
    }
    await page.waitForTimeout(250);
  }
  throw new Error(`Timed out waiting for at least ${expectedMin} matches for ${selector}`);
}

async function fillWhenStable(page, selector, value, timeoutMs = 15000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const locator = page.locator(selector).first();
      await locator.waitFor({ state: "visible", timeout: 2000 });
      await locator.fill(value, { timeout: 2000 });
      return;
    } catch (error) {
      if (!String(error.message || error).toLowerCase().includes("detached")) {
        await page.waitForTimeout(200);
      } else {
        await page.waitForTimeout(250);
      }
    }
  }
  throw new Error(`Timed out filling stable locator ${selector}`);
}

async function bootstrapPage(page, signedInText = "Signed in: Demo GM") {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitForText(page, "body", "API: Connected");
  await waitForText(page, "body", signedInText);
  await waitForText(page, "body", "Realtime: Connected");
}

async function runGmRuntimeScenario(page) {
  await bootstrapPage(page);
  await page.click('[data-tab="ai"]');
  await waitForText(page, "#active-module", "GM Runtime");
  await waitForCount(page, '[data-memory-doc="timeline"]', 1);
  await page.waitForTimeout(750);

  await fillWhenStable(page, '[data-memory-doc="timeline"]', "# Shared Timeline\n\n## Session Update\nThe ember key was recovered beneath the harbor.\n");
  await page.click('[data-save-memory="timeline"]');
  await waitForText(page, "#gm-runtime-status", "timeline.md saved.");

  await page.fill('#gm-memory-search-form input[name="query"]', "ember key harbor");
  await page.click('#gm-memory-search-form button');
  await waitForText(page, "#active-module", "ember key");

  await bootstrapPage(page);
  await page.click('[data-tab="ai"]');
  await waitForText(page, "#active-module", "GM Runtime");
  await page.waitForTimeout(750);

  await page.selectOption('#gm-settings-form select[name="gmMode"]', "human");
  await page.selectOption('#gm-settings-form select[name="agentProvider"]', "local");
  await page.fill('#gm-settings-form input[name="agentModel"]', "local-gm-v1");
  await page.click('#gm-settings-form button[type="submit"]');
  await waitForText(page, "#gm-runtime-status", "GM runtime settings updated.");

  await page.fill('#gm-chat-form input[name="message"]', "Need pacing help for the ember key reveal.");
  await page.click('#gm-chat-form button[type="submit"]');
  await waitForText(page, "#gm-runtime-status", "response ready via local/");
  await waitForText(page, ".chat", "GM Copilot");

  await page.selectOption('#gm-settings-form select[name="gmMode"]', "agent");
  await page.click('#gm-settings-form button[type="submit"]');
  await waitForText(page, "#gm-runtime-status", "GM runtime settings updated.");
  await page.fill('#gm-chat-form input[name="message"]', "What does the ember key unlock?");
  await page.click('#gm-chat-form button[type="submit"]');
  await waitForText(page, "#gm-runtime-status", "response ready via local/");
  await waitForText(page, ".chat", "Agent GM");
}

async function runQuickstartRealtimeScenario(browser, page, ownerToken) {
  await bootstrapPage(page);
  await page.click('[data-tab="forge"]');
  await waitForText(page, "#active-module", "5-Minute Homebrew Quickstart");

  await page.fill('input[name="quickName"]', "E2E Harbor Run");
  await page.fill('input[name="quickSetting"]', "Storm Coast");
  await page.fill('input[name="quickPlayers"]', "Kai, Rune");
  await page.setInputFiles("#quickstart-files", {
    name: "e2e-homebrew.md",
    mimeType: "text/markdown",
    buffer: Buffer.from(
      "# Harbor Siege\nLocation: Drowned Harbor\nNPC: Captain Vey\nMonster: Harbor Ghoul\nSpell: Salt Ward\nItem: Tideglass Key\nEncounter: Harbor Ambush\nRule: Flood Clock\nHook: Save the lighthouse before the tide peaks.",
      "utf8"
    )
  });

  await page.click("#quickstart-parse");
  await waitForText(page, "#quickstart-status", "Parse complete.");

  await page.click("#quickstart-submit");
  await waitForText(page, "#active-module", "VTT Table");
  const optionCount = await waitForCount(page, "#active-map-select option", 2);
  assert(optionCount >= 2, "Expected at least two VTT scene options");
  await waitForText(page, "body", "Presence: 1");

  const state = await request("/api/state", { token: ownerToken });
  const selectedCampaignId = state.state.selectedCampaignId;
  assert(selectedCampaignId, "selected campaign missing after quickstart build");

  const uniqueEmail = `e2e-player-${Date.now()}@example.com`;
  const register = await request("/api/auth/register", {
    method: "POST",
    body: {
      email: uniqueEmail,
      password: "Password123",
      displayName: "E2E Player"
    }
  });
  await request("/api/campaign/members", {
    method: "POST",
    token: ownerToken,
    body: {
      campaignId: selectedCampaignId,
      email: uniqueEmail,
      role: "player"
    }
  });

  const secondContext = await browser.newContext();
  await secondContext.addInitScript((tokenValue) => {
    localStorage.setItem("notdnd_auth_token_v1", tokenValue);
  }, register.token);
  const secondPage = await secondContext.newPage();
  await bootstrapPage(secondPage, "Signed in: E2E Player");
  await secondPage.click('[data-tab="vtt"]');
  await waitForText(secondPage, "#active-module", "VTT Table");

  await waitForText(page, "body", "Presence: 2");
  await waitForText(secondPage, "body", "Presence: 2");

  await secondPage.locator("#map-board").hover({ position: { x: 60, y: 60 } });
  await waitForCount(page, "#map-board .tag", 1);
  await secondContext.close();
}

async function main() {
  const server = spawn(process.execPath, ["scripts/start-test-server.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      NOTDND_HOST: host
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";
  server.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  server.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  let browser;
  try {
    await waitForHealth();
    const executablePath = locateBrowserExecutable();
    browser = await chromium.launch(
      executablePath
        ? { headless: true, executablePath }
        : { headless: true, channel: "chrome" }
    );
    const context = await browser.newContext();
    const page = await context.newPage();
    const ownerLogin = await request("/api/auth/login", {
      method: "POST",
      body: { email: "demo@notdnd.local", password: "demo1234" }
    });

    await runGmRuntimeScenario(page);
    await runQuickstartRealtimeScenario(browser, page, ownerLogin.token);

    console.log(JSON.stringify({
      ok: true,
      baseUrl,
      scenarios: ["gm-runtime", "quickstart-realtime"]
    }, null, 2));
  } finally {
    if (browser) {
      await browser.close();
    }
    if (!server.killed) {
      server.kill("SIGTERM");
    }
    await new Promise((resolve) => server.once("exit", resolve));
    if (stderr.trim()) {
      process.stderr.write(stderr);
    }
    if (stdout.trim()) {
      process.stdout.write(stdout);
    }
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
