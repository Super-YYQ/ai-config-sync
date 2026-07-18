import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  scanLocal,
  inventryDiff,
  parseInstalledPlugins,
  resolveClaudePluginInventory,
} from "@ai-config-sync/scanner";
import { buildCaptureProposals } from "@ai-config-sync/recipe-engine";
import { ensureDir, writeText } from "@ai-config-sync/core";

async function makeTempHome(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "acs-mkt-"));
}

describe("parseInstalledPlugins shapes", () => {
  it("parses { plugins: [] }", () => {
    const { items } = parseInstalledPlugins({
      plugins: [
        {
          id: "code-review@claude-plugins-official",
          version: "1.0.0",
          enabled: true,
          path: "/tmp/p",
        },
      ],
    });
    expect(items).toHaveLength(1);
    expect(items[0]!.pluginName).toBe("code-review");
    expect(items[0]!.marketplaceName).toBe("claude-plugins-official");
    expect(items[0]!.version).toBe("1.0.0");
  });

  it("parses object map of plugin@marketplace", () => {
    const { items } = parseInstalledPlugins({
      "frontend-design@claude-plugins-official": {
        version: "2.0.0",
        installPath: "/x",
      },
    });
    expect(items[0]!.pluginName).toBe("frontend-design");
    expect(items[0]!.marketplaceName).toBe("claude-plugins-official");
  });

  it("parses bare array", () => {
    const { items } = parseInstalledPlugins([
      { id: "a@m1" },
      { name: "b@m2", marketplace: "ignored-if-in-id" },
    ]);
    expect(items.map((i) => i.id).sort()).toEqual(["a@m1", "b@m2"]);
  });

  it("returns empty on unknown / null", () => {
    expect(parseInstalledPlugins(null).items).toEqual([]);
    expect(parseInstalledPlugins("nope").items).toEqual([]);
  });
});

describe("Claude marketplace inventory resolver", () => {
  let home: string;
  let configRepo: string;

  beforeEach(async () => {
    home = await makeTempHome();
    configRepo = path.join(home, "cfg");
    await ensureDir(path.join(configRepo, "recipes"));
    await writeText(
      path.join(configRepo, "resources.yaml"),
      "schemaVersion: 1\nresources: []\n",
    );

    const plugins = path.join(home, ".claude", "plugins");
    const mkt = path.join(plugins, "marketplaces", "claude-plugins-official");
    await ensureDir(path.join(mkt, ".git"));
    await ensureDir(path.join(mkt, ".claude-plugin"));

    await writeText(
      path.join(home, ".claude", "settings.json"),
      JSON.stringify({
        enabledPlugins: {
          "code-review@claude-plugins-official": true,
          "frontend-design@claude-plugins-official": true,
          "superpowers@claude-plugins-official": true,
        },
      }),
    );

    await writeText(
      path.join(plugins, "installed_plugins.json"),
      JSON.stringify({
        plugins: [
          {
            id: "code-review@claude-plugins-official",
            version: "1.2.3",
            enabled: true,
          },
        ],
      }),
    );

    await writeText(
      path.join(plugins, "known_marketplaces.json"),
      JSON.stringify({
        "claude-plugins-official": {
          installLocation: mkt,
          source: {
            source: "github",
            repo: "anthropics/claude-plugins-official",
          },
        },
      }),
    );

    await writeText(
      path.join(mkt, ".git", "config"),
      `[remote "origin"]\n\turl = https://github.com/anthropics/claude-plugins-official.git\n`,
    );

    await writeText(
      path.join(mkt, ".claude-plugin", "marketplace.json"),
      JSON.stringify({
        name: "claude-plugins-official",
        plugins: [
          { name: "code-review" },
          { name: "frontend-design" },
          { name: "superpowers" },
        ],
      }),
    );
  });

  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  it("resolves plugin inventory with marketplace repository", async () => {
    const { items } = await resolveClaudePluginInventory(home);
    const cr = items.find((i) => i.canonicalId === "code-review@claude-plugins-official");
    expect(cr).toBeDefined();
    expect(cr!.pluginName).toBe("code-review");
    expect(cr!.marketplaceName).toBe("claude-plugins-official");
    expect(cr!.marketplaceRepository).toBe("anthropics/claude-plugins-official");
    expect(cr!.resolutionStatus).toBe("resolved");
    expect(cr!.version).toBe("1.2.3");
    expect(cr!.enabled).toBe(true);
    expect(cr!.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("scan does not use settings.json as plugin path / source", async () => {
    const scan = await scanLocal({
      home,
      light: true,
      targets: { claude: true, codex: false },
    });
    const plugins = scan.resources.filter(
      (r) => r.kind === "plugin" && r.classification !== "system-cache",
    );
    expect(plugins.length).toBeGreaterThanOrEqual(3);
    for (const p of plugins) {
      expect(p.path).not.toMatch(/settings\.json$/i);
      expect(p.metadata?.pluginName).toBeTruthy();
      if (String(p.id).includes("@claude-plugins-official")) {
        expect(p.sourceCandidate).toBe("anthropics/claude-plugins-official");
        expect(p.classification).toBe("source-known");
        expect(p.metadata?.marketplace).toBe("claude-plugins-official");
        expect(p.metadata?.installVia).toBe("claude-marketplace");
      }
    }
  });

  it("capture builds claude-marketplace recipe without local settings.json", async () => {
    const scan = await scanLocal({
      home,
      light: true,
      targets: { claude: true, codex: false },
    });
    const unmanaged = inventryDiff(scan, new Set());
    const proposals = await buildCaptureProposals(unmanaged, configRepo, {
      home,
      offline: true,
    });

    const cr = proposals.find(
      (p) =>
        p.scanned.id === "code-review@claude-plugins-official" ||
        p.suggestedResource.id === "code-review" ||
        p.suggestedResource.id === "code-review@claude-plugins-official",
    );
    expect(cr).toBeDefined();
    expect(cr!.needsAi).toBe(false);
    expect(cr!.status).toBe("ready");
    expect(cr!.suggestedRecipe).toBeDefined();
    expect(cr!.suggestedRecipe!.targets.claude?.driver).toBe("claude-marketplace");
    expect(cr!.suggestedRecipe!.targets.claude?.plugin).toBe("code-review");
    expect(cr!.suggestedRecipe!.targets.claude?.marketplace).toBe(
      "claude-plugins-official",
    );
    expect(cr!.suggestedRecipe!.targets.claude?.marketplaceRepository).toBe(
      "anthropics/claude-plugins-official",
    );
    expect(cr!.suggestedRecipe!.risk).toBe("medium");
    expect(cr!.suggestedResource.source?.provider).not.toBe("local");
    if (cr!.suggestedResource.source && "path" in cr!.suggestedResource.source) {
      expect(String(cr!.suggestedResource.source.path)).not.toMatch(
        /settings\.json/i,
      );
    }
  });

  it("blocks capture when plugin marketplace source is unresolved", async () => {
    const blockedHome = await makeTempHome();
    try {
      await ensureDir(path.join(blockedHome, ".claude"));
      await writeText(
        path.join(blockedHome, ".claude", "settings.json"),
        JSON.stringify({
          enabledPlugins: {
            "unknown-plugin@custom-marketplace": true,
          },
        }),
      );
      const scan = await scanLocal({
        home: blockedHome,
        light: true,
        targets: { claude: true, codex: false },
      });
      const proposals = await buildCaptureProposals(
        inventryDiff(scan, new Set()),
        configRepo,
        { home: blockedHome, offline: true },
      );
      const item = proposals.find((p) =>
        String(p.scanned.id).includes("unknown-plugin") ||
        String(p.suggestedResource.id).includes("unknown-plugin"),
      );
      expect(item).toBeDefined();
      expect(item!.suggestedRecipe).toBeUndefined();
      expect(item!.status).toBe("blocked");
      expect(item!.blockReason).toBe("plugin-marketplace-source-unresolved");
      expect(item!.needsAi).toBe(false);
      expect(item!.suggestedResource.source?.provider).not.toBe("local");
    } finally {
      await fs.rm(blockedHome, { recursive: true, force: true });
    }
  });
});
