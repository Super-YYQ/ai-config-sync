/**
 * Verify all version sources agree with root package.json.
 * Usage: node scripts/check-version-consistency.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const expected = String(pkg.version);
const errors = [];

function checkJson(rel, pick) {
  const p = path.join(root, rel);
  if (!fs.existsSync(p)) {
    errors.push(`missing ${rel}`);
    return;
  }
  const j = JSON.parse(fs.readFileSync(p, "utf8"));
  const v = pick(j);
  if (v !== expected) errors.push(`${rel}: ${v} !== ${expected}`);
}

checkJson("package.json", (j) => j.version);
checkJson("packages/cli/package.json", (j) => j.version);
checkJson("packages/core/package.json", (j) => j.version);
checkJson("packages/scanner/package.json", (j) => j.version);
checkJson("packages/state-manager/package.json", (j) => j.version);
checkJson("packages/git-sync/package.json", (j) => j.version);
checkJson("packages/recipe-engine/package.json", (j) => j.version);
checkJson("drivers/package.json", (j) => j.version);
checkJson(
  "integrations/claude-plugin/.claude-plugin/plugin.json",
  (j) => j.version,
);
checkJson(".claude-plugin/marketplace.json", (j) => j.metadata?.version);

// package-lock root
const lockPath = path.join(root, "package-lock.json");
if (fs.existsSync(lockPath)) {
  const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  if (lock.version !== expected) {
    errors.push(`package-lock.json version: ${lock.version} !== ${expected}`);
  }
  const rootPkg = lock.packages?.[""];
  if (rootPkg && rootPkg.version && rootPkg.version !== expected) {
    errors.push(
      `package-lock packages[""].version: ${rootPkg.version} !== ${expected}`,
    );
  }
} else {
  errors.push("package-lock.json missing");
}

// README status line
const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
if (!readme.includes(`v${expected}`)) {
  errors.push(`README.md missing v${expected}`);
}

// Bundled CLI --version if built
const distCli = path.join(root, "dist", "ai-config-sync.cjs");
if (fs.existsSync(distCli)) {
  const r = spawnSync(process.execPath, [distCli, "--version"], {
    encoding: "utf8",
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const m = out.match(/(\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?)/);
  if (!m || m[1] !== expected) {
    errors.push(`dist CLI --version: ${out.trim()} !== ${expected}`);
  }
}

if (errors.length) {
  console.error("Version consistency FAILED:");
  for (const e of errors) console.error(" -", e);
  process.exit(1);
}
console.log(`Version consistency OK: ${expected}`);
