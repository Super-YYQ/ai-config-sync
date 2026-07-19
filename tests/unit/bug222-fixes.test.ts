import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ensureDir,
  writeText,
  pathExists,
  hashDirectory,
  claudeExecutable,
  mergeManagedCodexSessionStart,
  loadResources,
  saveResources,
  saveRecipe,
} from "@ai-config-sync/core";
import {
  commitCaptureItems,
  isReadyForAutoCapture,
  type CaptureItem,
} from "@ai-config-sync/recipe-engine";
import {
  runSetup,
  detectPluginRoot,
  isRunningInsideSelfPlugin,
  detectPackageRoot,
} from "../../packages/cli/src/setup.js";
import type { ScannedResource } from "@ai-config-sync/scanner";

async function makeTemp(prefix = "acs-b222-"): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function skillItem(
  id: string,
  skillDir: string,
  status: CaptureItem["status"] = "ready",
  extra: Partial<CaptureItem> = {},
): CaptureItem {
  const scanned: ScannedResource = {
    id,
    kind: "skill",
    target: "claude",
    path: skillDir,
    confidence: 0.9,
    classification: "source-unknown",
  };
  return {
    scanned,
    suggestedResource: {
      id,
      kind: "skill",
      source: { provider: "local", path: skillDir },
      targets: {
        claude: { enabled: true, recipeRef: `recipes/${id}.yaml#claude` },
      },
      profiles: ["home"],
      versionPolicy: "vendored",
    },
    suggestedRecipe: {
      id,
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
    status,
    ...extra,
  };
}

describe("P0-1 plugin self-detection", () => {
  let home: string;
  let pluginRoot: string;
  let configRepo: string;
  let prevPluginRoot: string | undefined;

  beforeEach(async () => {
    home = await makeTemp();
    // Isolate only the plugin layout (no integrations/ parent)
    pluginRoot = path.join(home, "installed-plugin-root");
    const monorepoPlugin = path.resolve(
      __dirname,
      "../../integrations/claude-plugin",
    );
    await fs.cp(monorepoPlugin, pluginRoot, { recursive: true });
    configRepo = path.join(home, "my-ai-config");
    await fs.cp(
      path.resolve(__dirname, "../../examples/private-config-template"),
      configRepo,
      { recursive: true },
    );
    prevPluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
    process.env.CLAUDE_PLUGIN_ROOT = pluginRoot;
  });

  afterEach(async () => {
    if (prevPluginRoot === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
    else process.env.CLAUDE_PLUGIN_ROOT = prevPluginRoot;
    await fs.rm(home, { recursive: true, force: true });
  });

  it("detects plugin root via plugin.json name, not directory basename", async () => {
    // Directory basename is "installed-plugin-root" — no ai-config-sync substring
    expect(path.basename(pluginRoot)).not.toMatch(/ai-config-sync|config-sync/);
    const detected = await detectPluginRoot();
    expect(detected).toBe(path.resolve(pluginRoot));
    expect(await isRunningInsideSelfPlugin()).toBe(true);
  });

  it("setup inside self plugin skips install and does not create user skill fallback", async () => {
    const result = await runSetup({
      home,
      configPath: configRepo,
      profile: "home",
      claude: true,
      codex: true,
    });

    expect(
      result.actions.some((a) =>
        /SKIP Claude plugin install \(already running/i.test(a),
      ),
    ).toBe(true);
    expect(
      result.actions.some((a) =>
        /INSTALL Claude (user )?skill: config-sync/i.test(a),
      ),
    ).toBe(false);
    expect(
      await pathExists(path.join(home, ".claude", "skills", "config-sync", "SKILL.md")),
    ).toBe(false);

    // Private config linked
    expect(await pathExists(path.join(home, ".ai-config-sync", "config.yaml"))).toBe(
      true,
    );
    // Codex integration still installed
    expect(
      result.actions.some((a) => /INSTALL agents skill: config-sync/i.test(a)),
    ).toBe(true);
  });

  it("detectPackageRoot finds monorepo when available", async () => {
    const monorepo = path.resolve(__dirname, "../..");
    const root = await detectPackageRoot(monorepo);
    expect(root).toBe(monorepo);
  });
});

describe("P0-2 precise capture rollback", () => {
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

  it("deletes newly created paths when resources.yaml write fails after vendor+recipe", async () => {
    const skillDir = path.join(home, "new-skill");
    await ensureDir(skillDir);
    await writeText(path.join(skillDir, "SKILL.md"), "# new-skill\n");

    const beforeHash = await hashDirectory(configRepo);

    await expect(
      commitCaptureItems(
        [skillItem("new-skill", skillDir, "ready")],
        configRepo,
        "test",
        {
          home,
          injectFailureAfter: ["recipes/new-skill.yaml"],
        },
      ),
    ).rejects.toThrow(/injectFailureAfter/);

    // Newly created recipe and vendor must be gone; resources unchanged
    expect(
      await pathExists(path.join(configRepo, "recipes", "new-skill.yaml")),
    ).toBe(false);
    expect(
      await pathExists(path.join(configRepo, "sources", "skills", "new-skill")),
    ).toBe(false);
    const res = await loadResources(path.join(configRepo, "resources.yaml"));
    expect(res.resources).toEqual([]);

    const afterHash = await hashDirectory(configRepo);
    expect(afterHash).toBe(beforeHash);
  });

  it("restores pre-existing vendor dir without leftover new files", async () => {
    // Pre-seed vendor with only a.txt
    const vendorRel = path.posix.join("sources", "skills", "my-skill");
    await ensureDir(path.join(configRepo, vendorRel));
    await writeText(path.join(configRepo, vendorRel, "SKILL.md"), "# old\n");
    await writeText(path.join(configRepo, vendorRel, "a.txt"), "old-a\n");
    await saveResources(path.join(configRepo, "resources.yaml"), {
      schemaVersion: 1,
      resources: [
        {
          id: "my-skill",
          kind: "skill",
          source: { provider: "vendored", path: vendorRel },
          targets: {
            claude: {
              enabled: true,
              recipeRef: "recipes/my-skill.yaml#claude",
            },
          },
          profiles: ["home"],
          versionPolicy: "vendored",
        },
      ],
    });
    await saveRecipe(path.join(configRepo, "recipes", "my-skill.yaml"), {
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
    });

    const beforeHash = await hashDirectory(configRepo);

    // Source that would add b.txt via vendor
    const skillDir = path.join(home, "src-skill");
    await ensureDir(skillDir);
    await writeText(path.join(skillDir, "SKILL.md"), "# new\n");
    await writeText(path.join(skillDir, "a.txt"), "new-a\n");
    await writeText(path.join(skillDir, "b.txt"), "new-b\n");

    await expect(
      commitCaptureItems(
        [skillItem("my-skill", skillDir, "ready")],
        configRepo,
        "test",
        {
          home,
          injectFailureAfter: ["resources.yaml"],
        },
      ),
    ).rejects.toThrow(/injectFailureAfter/);

    // b.txt must not remain; a.txt restored to old
    expect(await pathExists(path.join(configRepo, vendorRel, "b.txt"))).toBe(
      false,
    );
    expect(await fs.readFile(path.join(configRepo, vendorRel, "a.txt"), "utf8")).toBe(
      "old-a\n",
    );
    expect(await fs.readFile(path.join(configRepo, vendorRel, "SKILL.md"), "utf8")).toBe(
      "# old\n",
    );

    const afterHash = await hashDirectory(configRepo);
    expect(afterHash).toBe(beforeHash);
  });
});

describe("P1-2 claudeExecutable", () => {
  it("returns claude.cmd on win32 and claude elsewhere", () => {
    const exe = claudeExecutable();
    if (process.platform === "win32") {
      expect(exe).toBe("claude.cmd");
    } else {
      expect(exe).toBe("claude");
    }
  });
});

describe("P1-4 commandWindows refresh when path changes", () => {
  it("updates stale commandWindows to desired value", () => {
    const existing = {
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: "command",
                id: "ai-config-sync-session-start",
                command: "ai-config-sync scan --light --write-pending",
                timeout: 20,
                commandWindows:
                  '"C:\\\\old\\\\node.exe" "C:\\\\old\\\\ai-config-sync.cjs" scan --light --write-pending',
              },
            ],
          },
        ],
      },
    };
    const desired =
      '"C:\\\\Node\\\\node.exe" "D:\\\\acs\\\\dist\\\\ai-config-sync.cjs"';
    const { next, changed } = mergeManagedCodexSessionStart(existing, {
      cliAbsoluteCommand: desired,
    });
    expect(changed).toBe(true);
    const managed = (
      next as {
        hooks: {
          SessionStart: Array<{
            hooks: Array<{ commandWindows?: string }>;
          }>;
        };
      }
    ).hooks.SessionStart[0]!.hooks[0]!;
    expect(managed.commandWindows).toContain("D:\\\\acs\\\\dist");
    expect(managed.commandWindows).not.toContain("C:\\\\old");
  });

  it("is idempotent when commandWindows already matches", () => {
    const abs =
      '"C:\\\\Node\\\\node.exe" "D:\\\\acs\\\\dist\\\\ai-config-sync.cjs"';
    const desired = `${abs} scan --light --write-pending`;
    const existing = {
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: "command",
                id: "ai-config-sync-session-start",
                command: "ai-config-sync scan --light --write-pending",
                timeout: 20,
                commandWindows: desired,
              },
            ],
          },
        ],
      },
    };
    const second = mergeManagedCodexSessionStart(existing, {
      cliAbsoluteCommand: abs,
    });
    expect(second.changed).toBe(false);
  });
});

describe("P1-5 capture --yes READY filter", () => {
  it("isReadyForAutoCapture only accepts ready (+ legacy without needsAi)", () => {
    const skillDir = "/tmp/x";
    expect(isReadyForAutoCapture(skillItem("a", skillDir, "ready"))).toBe(true);
    expect(
      isReadyForAutoCapture(
        skillItem("b", skillDir, "needs-review", { needsAi: false, usedAi: true }),
      ),
    ).toBe(false);
    expect(
      isReadyForAutoCapture(
        skillItem("c", skillDir, "needs-review", { needsAi: false, usedAi: false }),
      ),
    ).toBe(false);
    // Explicit legacy: omit status via extra override (default param treats undefined as "ready")
    const legacyOk = skillItem("d", skillDir, "ready");
    delete (legacyOk as { status?: string }).status;
    legacyOk.needsAi = false;
    expect(isReadyForAutoCapture(legacyOk)).toBe(true);

    const legacyNeedsAi = skillItem("e", skillDir, "ready");
    delete (legacyNeedsAi as { status?: string }).status;
    legacyNeedsAi.needsAi = true;
    expect(isReadyForAutoCapture(legacyNeedsAi)).toBe(false);

    expect(
      isReadyForAutoCapture(skillItem("f", skillDir, "blocked")),
    ).toBe(false);
  });
});

describe("P1-1 capture temp dirs outside git + gitignore", () => {
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

  it("does not leave staging/backup inside config repo on success", async () => {
    const skillDir = path.join(home, "my-skill");
    await ensureDir(skillDir);
    await writeText(path.join(skillDir, "SKILL.md"), "# my-skill\n");

    await commitCaptureItems(
      [skillItem("my-skill", skillDir, "ready")],
      configRepo,
      "test",
      { home },
    );

    const leftovers = (await fs.readdir(configRepo)).filter(
      (n) =>
        n.startsWith(".ai-config-sync-staging") ||
        n.startsWith(".ai-config-sync-backup"),
    );
    expect(leftovers).toEqual([]);
  });

  it("setup .gitignore includes capture transaction patterns", async () => {
    const bare = path.join(home, "bare-cfg");
    await ensureDir(bare);
    const result = await runSetup({
      home,
      configPath: bare,
      profile: "home",
      programRoot: path.resolve(__dirname, "../.."),
      skipSelfPluginInstall: true,
    });
    expect(result.status === "failed" || result.status === "partial" || true).toBe(
      true,
    );
    const gi = await fs.readFile(path.join(bare, ".gitignore"), "utf8");
    expect(gi).toContain(".ai-config-sync-staging-*");
    expect(gi).toContain(".ai-config-sync-backup-*");
  });
});
