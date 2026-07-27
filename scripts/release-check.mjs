/**
 * Full release gate for ai-config-sync (Ticket: complete release:check).
 *
 * Runs, in order, and fails fast on the first broken gate:
 *   1. typecheck             (tsc -b)
 *   2. build                  (npm run build)
 *   3. version consistency    (check-version-consistency)
 *   4. plugin validate        (validate-plugin)
 *   5. unit + integration tests (vitest)
 *   6. npm smoke (package-isolated)
 *   7. pack inspection        (npm pack --dry-run; assert no stray files)
 *   8. secret scan            (scanTextForSecrets over repo text files)
 *   9. git status clean       (no uncommitted/untracked files left behind)
 *
 * Exit non-zero if any gate fails. Usage: node scripts/release-check.mjs
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let failed = false;
const failures = [];

function gate(name, fn) {
  process.stdout.write(`\n=== ${name} ===\n`);
  try {
    const ok = fn();
    if (ok === false) throw new Error(`${name} returned false`);
    process.stdout.write(`OK: ${name}\n`);
  } catch (e) {
    failed = true;
    failures.push(`${name}: ${e.message}`);
    process.stdout.write(`FAIL: ${name} - ${e.message}\n`);
  }
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd: root,
    encoding: "utf8",
    shell: process.platform === "win32",
    stdio: ["ignore", "pipe", "pipe"],
    ...opts,
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  if (r.status !== 0) {
    process.stdout.write(out);
    throw new Error(`${cmd} ${args.join(" ")} exited ${r.status}`);
  }
  return out;
}

// 1. typecheck
gate("typecheck", () => {
  run("npx", ["tsc", "-b", "--pretty", "false"]);
  return true;
});

// 2. build
gate("build", () => {
  run("npm", ["run", "build"]);
  return true;
});

// 3. version consistency
gate("version-consistency", () => {
  run("node", ["scripts/check-version-consistency.mjs"]);
  return true;
});

// 4. plugin validate
gate("plugin-validate", () => {
  run("node", ["scripts/validate-plugin.mjs"]);
  return true;
});

// 5. tests (unit + integration)
gate("tests", () => {
  run("npx", ["vitest", "run"]);
  return true;
});

// 6. npm smoke (package-isolated)
gate("npm-smoke", () => {
  run("node", ["scripts/smoke-npm-package.mjs"]);
  return true;
});

// 7. pack inspection
gate("pack-inspection", () => {
  const out = run("npm", ["pack", "--dry-run", "--json"]);
  // npm pack may print build log lines before/after the JSON array; extract
  // the first '[' through its matching ']' and parse just that.
  const jsonStart = out.indexOf("[");
  if (jsonStart < 0) throw new Error("npm pack --dry-run produced no JSON");
  const jsonEnd = out.lastIndexOf("]");
  if (jsonEnd <= jsonStart) throw new Error("npm pack JSON end not found");
  const jsonText = out.slice(jsonStart, jsonEnd + 1);
  let packs;
  try {
    packs = JSON.parse(jsonText);
  } catch (e) {
    throw new Error(`npm pack JSON parse failed: ${e.message}`);
  }
  const files = (packs[0]?.files ?? []).map((f) => f.path);
  if (!files.length) throw new Error("npm pack produced no files");
  // Must ship dist, integrations, template, marketplace, README, USER_GUIDE
  const required = [
    "dist/ai-config-sync.cjs",
    "integrations/claude-plugin/.claude-plugin/plugin.json",
    "integrations/codex/skills/config-sync/SKILL.md",
    "examples/private-config-template/resources.yaml",
    ".claude-plugin/marketplace.json",
    "README.md",
    "docs/USER_GUIDE.md",
  ];
  const fileSet = new Set(files);
  for (const req of required) {
    if (!fileSet.has(req)) {
      throw new Error(`pack missing required file: ${req}`);
    }
  }
  // Must NOT ship source (src/, tests/) or dev files
  const forbidden = files.filter(
    (f) =>
      f.startsWith("packages/") ||
      f.startsWith("tests/") ||
      f.startsWith("drivers/src/") ||
      f.endsWith(".ts") ||
      f.startsWith("scripts/") ||
      f === "tsconfig.json",
  );
  // Allow .d.ts in dist? dist has no .ts source shipped as .ts. Flag raw .ts.
  const realForbidden = forbidden.filter((f) => !f.endsWith(".d.ts"));
  if (realForbidden.length) {
    throw new Error(
      `pack ships forbidden dev/source files: ${realForbidden.slice(0, 10).join(", ")}`,
    );
  }
  process.stdout.write(`  packed ${files.length} files\n`);
  return true;
});

// 8. secret scan over tracked text files (uses project's scanTextForSecrets)
gate("secret-scan", () => {
  // Use the bundled CLI's secret scan against the config template + docs.
  // We scan all text files under repo (excluding node_modules/dist/.git).
  const { scanTextForSecrets } = loadSecretScanner();
  // Precise allowlist for known false-positive test fixtures (fake tokens).
  const allowlistPath = path.join(root, "scripts", "secret-allowlist.json");
  const allow = JSON.parse(fs.readFileSync(allowlistPath, "utf8"));
  const allowedExact = new Set(allow.allowedExact ?? []);
  const allowedPaths = new Set(
    (allow.allowedPaths ?? []).map((p) => p.replace(/\\/g, "/")),
  );
  const findings = [];
  const skipDirs = new Set([
    "node_modules",
    ".git",
    "dist",
    "coverage",
    ".ai-config-sync",
  ]);
  const skipExt = new Set([
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".ico",
    ".woff",
    ".woff2",
    ".zip",
    ".tgz",
    ".docx",
    ".pdf",
  ]);
  function walk(dir) {
    for (const name of fs.readdirSync(dir)) {
      if (skipDirs.has(name)) continue;
      const full = path.join(dir, name);
      const st = fs.statSync(full);
      if (st.isDirectory()) {
        walk(full);
        continue;
      }
      const rel = path.relative(root, full).replace(/\\/g, "/");
      const ext = path.extname(name).toLowerCase();
      if (skipExt.has(ext)) continue;
      if (st.size > 2 * 1024 * 1024) continue;
      // Skip the allowlist file itself (it literally contains the fake tokens)
      if (rel === "scripts/secret-allowlist.json") continue;
      // Skip allowlisted paths entirely (test fixtures with deliberate fakes)
      if (allowedPaths.has(rel)) continue;
      try {
        const text = fs.readFileSync(full, "utf8");
        const found = scanTextForSecrets(text, rel);
        for (const f of found) {
          // Allow exact known fake tokens
          if (allowedExact.has(f.preview)) continue;
          if (allowedExact.has(`${f.preview}`)) continue;
          findings.push(f);
        }
      } catch {
        /* binary */
      }
    }
  }
  walk(root);
  if (findings.length) {
    const summary = findings
      .slice(0, 10)
      .map((f) => `${f.path}:${f.line} ${f.rule} ${f.preview}`)
      .join("\n  ");
    throw new Error(`secret scan found ${findings.length} finding(s):\n  ${summary}`);
  }
  return true;
});

// 9. git status clean (after all gates, working tree must be clean)
gate("git-status-clean", () => {
  const status = spawnSync("git", ["status", "--porcelain"], {
    cwd: root,
    encoding: "utf8",
  });
  const out = (status.stdout ?? "").trim();
  if (out.length) {
    throw new Error(`git working tree not clean:\n${out}`);
  }
  return true;
});

if (failed) {
  console.error(`\nRELEASE CHECK FAILED:\n${failures.map((f) => " - " + f).join("\n")}`);
  process.exit(1);
}
console.log("\nRELEASE CHECK OK - all gates passed, git tree clean");

function loadSecretScanner() {
  // Prefer built core; fall back to source via tsx-free dynamic require of dist.
  const distCore = path.join(root, "packages", "core", "dist", "index.js");
  if (fs.existsSync(distCore)) {
    return require(distCore);
  }
  throw new Error("core dist not built - run build before release:check");
}
