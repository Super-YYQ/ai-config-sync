import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runSetup } from "../../packages/cli/src/setup.js";
import { commitCaptureItems, buildCaptureProposals } from "@ai-config-sync/recipe-engine";
import { loadRecipe, loadResources, pathExists, writeText, ensureDir } from "@ai-config-sync/core";
import type { ScannedResource } from "@ai-config-sync/scanner";

describe("P0 review fixes", () => {
  let home: string;
  let configRepo: string;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "acs-p0-"));
    configRepo = path.join(home, "my-ai-config");
    await fs.cp(
      path.resolve(__dirname, "../../examples/demo-config"),
      configRepo,
      { recursive: true },
    );
  });

  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  it("setup --repo does not clone when already linked to another path", async () => {
    await runSetup({
      home,
      configPath: configRepo,
      profile: "home",
      repo: "git@github.com:you/my-ai-config.git",
    });
    const other = path.join(home, "other-path");
    const r = await runSetup({
      home,
      repo: "git@github.com:other/different.git",
      profile: "home",
    });
    expect(r.status).toBe("planned");
    expect(r.messages.some((m) => /Already linked|conflicts|reconfigure/i.test(m))).toBe(
      true,
    );
    expect(await pathExists(other)).toBe(false);
  });

  it("commitCaptureItems merges dual-target recipes without overwrite", async () => {
    const claudeItem = {
      scanned: {
        id: "demo",
        kind: "skill" as const,
        target: "claude" as const,
        path: "/x",
        confidence: 1,
        classification: "source-unknown" as const,
      },
      suggestedResource: {
        id: "demo",
        kind: "skill" as const,
        targets: {
          claude: { enabled: true, recipeRef: "recipes/demo.yaml#claude" },
        },
        profiles: ["home"],
        versionPolicy: "latest-confirm" as const,
      },
      suggestedRecipe: {
        id: "demo",
        schemaVersion: 1 as const,
        targets: {
          claude: {
            driver: "generic-skill" as const,
            scope: "user" as const,
            sourcePaths: { skill: "." },
            operations: [],
            requiredPaths: ["SKILL.md"],
            requirements: [],
            verification: [],
            risk: "low" as const,
            evidence: [],
            requiresApproval: true,
          },
        },
        versionPolicy: "latest-confirm" as const,
        risk: "low" as const,
      },
      needsAi: false,
    };
    const codexItem = {
      ...claudeItem,
      scanned: { ...claudeItem.scanned, target: "codex" as const },
      suggestedResource: {
        id: "demo",
        kind: "skill" as const,
        targets: {
          codex: { enabled: true, recipeRef: "recipes/demo.yaml#codex" },
        },
        profiles: ["home"],
        versionPolicy: "latest-confirm" as const,
      },
      suggestedRecipe: {
        id: "demo",
        schemaVersion: 1 as const,
        targets: {
          codex: {
            driver: "generic-skill" as const,
            scope: "user" as const,
            sourcePaths: { skill: "." },
            operations: [],
            requiredPaths: ["SKILL.md"],
            requirements: [],
            verification: [],
            risk: "low" as const,
            evidence: [],
            requiresApproval: true,
          },
        },
        versionPolicy: "latest-confirm" as const,
        risk: "low" as const,
      },
      needsAi: false,
    };

    await commitCaptureItems(
      [claudeItem, codexItem] as never,
      configRepo,
      "test",
    );
    const recipe = await loadRecipe(path.join(configRepo, "recipes", "demo.yaml"));
    expect(recipe.targets.claude?.driver).toBe("generic-skill");
    expect(recipe.targets.codex?.driver).toBe("generic-skill");
    const resources = await loadResources(path.join(configRepo, "resources.yaml"));
    const demo = resources.resources.find((r) => r.id === "demo");
    expect(demo?.targets.claude?.enabled).toBe(true);
    expect(demo?.targets.codex?.enabled).toBe(true);
  });

  it("buildCaptureProposals skips config-sync self plugin", async () => {
    const scanned: ScannedResource[] = [
      {
        id: "config-sync",
        kind: "skill",
        target: "claude",
        path: path.join(home, ".claude", "skills", "config-sync"),
        confidence: 1,
        classification: "source-unknown",
      },
      {
        id: "ai-config-sync@ai-config-sync",
        kind: "plugin",
        target: "claude",
        path: path.join(home, ".claude"),
        confidence: 1,
        classification: "source-unknown",
      },
      {
        id: "real-skill",
        kind: "skill",
        target: "claude",
        path: path.join(home, "s"),
        confidence: 0.5,
        classification: "source-unknown",
      },
    ];
    await ensureDir(path.join(home, "s"));
    await writeText(path.join(home, "s", "SKILL.md"), "# real\n");
    const items = await buildCaptureProposals(scanned, configRepo, {
      home,
      offline: true,
    });
    expect(items.every((i) => i.suggestedResource.id !== "config-sync")).toBe(
      true,
    );
    expect(
      items.every((i) => !i.suggestedResource.id.includes("ai-config-sync")),
    ).toBe(true);
  });
});
