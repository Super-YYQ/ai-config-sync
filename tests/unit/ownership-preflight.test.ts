import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  claudeSkillsDir,
  ensureDir,
  hashDirectory,
  readText,
  shortHash,
  writeText,
  writeYamlFile,
  type LocalConfig,
} from "@ai-config-sync/core";
import { applyPlan, buildPlan } from "@ai-config-sync/recipe-engine";
import { ensureStateDirs, putState } from "@ai-config-sync/state-manager";

describe("skill target ownership preflight", () => {
  let root: string;
  let home: string;
  let repo: string;
  let source: string;
  let target: string;
  let localConfig: LocalConfig;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "acs-ownership-"));
    home = path.join(root, "home");
    repo = path.join(root, "config-repo");
    source = path.join(repo, "sources", "skills", "safe-skill");
    target = path.join(claudeSkillsDir(home), "safe-skill");
    await ensureDir(source);
    await ensureDir(path.join(repo, "profiles"));
    await ensureDir(path.join(repo, "recipes"));
    await writeText(path.join(source, "SKILL.md"), "# desired v1\n");
    await writeYamlFile(path.join(repo, "config.yaml"), {
      schemaVersion: 1,
      name: "ownership-test",
      defaultProfile: "home",
      targets: { claude: true, codex: false },
      security: { blockSecretCommit: true, maxRiskWithoutConfirm: "low" },
      ai: { enabled: false, mode: "off" },
    });
    await writeYamlFile(path.join(repo, "profiles", "home.yaml"), {
      profile: "home",
      extends: [],
      include: { resources: ["safe-skill"] },
      exclude: { resources: [] },
      security: {
        maxRisk: "medium",
        allowAutomaticLatest: false,
        secrets: { provider: "local-only" },
      },
    });
    await writeYamlFile(path.join(repo, "resources.yaml"), {
      schemaVersion: 1,
      resources: [
        {
          id: "safe-skill",
          kind: "skill",
          source: { provider: "vendored", path: "sources/skills/safe-skill" },
          targets: {
            claude: {
              enabled: true,
              recipeRef: "recipes/safe-skill.yaml#claude",
            },
          },
          profiles: ["home"],
          versionPolicy: "vendored",
        },
      ],
    });
    await writeYamlFile(path.join(repo, "recipes", "safe-skill.yaml"), {
      id: "safe-skill",
      schemaVersion: 1,
      source: { provider: "vendored", path: "sources/skills/safe-skill" },
      targets: {
        claude: {
          driver: "generic-skill",
          scope: "user",
          sourcePaths: { skill: "." },
          operations: [],
          requiredPaths: ["SKILL.md"],
          requirements: [],
          verification: [],
          risk: "low",
          evidence: [],
          requiresApproval: true,
        },
      },
      versionPolicy: "vendored",
      risk: "low",
    });
    localConfig = {
      schemaVersion: 1,
      configRepository: { localPath: repo },
      profile: "home",
      targets: { claude: true, codex: false },
      ai: { enabled: false, mode: "off" },
    };
    await ensureStateDirs(home);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  function context() {
    return {
      home,
      configRepoPath: repo,
      localConfig,
      profileName: "home",
      offline: true,
    };
  }

  it("refuses an existing target with no ownership record", async () => {
    await ensureDir(target);
    await writeText(path.join(target, "SKILL.md"), "# user-owned\n");
    const plan = await buildPlan(context());
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]).toMatchObject({ type: "MANUAL", risk: "high" });
    expect(plan.actions[0]!.description).toContain("collision-unmanaged");
    expect(await readText(path.join(target, "SKILL.md"))).toBe("# user-owned\n");
  });

  it("refuses a target that appears after an absent-target Plan", async () => {
    const plan = await buildPlan(context());
    expect(plan.actions[0]?.targetSnapshot).toMatchObject({
      existed: false,
      ownership: "absent",
    });

    await ensureDir(target);
    await writeText(path.join(target, "SKILL.md"), "# appeared later\n");
    const result = await applyPlan(
      { ...context(), yes: true, allowRisk: "medium" },
      plan,
    );
    expect(result.failed[0]?.error).toContain("target appeared after plan");
    expect(result.autoRolledBack).toBe(true);
    expect(await readText(path.join(target, "SKILL.md"))).toBe("# appeared later\n");
  });

  it("updates a hash-verified target owned by AI Config Sync", async () => {
    await ensureDir(target);
    await writeText(path.join(target, "SKILL.md"), "# installed v0\n");
    const installedHash = shortHash(await hashDirectory(target));
    await putState(
      {
        schemaVersion: 1,
        installed: {
          "safe-skill": {
            claude: {
              status: "installed",
              path: target,
              hash: installedHash,
            },
          },
        },
      },
      home,
    );

    const plan = await buildPlan(context());
    expect(plan.actions[0]?.type).not.toBe("MANUAL");
    expect(plan.actions[0]?.targetSnapshot).toMatchObject({
      existed: true,
      ownership: "managed",
      hash: installedHash,
    });

    const result = await applyPlan(
      { ...context(), yes: true, allowRisk: "medium" },
      plan,
    );
    expect(result.failed).toEqual([]);
    expect(await readText(path.join(target, "SKILL.md"))).toBe("# desired v1\n");
  });
});
