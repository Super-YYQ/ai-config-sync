/**
 * End-to-end offline demo: vendored planning-with-files → Claude + Codex.
 *
 * Usage (from repo root, after npm run build):
 *   npm run demo:offline-pwf
 *   npm run demo:offline-pwf -- --keep
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const keep = process.argv.includes("--keep");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const template = path.join(root, "examples", "yyq-ai-config-template");
const cli = path.join(root, "packages", "cli", "dist", "index.js");

function banner(title: string) {
  console.log("\n" + "=".repeat(60));
  console.log(title);
  console.log("=".repeat(60));
}

function runCli(home: string, args: string[]): { code: number; out: string } {
  const r = spawnSync(process.execPath, [cli, ...args, "--home", home], {
    encoding: "utf8",
    cwd: root,
    windowsHide: true,
    env: { ...process.env },
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  return { code: r.status ?? 1, out };
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  if (!(await pathExists(cli))) {
    console.error("CLI not built. Run: npm run build");
    process.exitCode = 1;
    return;
  }

  const home = await fs.mkdtemp(path.join(os.tmpdir(), "acs-pwf-demo-"));
  const configRepo = path.join(home, "yyq-ai-config");
  await fs.cp(template, configRepo, { recursive: true });

  banner("1) setup --profile offline-demo");
  console.log(`HOME (isolated): ${home}`);
  console.log(`Config repo:     ${configRepo}`);
  let r = runCli(home, [
    "setup",
    "--config-path",
    configRepo,
    "--profile",
    "offline-demo",
  ]);
  console.log(r.out.trim());
  if (r.code !== 0) process.exitCode = 1;

  banner("2) plan --offline (vendored planning-with-files only)");
  r = runCli(home, ["plan", "--profile", "offline-demo"]);
  // plan doesn't have --offline flag on CLI — sources are local vendored so OK
  console.log(r.out.trim());

  banner("3) apply --yes --allow-risk medium --offline");
  r = runCli(home, [
    "apply",
    "--profile",
    "offline-demo",
    "--yes",
    "--allow-risk",
    "medium",
    "--offline",
  ]);
  console.log(r.out.trim());
  if (r.code !== 0) process.exitCode = 1;

  banner("4) verify files on disk");
  const claudeSkill = path.join(
    home,
    ".claude",
    "skills",
    "planning-with-files",
    "SKILL.md",
  );
  const codexSkill = path.join(
    home,
    ".codex",
    "skills",
    "planning-with-files",
    "SKILL.md",
  );
  const hooksJson = path.join(home, ".codex", "hooks.json");
  const configToml = path.join(home, ".codex", "config.toml");
  const hookScripts = path.join(
    home,
    ".codex",
    "hooks",
    "planning-with-files",
  );

  const checks: Array<[string, boolean]> = [
    ["Claude skill", await pathExists(claudeSkill)],
    ["Codex skill", await pathExists(codexSkill)],
    ["Codex hooks.json", await pathExists(hooksJson)],
    ["Codex config.toml", await pathExists(configToml)],
    ["Codex hook scripts dir", await pathExists(hookScripts)],
  ];
  for (const [label, ok] of checks) {
    console.log(`${ok ? "✓" : "✗"} ${label}: ${label.includes("skill") || label.includes("hooks") || label.includes("config") ? "" : ""}`.replace(/: $/, ""));
    if (!ok) process.exitCode = 1;
  }
  // print paths
  for (const [label, ok] of checks) {
    if (ok) {
      const p =
        label === "Claude skill"
          ? claudeSkill
          : label === "Codex skill"
            ? codexSkill
            : label === "Codex hooks.json"
              ? hooksJson
              : label === "Codex config.toml"
                ? configToml
                : hookScripts;
      console.log(`  → ${p}`);
    }
  }

  if (await pathExists(claudeSkill)) {
    console.log("\n--- Claude SKILL.md ---");
    console.log(await fs.readFile(claudeSkill, "utf8"));
  }
  if (await pathExists(codexSkill)) {
    console.log("--- Codex SKILL.md ---");
    console.log(await fs.readFile(codexSkill, "utf8"));
  }
  if (await pathExists(hooksJson)) {
    console.log("--- Codex hooks.json ---");
    console.log(await fs.readFile(hooksJson, "utf8"));
  }
  if (await pathExists(configToml)) {
    console.log("--- Codex config.toml ---");
    console.log(await fs.readFile(configToml, "utf8"));
  }

  if ((await pathExists(claudeSkill)) && (await pathExists(codexSkill))) {
    await fs.appendFile(claudeSkill, "\n<!-- claude-local-edit -->\n", "utf8");
    const codexBody = await fs.readFile(codexSkill, "utf8");
    console.log(
      `Independent copies: Codex skill ${
        codexBody.includes("claude-local-edit")
          ? "POLLUTED (bad)"
          : "untouched (good)"
      }`,
    );
  }

  banner("5) second apply (expect SKIP for in-sync targets)");
  r = runCli(home, [
    "apply",
    "--profile",
    "offline-demo",
    "--yes",
    "--allow-risk",
    "medium",
    "--offline",
  ]);
  console.log(r.out.trim());

  banner("6) drift + doctor");
  r = runCli(home, ["drift"]);
  console.log(r.out.trim());
  r = runCli(home, ["doctor"]);
  console.log(r.out.trim());

  banner("Done");
  if (keep) {
    console.log(`Kept isolated HOME at:\n  ${home}`);
    console.log(`Inspect:\n  ${path.join(home, ".claude", "skills")}`);
    console.log(`  ${path.join(home, ".codex")}`);
  } else {
    await fs.rm(home, { recursive: true, force: true });
    console.log("Temp HOME cleaned up (pass --keep to retain).");
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
