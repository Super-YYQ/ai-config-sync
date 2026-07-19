import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ensureDir,
  writeText,
  pathExists,
  validateRecipeRef,
  validateVendoredSourcePath,
  validateRecipeRelativePath,
  validateManagedWritePath,
  recomputeTargetRisk,
  assertNoSymlinksInTree,
  toStorageKey,
  recipeRelPath,
} from "@ai-config-sync/core";
import {
  commitCaptureItems,
  type CaptureItem,
} from "@ai-config-sync/recipe-engine";
import {
  commitPaths,
  runGit,
  parsePorcelainZ,
  isGitRepo,
} from "@ai-config-sync/git-sync";
import { runSetup } from "../../packages/cli/src/setup.js";
import type { ScannedResource } from "@ai-config-sync/scanner";

async function makeTemp(prefix = "acs-safe-"): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function skillItem(id: string, skillDir: string): CaptureItem {
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
        claude: {
          enabled: true,
          recipeRef: `${recipeRelPath(id)}#claude`,
        },
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
    status: "ready",
  };
}

describe("1. Capture lock always released", () => {
  let home: string;
  let configRepo: string;

  beforeEach(async () => {
    home = await makeTemp();
    configRepo = path.join(home, "cfg");
    await ensureDir(path.join(configRepo, "recipes"));
  });
  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  it("releases lock after corrupt resources.yaml so retry succeeds", async () => {
    // Corrupt resources.yaml
    await writeText(path.join(configRepo, "resources.yaml"), "not: [valid yaml: {{{");

    const skillDir = path.join(home, "s1");
    await ensureDir(skillDir);
    await writeText(path.join(skillDir, "SKILL.md"), "# s1\n");

    await expect(
      commitCaptureItems([skillItem("s1", skillDir)], configRepo, "t", {
        home,
      }),
    ).rejects.toThrow();

    // Fix file and retry — must NOT be lock busy
    await writeText(
      path.join(configRepo, "resources.yaml"),
      "schemaVersion: 1\nresources: []\n",
    );
    const result = await commitCaptureItems(
      [skillItem("s1", skillDir)],
      configRepo,
      "t",
      { home },
    );
    expect(result.changedRelPaths).toContain("resources.yaml");
    expect(result.changedRelPaths.some((p) => p.startsWith("recipes/"))).toBe(
      true,
    );
  });
});

describe("2. Restore path security", () => {
  it("rejects recipeRef outside recipes/", () => {
    const root = path.join(os.tmpdir(), "cfg-sec");
    expect(() => validateRecipeRef(root, "../etc/passwd")).toThrow();
    expect(() => validateRecipeRef(root, "sources/x.yaml")).toThrow(
      /recipes/,
    );
    expect(() =>
      validateRecipeRef(root, "recipes/ok.yaml#claude"),
    ).not.toThrow();
  });

  it("rejects vendored path outside sources/ and absolute paths", () => {
    const root = path.join(os.tmpdir(), "cfg-sec2");
    expect(() =>
      validateVendoredSourcePath(root, "/abs/path"),
    ).toThrow(/relative/);
    expect(() =>
      validateVendoredSourcePath(root, "recipes/x"),
    ).toThrow(/sources/);
    expect(() =>
      validateVendoredSourcePath(root, "sources/skills/a"),
    ).not.toThrow();
  });

  it("rejects absolute and .. in recipe relative paths", () => {
    expect(() =>
      validateRecipeRelativePath("sourcePaths.skill", "/etc/passwd"),
    ).toThrow();
    expect(() =>
      validateRecipeRelativePath("requiredPaths", "../secret"),
    ).toThrow();
    expect(() =>
      validateRecipeRelativePath("sourcePaths.skill", "."),
    ).not.toThrow();
  });

  it("rejects managed writes outside tool dirs", () => {
    const home = path.join(os.tmpdir(), "home-sec");
    expect(() =>
      validateManagedWritePath(home, "claude", path.join(home, "evil", "x")),
    ).toThrow(/managed/);
    expect(() =>
      validateManagedWritePath(
        home,
        "claude",
        path.join(home, ".claude", "skills", "ok"),
      ),
    ).not.toThrow();
  });

  it("recomputes risk and ignores recipe-declared low for marketplace", () => {
    const risk = recomputeTargetRisk({
      driver: "claude-marketplace",
      scope: "user",
      operations: [{ type: "install-plugin" }, { type: "enable-plugin" }],
      requiredPaths: [],
      requirements: [],
      verification: [],
      risk: "low",
      evidence: [],
      requiresApproval: true,
    });
    expect(risk).toBe("medium");
  });

  it("rejects symlink in source tree", async () => {
    if (process.platform === "win32") {
      // Creating symlinks may require admin on Windows — skip if fails
      return;
    }
    const root = await makeTemp("acs-sym-");
    try {
      await ensureDir(path.join(root, "real"));
      await writeText(path.join(root, "real", "a.txt"), "x\n");
      await fs.symlink(
        path.join(root, "real"),
        path.join(root, "link"),
        "dir",
      );
      await expect(assertNoSymlinksInTree(path.join(root, "link"))).rejects.toThrow(
        /Symlink/,
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("3. Setup defaults inside plugin", () => {
  let home: string;
  let configRepo: string;
  let pluginRoot: string;
  let prev: string | undefined;

  beforeEach(async () => {
    home = await makeTemp();
    configRepo = path.join(home, "cfg");
    await fs.cp(
      path.resolve(__dirname, "../../examples/private-config-template"),
      configRepo,
      { recursive: true },
    );
    pluginRoot = path.join(home, "plugin");
    await fs.cp(
      path.resolve(__dirname, "../../integrations/claude-plugin"),
      pluginRoot,
      { recursive: true },
    );
    prev = process.env.CLAUDE_PLUGIN_ROOT;
    process.env.CLAUDE_PLUGIN_ROOT = pluginRoot;
  });
  afterEach(async () => {
    if (prev === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
    else process.env.CLAUDE_PLUGIN_ROOT = prev;
    await fs.rm(home, { recursive: true, force: true });
  });

  it("does not install Codex skill/hooks by default inside plugin", async () => {
    const result = await runSetup({
      home,
      configPath: configRepo,
      profile: "home",
      preview: false,
    });
    expect(
      result.actions.some((a) => /INSTALL agents skill: config-sync/i.test(a)),
    ).toBe(false);
    expect(
      result.actions.some((a) => /MERGE Codex hooks/i.test(a)),
    ).toBe(false);
    expect(
      await pathExists(path.join(home, ".agents", "skills", "config-sync")),
    ).toBe(false);
    // local config targets.codex should be false
    const cfg = await fs.readFile(
      path.join(home, ".ai-config-sync", "config.yaml"),
      "utf8",
    );
    expect(cfg).toMatch(/codex:\s*false/);
  });

  it("installs Codex skill with --target codex but still skips hooks without flag", async () => {
    const result = await runSetup({
      home,
      configPath: configRepo,
      profile: "home",
      claude: false,
      codex: true,
      enableCodexHook: false,
      preview: false,
    });
    expect(
      result.actions.some((a) => /INSTALL agents skill: config-sync/i.test(a)),
    ).toBe(true);
    expect(
      result.actions.some((a) => /SKIP Codex SessionStart hook/i.test(a)),
    ).toBe(true);
    expect(
      result.actions.some((a) => /MERGE Codex hooks/i.test(a)),
    ).toBe(false);
  });
});

describe("4. Capture commit boundaries", () => {
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
    await writeText(path.join(configRepo, "README.md"), "# original\n");
    // init git repo
    await runGit(configRepo, ["init"]);
    await runGit(configRepo, ["config", "user.email", "test@example.com"]);
    await runGit(configRepo, ["config", "user.name", "Test"]);
    await runGit(configRepo, ["add", "-A"]);
    await runGit(configRepo, ["commit", "-m", "init"]);
  });
  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  it("commitPaths does not include pre-existing dirty README", async () => {
    // User edits README
    await writeText(path.join(configRepo, "README.md"), "# modified by user\n");

    const skillDir = path.join(home, "new-skill");
    await ensureDir(skillDir);
    await writeText(path.join(skillDir, "SKILL.md"), "# new\n");

    const written = await commitCaptureItems(
      [skillItem("new-skill", skillDir)],
      configRepo,
      "test",
      { home },
    );

    await commitPaths(
      configRepo,
      "capture: add new-skill",
      written.changedRelPaths,
    );

    // README must still be dirty / unstaged
    const status = await runGit(configRepo, ["status", "--porcelain=v1", "-z"]);
    const dirty = parsePorcelainZ(status.stdout);
    expect(dirty.some((p) => p === "README.md" || p.endsWith("README.md"))).toBe(
      true,
    );

    // Capture files should be committed (not in unstaged dirty as modified content from capture)
    // resources.yaml should not appear as untracked
    const untracked = dirty.filter((p) => !p.includes("README"));
    // After commitPaths, only README should remain dirty
    expect(untracked.every((p) => p.includes("README"))).toBe(true);
  });
});
