/**
 * One-shot version bump across package manifests and plugin files.
 * Usage: node scripts/sync-version.mjs 0.4.0
 *
 * Also refreshes package-lock.json so `npm ci` stays consistent.
 * After running: npm run release:check
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+/.test(version)) {
  console.error("Usage: node scripts/sync-version.mjs <semver>");
  process.exit(1);
}

function updateJson(file, mutator) {
  const p = path.join(root, file);
  if (!fs.existsSync(p)) return;
  const j = JSON.parse(fs.readFileSync(p, "utf8"));
  mutator(j);
  fs.writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
  console.log("updated", file);
}

updateJson("package.json", (j) => {
  j.version = version;
});

for (const rel of [
  "packages/cli/package.json",
  "packages/core/package.json",
  "packages/scanner/package.json",
  "packages/state-manager/package.json",
  "packages/git-sync/package.json",
  "packages/recipe-engine/package.json",
  "drivers/package.json",
]) {
  updateJson(rel, (j) => {
    j.version = version;
    if (j.dependencies) {
      for (const k of Object.keys(j.dependencies)) {
        if (k.startsWith("@ai-config-sync/")) j.dependencies[k] = version;
      }
    }
  });
}

updateJson(".claude-plugin/marketplace.json", (j) => {
  if (j.metadata) j.metadata.version = version;
  if (Array.isArray(j.plugins)) {
    for (const p of j.plugins) p.version = version;
  }
});

updateJson("integrations/claude-plugin/.claude-plugin/plugin.json", (j) => {
  j.version = version;
});

const readme = path.join(root, "README.md");
if (fs.existsSync(readme)) {
  let t = fs.readFileSync(readme, "utf8");
  t = t.replace(/v\d+\.\d+\.\d+/g, `v${version}`);
  t = t.replace(/版本 \*\*\d+\.\d+\.\d+\*\*/g, `版本 **${version}**`);
  fs.writeFileSync(readme, t);
  console.log("updated README.md version refs");
}

console.log("Refreshing package-lock.json…");
const lock = spawnSync("npm", ["install", "--package-lock-only"], {
  cwd: root,
  encoding: "utf8",
  shell: process.platform === "win32",
});
if (lock.status !== 0) {
  console.error(lock.stdout || "");
  console.error(lock.stderr || "");
  console.error("Failed to refresh package-lock.json");
  process.exit(1);
}
console.log("updated package-lock.json");

console.log("Synced version →", version);
console.log("Next: npm run release:check  (build + version check + tests)");
