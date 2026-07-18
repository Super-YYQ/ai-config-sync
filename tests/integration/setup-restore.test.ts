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
import { loadLocalConfig, localConfigPath, pathExists } from "@ai-config-sync/core";

async function copyTemplate(dest: string): Promise<void> {
  const src = path.resolve(__dirname, "../../examples/yyq-ai-config-template");
  await fs.cp(src, dest, { recursive: true });
}

describe("setup + restore integration", () => {
  let home: string;
  let configRepo: string;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "acs-int-"));
    configRepo = path.join(home, "yyq-ai-config");
    await copyTemplate(configRepo);
  });

  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  it("setup is idempotent", async () => {
    const r1 = await runSetup({
      home,
      configPath: configRepo,
      profile: "home",
    });
    expect(["initialized", "linked", "repaired"]).toContain(r1.status);
    expect(await pathExists(localConfigPath(home))).toBe(true);

    const r2 = await runSetup({
      home,
      configPath: configRepo,
      profile: "home",
    });
    // second run should be no-changes or only skip writes
    expect(r2.status).toBe("no-changes");
    expect(r2.actions.length).toBe(0);

    const cfg = await loadLocalConfig(localConfigPath(home));
    expect(cfg.profile).toBe("home");
    expect(path.resolve(cfg.configRepository.localPath)).toBe(
      path.resolve(configRepo),
    );
  });

  it("refuses mismatched remote without deleting", async () => {
    // init a fake git remote mismatch is tested at unit level via remotesMatch;
    // here ensure existing path without wipe
    await runSetup({ home, configPath: configRepo, profile: "home" });
    const before = await fs.readdir(configRepo);
    const r = await runSetup({
      home,
      configPath: configRepo,
      profile: "home",
    });
    expect(r.status).toBe("no-changes");
    const after = await fs.readdir(configRepo);
    expect(after).toEqual(before);
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
    // planning-with-files may appear as CREATE marketplace or MANUAL if source missing
    expect(plan.actions.length).toBeGreaterThan(0);

    const result = await applyPlan({
      home,
      configRepoPath: configRepo,
      localConfig,
      profileName: "home",
      yes: true,
      allowRisk: "medium",
    });

    // demo-skill should apply via generic-skill
    const claudeSkill = path.join(
      home,
      ".claude",
      "skills",
      "demo-skill",
      "SKILL.md",
    );
    const codexSkill = path.join(
      home,
      ".codex",
      "skills",
      "demo-skill",
      "SKILL.md",
    );
    expect(await pathExists(claudeSkill)).toBe(true);
    expect(await pathExists(codexSkill)).toBe(true);

    // second apply should skip in-sync demo-skill (idempotent No changes for copies)
    const result2 = await applyPlan({
      home,
      configRepoPath: configRepo,
      localConfig,
      profileName: "home",
      yes: true,
      allowRisk: "medium",
    });
    expect(result2.failed.length).toBe(0);
    // demo-skill actions should be SKIP after first successful apply
    const demoSkips = result2.plan.actions.filter(
      (a) => a.resourceId === "demo-skill" && a.type === "SKIP",
    );
    expect(demoSkips.length).toBeGreaterThanOrEqual(1);

    // independent copies
    await fs.writeFile(claudeSkill, "# claude only\n", "utf8");
    const codexContent = await fs.readFile(codexSkill, "utf8");
    expect(codexContent).not.toContain("claude only");

    const doctor = await runDoctor({
      home,
      localConfig,
      configRepoPath: configRepo,
    });
    // may warn about git not initialized — should not hard-fail on missing git remote
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
