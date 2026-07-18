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
} from "@ai-config-sync/core";

async function copyTemplate(dest: string): Promise<void> {
  const src = path.resolve(__dirname, "../../examples/private-config-template");
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

    // Should not require MANUAL source-missing for pwf
    const manuals = plan.actions.filter(
      (a) =>
        a.resourceId === "planning-with-files" &&
        a.type === "MANUAL" &&
        /source not available/i.test(a.description),
    );
    expect(manuals.length).toBe(0);

    // Should plan Claude copy + Codex multi-op
    expect(
      plan.actions.some(
        (a) =>
          a.resourceId === "planning-with-files" &&
          a.target === "claude" &&
          a.type === "COPY",
      ),
    ).toBe(true);
    expect(
      plan.actions.some(
        (a) =>
          a.resourceId === "planning-with-files" &&
          a.target === "codex" &&
          (a.type === "COPY" || a.type === "MERGE" || a.type === "UPDATE"),
      ),
    ).toBe(true);

    // demo-skill excluded from offline-demo profile
    expect(plan.actions.every((a) => a.resourceId !== "demo-skill")).toBe(true);

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
    const codexSkill = path.join(
      home,
      ".codex",
      "skills",
      "planning-with-files",
      "SKILL.md",
    );
    expect(await pathExists(claudeSkill)).toBe(true);
    expect(await pathExists(codexSkill)).toBe(true);
    expect(await readText(claudeSkill)).toMatch(/planning-with-files/i);
    expect(await readText(codexSkill)).toMatch(/Codex/i);

    // Independent copies
    await fs.appendFile(claudeSkill, "\n# only-claude\n", "utf8");
    expect(await readText(codexSkill)).not.toContain("only-claude");

    // Hooks merged
    const hooks = await readJsonFile<{ hooks: Array<{ id: string }> }>(
      path.join(home, ".codex", "hooks.json"),
    );
    expect(hooks.hooks.some((h) => h.id === "planning-with-files-session-start")).toBe(
      true,
    );

    // Preserve pre-existing unmanaged hook on second merge path: simulate by re-apply
    hooks.hooks.push({ id: "user-custom-hook" } as { id: string });
    await fs.writeFile(
      path.join(home, ".codex", "hooks.json"),
      JSON.stringify(hooks, null, 2),
      "utf8",
    );

    // TOML
    const toml = await readText(path.join(home, ".codex", "config.toml"));
    expect(getTomlValue(toml, "features", "hooks")).toBe(true);

    // Hook scripts copied
    expect(
      await pathExists(
        path.join(home, ".codex", "hooks", "planning-with-files"),
      ),
    ).toBe(true);

    // Second apply: skills SKIP (claude may show drift due to our edit)
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
    // codex skill should still be in-sync skip; claude may re-COPY due to local edit
    const codexSkip = result2.plan.actions.find(
      (a) =>
        a.resourceId === "planning-with-files" &&
        a.target === "codex" &&
        a.type === "SKIP",
    );
    expect(codexSkip).toBeTruthy();

    // Re-apply codex path should preserve user-custom-hook when merging again
    // Force re-apply by deleting codex skill so it's not SKIP
    await fs.rm(path.join(home, ".codex", "skills", "planning-with-files"), {
      recursive: true,
      force: true,
    });
    const result3 = await applyPlan({
      home,
      configRepoPath: configRepo,
      localConfig,
      profileName: "offline-demo",
      yes: true,
      allowRisk: "medium",
      offline: true,
    });
    expect(result3.failed.length).toBe(0);
    const hooksAfter = await readJsonFile<{ hooks: Array<{ id: string }> }>(
      path.join(home, ".codex", "hooks.json"),
    );
    const ids = hooksAfter.hooks.map((h) => h.id);
    expect(ids).toContain("planning-with-files-session-start");
    expect(ids).toContain("user-custom-hook");

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
