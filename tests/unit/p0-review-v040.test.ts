import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { scanLocal } from "@ai-config-sync/scanner";
import { ensureDir, writeText, writeJsonFile, pathExists } from "@ai-config-sync/core";
import { runSetup } from "../../packages/cli/src/setup.js";
import { groupActionsByResourceTarget } from "@ai-config-sync/recipe-engine";
import type { PlanAction } from "@ai-config-sync/core";

async function makeTemp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "acs-p0v4-"));
}

describe("P0-2 Codex event-map hook scanner", () => {
  let home: string;
  beforeEach(async () => {
    home = await makeTemp();
  });
  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  it("parses { hooks: { SessionStart: [...] } } event map", async () => {
    const hooksPath = path.join(home, ".codex", "hooks.json");
    await ensureDir(path.dirname(hooksPath));
    await writeJsonFile(hooksPath, {
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: "command",
                command: "ai-config-sync scan --light --json",
              },
            ],
          },
        ],
        Stop: [
          {
            id: "third-party-stop",
            command: "echo stop",
          },
        ],
      },
    });

    const scan = await scanLocal({
      home,
      light: true,
      targets: { claude: false, codex: true },
    });
    const hooks = scan.resources.filter((r) => r.kind === "hook");
    const ids = hooks.map((h) => h.id);
    // event-map style ids
    expect(ids.some((id) => id.includes("SessionStart") || id.includes("hooks:SessionStart"))).toBe(
      true,
    );
    expect(ids.some((id) => id.includes("Stop") || id.includes("third-party"))).toBe(true);
  });

  it("still parses legacy hooks array", async () => {
    const hooksPath = path.join(home, ".codex", "hooks.json");
    await ensureDir(path.dirname(hooksPath));
    await writeJsonFile(hooksPath, {
      hooks: [
        { id: "legacy-hook-a", command: "echo a" },
        { id: "legacy-hook-b", command: "echo b" },
      ],
    });
    const scan = await scanLocal({
      home,
      light: true,
      targets: { claude: false, codex: true },
    });
    const ids = scan.resources.filter((r) => r.kind === "hook").map((h) => h.id);
    expect(ids).toContain("legacy-hook-a");
    expect(ids).toContain("legacy-hook-b");
  });
});

describe("P0-6 apply group key with special resource ids", () => {
  it("does not truncate resource ids containing colons", () => {
    const actions: PlanAction[] = [
      {
        id: "1",
        type: "CREATE",
        description: "install hooks:SessionStart",
        resourceId: "hooks:SessionStart",
        target: "codex",
        risk: "low",
        paths: [],
        requiresConfirmation: false,
      },
      {
        id: "2",
        type: "CREATE",
        description: "install plugin",
        resourceId: "code-review@claude-plugins-official",
        target: "claude",
        risk: "medium",
        paths: [],
        requiresConfirmation: true,
      },
      {
        id: "3",
        type: "UPDATE",
        description: "update same hooks",
        resourceId: "hooks:SessionStart",
        target: "codex",
        risk: "low",
        paths: [],
        requiresConfirmation: false,
      },
    ];
    const groups = groupActionsByResourceTarget(actions);
    expect(groups.size).toBe(2);
    let found: PlanAction[] | undefined;
    let pluginFound = false;
    for (const [k, v] of groups) {
      if (k.resourceId === "hooks:SessionStart" && k.target === "codex") found = v;
      if (
        k.resourceId === "code-review@claude-plugins-official" &&
        k.target === "claude"
      ) {
        pluginFound = true;
      }
    }
    expect(found).toHaveLength(2);
    expect(pluginFound).toBe(true);
  });
});

describe("P0-1 setup does not rewrite marketplace internals", () => {
  let home: string;
  let configRepo: string;

  beforeEach(async () => {
    home = await makeTemp();
    configRepo = path.join(home, "my-ai-config");
    await fs.cp(
      path.resolve(__dirname, "../../examples/private-config-template"),
      configRepo,
      { recursive: true },
    );
    // Pre-seed an existing official marketplace so we can detect corruption
    const mkt = path.join(
      home,
      ".claude",
      "plugins",
      "marketplaces",
      "claude-plugins-official",
    );
    await ensureDir(path.join(mkt, ".claude-plugin"));
    await writeText(
      path.join(mkt, ".claude-plugin", "marketplace.json"),
      JSON.stringify({ name: "claude-plugins-official", plugins: [{ name: "x" }] }),
    );
    await writeJsonFile(path.join(home, ".claude", "plugins", "known_marketplaces.json"), {
      "claude-plugins-official": {
        source: { source: "github", repo: "anthropics/claude-plugins-official" },
        installLocation: mkt,
      },
    });
    await writeJsonFile(path.join(home, ".claude", "settings.json"), {
      enabledPlugins: {
        "code-review@claude-plugins-official": true,
      },
    });
  });

  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  it("does not copy plugin into marketplaces or rewrite known_marketplaces/settings", async () => {
    const knownBefore = await fs.readFile(
      path.join(home, ".claude", "plugins", "known_marketplaces.json"),
      "utf8",
    );
    const settingsBefore = await fs.readFile(
      path.join(home, ".claude", "settings.json"),
      "utf8",
    );
    const officialMkt = path.join(
      home,
      ".claude",
      "plugins",
      "marketplaces",
      "claude-plugins-official",
      ".claude-plugin",
      "marketplace.json",
    );
    const officialBefore = await fs.readFile(officialMkt, "utf8");

    const result = await runSetup({
      home,
      configPath: configRepo,
      profile: "home",
      // Force offline path: no local marketplace copy without explicit allow
      programRoot: path.resolve(__dirname, "../.."),
      allowLocalPluginInstall: false,
    });

    // Must not create ai-config-sync marketplace dir via manual copy
    const localMkt = path.join(
      home,
      ".claude",
      "plugins",
      "marketplaces",
      "ai-config-sync",
    );
    // Without claude CLI, setup may skip plugin install — but must not copy
    const copied = await pathExists(
      path.join(localMkt, ".claude-plugin", "plugin.json"),
    );
    expect(copied).toBe(false);

    const knownAfter = await fs.readFile(
      path.join(home, ".claude", "plugins", "known_marketplaces.json"),
      "utf8",
    );
    const settingsAfter = await fs.readFile(
      path.join(home, ".claude", "settings.json"),
      "utf8",
    );
    const officialAfter = await fs.readFile(officialMkt, "utf8");

    expect(knownAfter).toBe(knownBefore);
    expect(settingsAfter).toBe(settingsBefore);
    expect(officialAfter).toBe(officialBefore);
    // official marketplace still present
    expect(await pathExists(officialMkt)).toBe(true);
    expect(result.actions.some((a) => /known_marketplaces|INSTALL Claude marketplace copy/i.test(a))).toBe(
      false,
    );
  });
});
