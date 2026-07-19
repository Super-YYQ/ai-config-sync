import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runSetup } from "../../packages/cli/src/setup.js";
import {
  buildPlan,
  applyPlan,
  formatPlan,
  runDoctor,
} from "@ai-config-sync/recipe-engine";
import {
  loadLocalConfig,
  localConfigPath,
  pathExists,
  readJsonFile,
  getTomlValue,
  readText,
  hasManagedCodexSessionStart,
} from "@ai-config-sync/core";

async function copyTemplate(dest: string, which: "empty" | "demo"): Promise<void> {
  const src = path.resolve(
    __dirname,
    which === "demo"
      ? "../../examples/demo-config"
      : "../../examples/private-config-template",
  );
  await fs.cp(src, dest, { recursive: true });
}

describe("setup + empty template", () => {
  let home: string;
  let configRepo: string;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "acs-empty-"));
    configRepo = path.join(home, "my-ai-config");
    await copyTemplate(configRepo, "empty");
  });

  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  it("setup is idempotent and plan is No changes", async () => {
    const r1 = await runSetup({
      home,
      configPath: configRepo,
      profile: "home",
    });
    expect(["initialized", "linked", "repaired", "partial"]).toContain(
      r1.status,
    );
    expect(await pathExists(localConfigPath(home))).toBe(true);

    const r2 = await runSetup({
      home,
      configPath: configRepo,
      profile: "home",
    });
    expect(["no-changes", "repaired", "linked", "partial"]).toContain(
      r2.status,
    );

    const localConfig = await loadLocalConfig(localConfigPath(home));
    const plan = await buildPlan({
      home,
      configRepoPath: configRepo,
      localConfig,
      profileName: "home",
    });
    expect(formatPlan(plan)).toMatch(/No changes/);
  });

  it("installs Codex event-map hooks and features.hooks", async () => {
    await runSetup({ home, configPath: configRepo, profile: "home" });
    const hooksPath = path.join(home, ".codex", "hooks.json");
    expect(await pathExists(hooksPath)).toBe(true);
    const hooks = await readJsonFile(hooksPath);
    expect(hasManagedCodexSessionStart(hooks)).toBe(true);
    // event-map shape
    const h = hooks as { hooks?: Record<string, unknown> };
    expect(h.hooks && !Array.isArray(h.hooks)).toBe(true);
    expect(Array.isArray((h.hooks as { SessionStart?: unknown }).SessionStart)).toBe(
      true,
    );

    const toml = await readText(path.join(home, ".codex", "config.toml"));
    expect(getTomlValue(toml, "features", "hooks")).toBe(true);

    // agents skill preferred
    expect(
      await pathExists(path.join(home, ".agents", "skills", "config-sync", "SKILL.md")),
    ).toBe(true);
  });
});

describe("setup + demo restore", () => {
  let home: string;
  let configRepo: string;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "acs-demo-"));
    configRepo = path.join(home, "my-ai-config");
    await copyTemplate(configRepo, "demo");
  });

  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  it("plans and applies demo-skill to both tools", async () => {
    await runSetup({ home, configPath: configRepo, profile: "home" });
    const localConfig = await loadLocalConfig(localConfigPath(home));

    const plan = await buildPlan({
      home,
      configRepoPath: configRepo,
      localConfig,
      profileName: "home",
    });
    const text = formatPlan(plan);
    expect(text).toMatch(/demo-skill/);
    expect(plan.actions.length).toBeGreaterThan(0);

    const result = await applyPlan({
      home,
      configRepoPath: configRepo,
      localConfig,
      profileName: "home",
      yes: true,
      allowRisk: "medium",
    });

    const claudeSkill = path.join(
      home,
      ".claude",
      "skills",
      "demo-skill",
      "SKILL.md",
    );
    // default write path is agents skills
    const codexSkill = path.join(
      home,
      ".agents",
      "skills",
      "demo-skill",
      "SKILL.md",
    );
    expect(await pathExists(claudeSkill)).toBe(true);
    expect(await pathExists(codexSkill)).toBe(true);

    const result2 = await applyPlan({
      home,
      configRepoPath: configRepo,
      localConfig,
      profileName: "home",
      yes: true,
      allowRisk: "medium",
    });
    expect(result2.failed.length).toBe(0);
    const demoSkips = result2.plan.actions.filter(
      (a) => a.resourceId === "demo-skill" && a.type === "SKIP",
    );
    expect(demoSkips.length).toBeGreaterThanOrEqual(1);

    await fs.writeFile(claudeSkill, "# claude only\n", "utf8");
    const codexContent = await fs.readFile(codexSkill, "utf8");
    expect(codexContent).not.toContain("claude only");

    const doctor = await runDoctor({
      home,
      localConfig,
      configRepoPath: configRepo,
    });
    expect(doctor.findings.some((f) => f.code === "resources-loaded")).toBe(
      true,
    );
  });

  it("company profile excludes demo-skill", async () => {
    await runSetup({
      home,
      configPath: configRepo,
      profile: "company",
      mode: "reconfigure",
    });
    const localConfig = await loadLocalConfig(localConfigPath(home));
    const plan = await buildPlan({
      home,
      configRepoPath: configRepo,
      localConfig,
      profileName: "company",
    });
    const demoActions = plan.actions.filter((a) => a.resourceId === "demo-skill");
    expect(demoActions.length).toBe(0);
  });
});
