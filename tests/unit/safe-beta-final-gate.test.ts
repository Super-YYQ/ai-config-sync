import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ensureDir,
  writeText,
  writeYamlFile,
  pathExists,
  validateManagedWritePath,
  validateTargetRecipeForApply,
  recomputeTargetRisk,
  assertNoSymlinksInTree,
  recipeRelPath,
  type TargetRecipe,
  type LocalConfig,
} from "@ai-config-sync/core";
import {
  buildPlan,
  applyPlan,
  type EngineContext,
} from "@ai-config-sync/recipe-engine";
import {
  commitPaths,
  runGit,
  GitError,
  parsePorcelainZ,
} from "@ai-config-sync/git-sync";
import {
  commitCaptureItems,
  type CaptureItem,
} from "@ai-config-sync/recipe-engine";
import type { ScannedResource } from "@ai-config-sync/scanner";

async function makeTemp(prefix = "acs-final-"): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("Final Gate: managed write paths", () => {
  const home = path.join(os.tmpdir(), "acs-home-final");

  it("blocks Desktop/ssh relative dumps", () => {
    expect(() =>
      validateManagedWritePath(home, "claude", ".ssh/test"),
    ).toThrow(/managed|forbidden/i);
    expect(() =>
      validateManagedWritePath(home, "claude", "Desktop/test"),
    ).toThrow(/managed|forbidden/i);
    expect(() =>
      validateManagedWritePath(home, "codex", path.join(home, "Desktop", "x")),
    ).toThrow(/managed|forbidden/i);
  });

  it("blocks ~/.codex/auth.json and other secrets", () => {
    expect(() =>
      validateManagedWritePath(home, "codex", path.join(home, ".codex", "auth.json")),
    ).toThrow(/forbidden|managed/i);
    expect(() =>
      validateManagedWritePath(
        home,
        "codex",
        path.join(home, ".codex", "history.jsonl"),
      ),
    ).toThrow(/forbidden|managed/i);
  });

  it("allows codex config.toml, hooks.json, skills, hooks dir", () => {
    expect(() =>
      validateManagedWritePath(
        home,
        "codex",
        path.join(home, ".codex", "config.toml"),
      ),
    ).not.toThrow();
    expect(() =>
      validateManagedWritePath(
        home,
        "codex",
        path.join(home, ".codex", "hooks.json"),
      ),
    ).not.toThrow();
    expect(() =>
      validateManagedWritePath(
        home,
        "codex",
        path.join(home, ".agents", "skills", "x"),
      ),
    ).not.toThrow();
    expect(() =>
      validateManagedWritePath(
        home,
        "codex",
        path.join(home, ".codex", "skills", "y"),
      ),
    ).not.toThrow();
    expect(() =>
      validateManagedWritePath(
        home,
        "codex",
        path.join(home, ".codex", "hooks", "script.sh"),
      ),
    ).not.toThrow();
  });

  it("does not allow arbitrary ~/.codex/* just because config is there", () => {
    expect(() =>
      validateManagedWritePath(
        home,
        "codex",
        path.join(home, ".codex", "random.json"),
      ),
    ).toThrow(/managed/i);
  });

  it("validateTargetRecipeForApply blocks unsafe operation.to (no swallow)", () => {
    const recipe: TargetRecipe = {
      driver: "generic-skill",
      scope: "user",
      operations: [
        {
          type: "copy-directory",
          from: ".",
          to: path.join(home, ".ssh", "id_rsa"),
        },
      ],
      requiredPaths: [],
      requirements: [],
      verification: [],
      risk: "low",
      evidence: [],
      requiresApproval: true,
    };
    expect(() =>
      validateTargetRecipeForApply(home, "claude", "/tmp/cfg", recipe),
    ).toThrow(/managed|forbidden/i);
  });
});

describe("Final Gate: apply revalidation after plan", () => {
  let home: string;
  let configRepo: string;

  beforeEach(async () => {
    home = await makeTemp();
    configRepo = path.join(home, "cfg");
    await ensureDir(path.join(configRepo, "recipes"));
    await ensureDir(path.join(configRepo, "profiles"));
    await ensureDir(path.join(configRepo, "sources", "skills", "demo"));
    await writeText(
      path.join(configRepo, "sources", "skills", "demo", "SKILL.md"),
      "# demo\n",
    );
    await writeYamlFile(path.join(configRepo, "resources.yaml"), {
      schemaVersion: 1,
      resources: [
        {
          id: "demo",
          kind: "skill",
          source: { provider: "vendored", path: "sources/skills/demo" },
          targets: {
            claude: {
              enabled: true,
              recipeRef: "recipes/demo.yaml#claude",
            },
          },
          profiles: ["home"],
          versionPolicy: "vendored",
        },
      ],
    });
    await writeYamlFile(path.join(configRepo, "profiles", "home.yaml"), {
      profile: "home",
      extends: [],
      include: { resources: [] },
      exclude: { resources: [] },
      security: {
        maxRisk: "high",
        allowAutomaticLatest: false,
        secrets: { provider: "local-only" },
      },
    });
    await writeYamlFile(path.join(configRepo, "recipes", "demo.yaml"), {
      schemaVersion: 1,
      id: "demo",
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
          requiresApproval: false,
        },
      },
      versionPolicy: "vendored",
      risk: "low",
    });
  });
  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  it("blocks apply when recipe is mutated to dangerous path after plan", async () => {
    const localConfig: LocalConfig = {
      schemaVersion: 1,
      configRepository: { localPath: configRepo },
      profile: "home",
      targets: { claude: true, codex: false },
      ai: { enabled: false, mode: "off" },
    };
    const ctx: EngineContext = {
      home,
      configRepoPath: configRepo,
      localConfig,
      profileName: "home",
      yes: true,
      allowRisk: "high",
    };

    const plan = await buildPlan(ctx);
    // Plan should be non-manual for the safe recipe
    expect(plan.actions.some((a) => a.type === "MANUAL" && /security/i.test(a.description))).toBe(
      false,
    );

    // Mutate recipe to write outside managed dirs
    await writeYamlFile(path.join(configRepo, "recipes", "demo.yaml"), {
      schemaVersion: 1,
      id: "demo",
      targets: {
        claude: {
          driver: "generic-skill",
          scope: "user",
          sourcePaths: { skill: "." },
          operations: [
            {
              type: "copy-directory",
              from: ".",
              to: path.join(home, ".ssh", "stolen"),
            },
          ],
          requiredPaths: ["SKILL.md"],
          requirements: [],
          verification: [],
          risk: "low",
          evidence: [],
          requiresApproval: false,
        },
      },
      versionPolicy: "vendored",
      risk: "low",
    });

    const result = await applyPlan(ctx, plan);
    expect(result.failed.length).toBeGreaterThan(0);
    expect(
      result.failed.some((f) => /security|managed|forbidden|risk/i.test(f.error)),
    ).toBe(true);
    // Must not create the dangerous path
    expect(await pathExists(path.join(home, ".ssh", "stolen"))).toBe(false);
  });
});

describe("Final Gate: git cache nested symlink blocks restore", () => {
  it("assertNoSymlinksInTree finds nested symlink", async () => {
    if (process.platform === "win32") return;
    const root = await makeTemp("acs-nsym-");
    try {
      await ensureDir(path.join(root, "a", "b"));
      await writeText(path.join(root, "a", "b", "f.txt"), "x\n");
      await fs.symlink(
        path.join(root, "a", "b", "f.txt"),
        path.join(root, "a", "b", "link.txt"),
      );
      await expect(assertNoSymlinksInTree(root)).rejects.toThrow(/Symlink rejected/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("Final Gate: commitPaths refuses foreign staged files", () => {
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
    await runGit(configRepo, ["init"]);
    await runGit(configRepo, ["config", "user.email", "t@example.com"]);
    await runGit(configRepo, ["config", "user.name", "T"]);
    await runGit(configRepo, ["add", "-A"]);
    await runGit(configRepo, ["commit", "-m", "init"]);
  });
  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  it("stops when README is pre-staged; leaves index unchanged; no capture commit", async () => {
    await writeText(path.join(configRepo, "README.md"), "# staged by user\n");
    await runGit(configRepo, ["add", "--", "README.md"]);

    // Capture would produce resources.yaml etc.
    const skillDir = path.join(home, "sk");
    await ensureDir(skillDir);
    await writeText(path.join(skillDir, "SKILL.md"), "# sk\n");

    const scanned: ScannedResource = {
      id: "sk",
      kind: "skill",
      target: "claude",
      path: skillDir,
      confidence: 0.9,
      classification: "source-unknown",
    };
    const item: CaptureItem = {
      scanned,
      suggestedResource: {
        id: "sk",
        kind: "skill",
        source: { provider: "local", path: skillDir },
        targets: {
          claude: { enabled: true, recipeRef: `${recipeRelPath("sk")}#claude` },
        },
        profiles: ["home"],
        versionPolicy: "vendored",
      },
      suggestedRecipe: {
        id: "sk",
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

    const written = await commitCaptureItems([item], configRepo, "t", { home });

    await expect(
      commitPaths(configRepo, "capture: sk", written.changedRelPaths),
    ).rejects.toThrow(GitError);

    // README still staged
    const staged = await runGit(configRepo, [
      "diff",
      "--cached",
      "--name-only",
      "-z",
    ]);
    const names = (staged.stdout || "")
      .split("\0")
      .map((s) => s.trim())
      .filter(Boolean);
    expect(names).toContain("README.md");

    // No new capture commit — HEAD still "init"
    const log = await runGit(configRepo, ["log", "-1", "--pretty=%s"]);
    expect(log.stdout.trim()).toBe("init");
  });

  it("rejects absolute and .. in relPaths", async () => {
    await expect(
      commitPaths(configRepo, "x", ["/etc/passwd"]),
    ).rejects.toThrow(/absolute/);
    await expect(
      commitPaths(configRepo, "x", ["../outside"]),
    ).rejects.toThrow(/traversal/);
  });
});
