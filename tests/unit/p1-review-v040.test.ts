import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  parseClaudePluginListJson,
  findPluginStatus,
} from "@ai-config-sync/drivers";
import {
  resolveClaudePluginInventory,
  loadMarketplacePluginNames,
} from "@ai-config-sync/scanner";
import { commitCaptureItems } from "@ai-config-sync/recipe-engine";
import {
  ensureDir,
  writeText,
  writeJsonFile,
  pathExists,
  loadResources,
  loadRecipe,
} from "@ai-config-sync/core";
import type { ScannedResource } from "@ai-config-sync/scanner";

async function makeTemp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "acs-p1-"));
}

describe("P1-2 precise Claude plugin list parsing", () => {
  it("parses --json array and matches full plugin@marketplace id only", () => {
    const entries = parseClaudePluginListJson([
      {
        id: "code-review@claude-plugins-official",
        enabled: true,
        version: "1.0.0",
      },
      {
        id: "frontend-design@claude-plugins-official",
        enabled: false,
      },
    ]);
    expect(entries).toHaveLength(2);

    const hit = findPluginStatus(
      entries,
      "code-review@claude-plugins-official",
      "code-review",
    );
    expect(hit.installed).toBe(true);
    expect(hit.enabled).toBe(true);
    expect(hit.source).toBe("json");

    // bare substring must NOT match a different plugin
    const miss = findPluginStatus(entries, "code@claude-plugins-official", "code");
    expect(miss.installed).toBe(false);

    // bare name may resolve only via name@marketplace prefix of full id
    const byName = findPluginStatus(entries, "code-review", "code-review");
    expect(byName.installed).toBe(true);
  });

  it("parses { plugins: [] } shape", () => {
    const entries = parseClaudePluginListJson({
      plugins: [{ id: "x@y", enabled: true }],
    });
    expect(entries[0]!.id).toBe("x@y");
  });
});

describe("P1-3 marketplace membership validation", () => {
  let home: string;
  beforeEach(async () => {
    home = await makeTemp();
  });
  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  it("loads plugin names from marketplace.json", async () => {
    const mkt = path.join(home, "mkt");
    await ensureDir(path.join(mkt, ".claude-plugin"));
    await writeText(
      path.join(mkt, ".claude-plugin", "marketplace.json"),
      JSON.stringify({
        name: "demo",
        plugins: [{ name: "alpha" }, { name: "beta" }],
      }),
    );
    const names = await loadMarketplacePluginNames(mkt);
    expect([...names].sort()).toEqual(["alpha", "beta"]);
  });

  it("clears repository when plugin is not a marketplace member", async () => {
    const plugins = path.join(home, ".claude", "plugins");
    const mkt = path.join(plugins, "marketplaces", "claude-plugins-official");
    await ensureDir(path.join(mkt, ".claude-plugin"));
    await writeJsonFile(path.join(home, ".claude", "settings.json"), {
      enabledPlugins: {
        "real-plugin@claude-plugins-official": true,
        "ghost-plugin@claude-plugins-official": true,
      },
    });
    await writeJsonFile(path.join(plugins, "known_marketplaces.json"), {
      "claude-plugins-official": {
        installLocation: mkt,
        source: { repo: "anthropics/claude-plugins-official" },
      },
    });
    await writeText(
      path.join(mkt, ".claude-plugin", "marketplace.json"),
      JSON.stringify({
        name: "claude-plugins-official",
        plugins: [{ name: "real-plugin" }],
      }),
    );
    await ensureDir(path.join(mkt, ".git"));
    await writeText(
      path.join(mkt, ".git", "config"),
      `[remote "origin"]\n\turl = https://github.com/anthropics/claude-plugins-official.git\n`,
    );

    const { items } = await resolveClaudePluginInventory(home);
    const real = items.find((i) => i.pluginName === "real-plugin");
    const ghost = items.find((i) => i.pluginName === "ghost-plugin");
    expect(real?.resolutionStatus).toBe("resolved");
    expect(real?.marketplaceRepository).toBe("anthropics/claude-plugins-official");
    expect(ghost?.marketplaceRepository).toBeUndefined();
    expect(ghost?.evidence.some((e) => e.from === "marketplace-manifest")).toBe(
      true,
    );
  });
});

describe("P1-1 transactional capture commit", () => {
  let home: string;
  let configRepo: string;

  beforeEach(async () => {
    home = await makeTemp();
    configRepo = path.join(home, "cfg");
    await ensureDir(path.join(configRepo, "recipes"));
    await writeText(
      path.join(configRepo, "resources.yaml"),
      "schemaVersion: 1\nresources: []\n",
    );
  });

  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  it("writes resources + recipe and leaves no staging dirs on success", async () => {
    const skillDir = path.join(home, "my-skill");
    await ensureDir(skillDir);
    await writeText(path.join(skillDir, "SKILL.md"), "# my-skill\n");

    const scanned: ScannedResource = {
      id: "my-skill",
      kind: "skill",
      target: "claude",
      path: skillDir,
      confidence: 0.9,
      classification: "source-unknown",
    };

    const result = await commitCaptureItems(
      [
        {
          scanned,
          suggestedResource: {
            id: "my-skill",
            kind: "skill",
            source: { provider: "local", path: skillDir },
            targets: {
              claude: { enabled: true, recipeRef: "recipes/my-skill.yaml#claude" },
            },
            profiles: ["home"],
            versionPolicy: "vendored",
          },
          suggestedRecipe: {
            id: "my-skill",
            schemaVersion: 1,
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
          },
          needsAi: false,
          status: "ready",
        },
      ],
      configRepo,
      "test",
    );

    expect(await pathExists(result.resourcesPath)).toBe(true);
    const res = await loadResources(result.resourcesPath);
    expect(res.resources.some((r) => r.id === "my-skill")).toBe(true);
    const recipe = await loadRecipe(path.join(configRepo, "recipes", "my-skill.yaml"));
    expect(recipe.id).toBe("my-skill");
    expect(await pathExists(path.join(configRepo, "sources", "skills", "my-skill", "SKILL.md"))).toBe(
      true,
    );

    const leftovers = (await fs.readdir(configRepo)).filter((n) =>
      n.startsWith(".ai-config-sync-staging") || n.startsWith(".ai-config-sync-backup"),
    );
    expect(leftovers).toEqual([]);
  });
});
