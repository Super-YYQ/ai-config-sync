import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runSetup } from "../../packages/cli/src/setup.js";
import {
  applyPlan,
  buildDriftReport,
  buildPlan,
} from "@ai-config-sync/recipe-engine";
import {
  getTomlValue,
  loadLocalConfig,
  localConfigPath,
  pathExists,
  readJsonFile,
  readText,
  hasManagedCodexSessionStart,
} from "@ai-config-sync/core";

async function copyTemplate(dest: string): Promise<void> {
  const src = path.resolve(__dirname, "../../examples/demo-config");
  await fs.cp(src, dest, { recursive: true });
}

describe("offline vendored planning-with-files", () => {
  let home: string;
  let configRepo: string;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "acs-pwf-"));
    configRepo = path.join(home, "my-ai-config");
    await copyTemplate(configRepo);
  });

  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  it("restores Claude skill + Codex skill/hooks/toml without network", async () => {
    await runSetup({
      home,
      configPath: configRepo,
      profile: "offline-demo",
    });
    const localConfig = await loadLocalConfig(localConfigPath(home));

    const plan = await buildPlan({
      home,
      configRepoPath: configRepo,
      localConfig,
      profileName: "offline-demo",
      offline: true,
    });

    const manuals = plan.actions.filter(
      (a) =>
        a.resourceId === "planning-with-files" &&
        a.type === "MANUAL" &&
        /source not available/i.test(a.description),
    );
    expect(manuals.length).toBe(0);

    expect(
      plan.actions.some(
        (a) =>
          a.resourceId === "planning-with-files" &&
          a.target === "claude" &&
          a.type === "COPY",
      ),
    ).toBe(true);

    const result = await applyPlan({
      home,
      configRepoPath: configRepo,
      localConfig,
      profileName: "offline-demo",
      yes: true,
      allowRisk: "medium",
      offline: true,
    });
    expect(result.failed.length).toBe(0);

    const claudeSkill = path.join(
      home,
      ".claude",
      "skills",
      "planning-with-files",
      "SKILL.md",
    );
    const codexSkillAgents = path.join(
      home,
      ".agents",
      "skills",
      "planning-with-files",
      "SKILL.md",
    );
    expect(await pathExists(claudeSkill)).toBe(true);
    expect(await pathExists(codexSkillAgents)).toBe(true);
    expect(await readText(claudeSkill)).toMatch(/planning-with-files/i);
    expect(await readText(codexSkillAgents)).toMatch(/Codex/i);

    await fs.appendFile(claudeSkill, "\n# only-claude\n", "utf8");
    expect(await readText(codexSkillAgents)).not.toContain("only-claude");

    const hooks = await readJsonFile(path.join(home, ".codex", "hooks.json"));
    // Managed pwf hook may be array-style from recipe OR event-map from setup
    const hasPwf =
      hasManagedCodexSessionStart(hooks) ||
      JSON.stringify(hooks).includes("planning-with-files");
    expect(hasPwf).toBe(true);

    const toml = await readText(path.join(home, ".codex", "config.toml"));
    expect(getTomlValue(toml, "features", "hooks")).toBe(true);

    expect(
      await pathExists(
        path.join(home, ".codex", "hooks", "planning-with-files"),
      ),
    ).toBe(true);

    const result2 = await applyPlan({
      home,
      configRepoPath: configRepo,
      localConfig,
      profileName: "offline-demo",
      yes: true,
      allowRisk: "medium",
      offline: true,
    });
    expect(result2.failed.length).toBe(0);
    const codexSkip = result2.plan.actions.find(
      (a) =>
        a.resourceId === "planning-with-files" &&
        a.target === "codex" &&
        a.type === "SKIP",
    );
    expect(codexSkip).toBeTruthy();

    const drift = await buildDriftReport({
      home,
      configRepoPath: configRepo,
      localConfig,
      profileName: "offline-demo",
      offline: true,
    });
    const codexDrift = drift.items.find(
      (i) => i.resourceId === "planning-with-files" && i.target === "codex",
    );
    expect(codexDrift?.kind).toBe("in-sync");
  });
});
