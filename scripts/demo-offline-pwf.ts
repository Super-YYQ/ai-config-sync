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
const template = path.join(root, "examples", "demo-config");
const cliBundled = path.join(root, "dist", "ai-config-sync.cjs");
const cliPkg = path.join(root, "packages", "cli", "dist", "index.js");

function banner(title: string) {
  console.log("\n" + "=".repeat(60));
  console.log(title);
  console.log("=".repeat(60));
}

async function resolveCli(): Promise<string> {
  try {
    await fs.access(cliBundled);
    return cliBundled;
  } catch {
    /* fallthrough */
  }
  try {
    await fs.access(cliPkg);
    return cliPkg;
  } catch {
    throw new Error("CLI not built. Run: npm run build && node scripts/build-plugin-cli.mjs");
  }
}

function runCli(
  cli: string,
  home: string,
  args: string[],
): { code: number; out: string } {
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
  let cli: string;
  try {
    cli = await resolveCli();
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
    return;
  }

  const home = await fs.mkdtemp(path.join(os.tmpdir(), "acs-pwf-demo-"));
  const configRepo = path.join(home, "my-ai-config");
  await fs.cp(template, configRepo, { recursive: true });

  banner("1) setup --profile offline-demo");
  console.log(`HOME (isolated): ${home}`);
  console.log(`Config repo:     ${configRepo}`);
  console.log(`CLI:             ${cli}`);
  let r = runCli(cli, home, [
    "setup",
    "--config-path",
    configRepo,
    "--profile",
    "offline-demo",
    "--program-root",
    root,
  ]);
  console.log(r.out.trim());
  if (r.code !== 0) process.exitCode = 1;

  banner("2) plan (vendored planning-with-files only)");
  r = runCli(cli, home, ["plan", "--profile", "offline-demo"]);
  console.log(r.out.trim());

  banner("3) apply --yes --allow-risk medium --offline");
  r = runCli(cli, home, [
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
  // Prefer agents skills dir; also accept legacy
  const codexSkillAgents = path.join(
    home,
    ".agents",
    "skills",
    "planning-with-files",
    "SKILL.md",
  );
  const codexSkillLegacy = path.join(
    home,
    ".codex",
    "skills",
    "planning-with-files",
    "SKILL.md",
  );
  const codexSkill = (await pathExists(codexSkillAgents))
    ? codexSkillAgents
    : codexSkillLegacy;
  const hooksJson = path.join(home, ".codex", "hooks.json");
  const configToml = path.join(home, ".codex", "config.toml");

  const checks: Array<[string, boolean]> = [
    ["Claude skill", await pathExists(claudeSkill)],
    ["Codex/agents skill", await pathExists(codexSkill)],
    ["Codex hooks.json", await pathExists(hooksJson)],
    ["Codex config.toml", await pathExists(configToml)],
  ];
  for (const [label, ok] of checks) {
    console.log(`${ok ? "✓" : "✗"} ${label}`);
    if (!ok) process.exitCode = 1;
  }
  for (const [label, ok] of checks) {
    if (!ok) continue;
    const p =
      label === "Claude skill"
        ? claudeSkill
        : label === "Codex/agents skill"
          ? codexSkill
          : label === "Codex hooks.json"
            ? hooksJson
            : configToml;
    console.log(`  → ${p}`);
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

  banner("5) second apply (expect SKIP / no-changes)");
  r = runCli(cli, home, [
    "apply",
    "--profile",
    "offline-demo",
    "--yes",
    "--allow-risk",
    "medium",
    "--offline",
  ]);
  console.log(r.out.trim());

  banner("6) doctor");
  r = runCli(cli, home, ["doctor"]);
  console.log(r.out.trim());

  banner("Done");
  if (keep) {
    console.log(`Kept isolated HOME at:\n  ${home}`);
  } else {
    await fs.rm(home, { recursive: true, force: true });
    console.log("Temp HOME cleaned up (pass --keep to retain).");
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
