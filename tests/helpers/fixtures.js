import fs from "node:fs";
import path from "node:path";

const FIXTURE_DIR = path.resolve(process.cwd(), "tests/fixtures/homebrew");
const MANIFEST_PATH = path.join(FIXTURE_DIR, "manifest.json");

export function loadFixtureManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
}

export function loadFixtureFile(name) {
  const filePath = path.join(FIXTURE_DIR, name);
  return {
    name,
    content: fs.readFileSync(filePath, "utf8")
  };
}

export function loadFixturesFromManifest() {
  const manifest = loadFixtureManifest();
  return manifest.map((entry) => ({
    ...entry,
    fileData: loadFixtureFile(entry.file)
  }));
}
