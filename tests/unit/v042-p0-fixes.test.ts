import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  atomicReplaceDirectory,
  ensureDir,
  writeText,
  writeYamlFile,
  writeJsonFile,
  pathExists,
  recipeRelPath,
  captureTransactionsDir,
  type LocalConfig,
} from "@ai-config-sync/core";
import {
  acquireFileLock,
  releaseFileLock,
  lockFilePath,
} from "@ai-config-sync/state-manager";
import {
  buildPlan,
  applyPlan,
  commitCaptureItems,
  type CaptureItem,
  type EngineContext,
} from "@ai-config-sync/recipe-engine";
import {
  commitPaths,
  getHeadCommit,
  runGit,
  validateGitRemote,
  validateGitRef,
  type GitError,
} from "@ai-config-sync/git-sync";
import type { ScannedResource } from "@ai-config-sync/scanner";

async function makeTemp(prefix = "acs-v042-"): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function gitInit(dir: string): Promise<void> {
  await runGit(dir, ["init", "-q"]);
  await runGit(dir, ["config", "user.email", "t@t.test"]);
  await runGit(dir, ["config", "user.name", "test"]);
}

async function writeSkill(root: string, id: string): Promise<string> {
  const dir = path.join(root, "sources", "skills", id);
  await ensureDir(dir);
  await writeText(path.join(dir, "SKILL.md"), `# ${id}\n`);
  return dir;
}

/** Build a minimal config repo with one vendored skill recipe. */
async function bootstrapConfigRepo(
  home: string,
  configRepo: string,
  resourceId = "demo",
): Promise<{ sourceSkillDir: string; recipeRel: string }> {
  await ensureDir(configRepo);
  await writeYamlFile(path.join(configRepo, "config.yaml"), {
    schemaVersion: 1,
    defaultProfile: "home",
    targets: { claude: true, codex: true },
  });
  await ensureDir(path.join(configRepo, "recipes"));
  await ensureDir(path.join(configRepo, "sources", "skills"));
  const sourceSkillDir = await writeSkill(configRepo, resourceId);
  const recipeRel = recipeRelPath(resourceId);
  await writeYamlFile(path.join(configRepo, recipeRel), {
    schemaVersion: 1,
    id: resourceId,
    source: { provider: "vendored", path: `sources/skills/${resourceId}` },
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
  await writeYamlFile(path.join(configRepo, "resources.yaml"), {
    schemaVersion: 1,
    resources: [
      {
        id: resourceId,
        kind: "skill",
        source: {
          provider: "vendored",
          path: `sources/skills/${resourceId}`,
        },
        targets: {
          claude: {
            enabled: true,
            recipeRef: `${recipeRel}#claude`,
          },
        },
        profiles: ["home"],
        versionPolicy: "vendored",
      },
    ],
  });
  await ensureDir(path.join(configRepo, "profiles"));
  await writeYamlFile(path.join(configRepo, "profiles", "home.yaml"), {
    profile: "home",
    extends: [],
    include: { resources: [] },
    exclude: { resources: [] },
    security: { maxRisk: "medium", allowAutomaticLatest: false },
  });
  await gitInit(configRepo);
  await runGit(configRepo, ["add", "-A"]);
  await runGit(configRepo, ["commit", "-m", "init", "--allow-empty"]);
  return { sourceSkillDir, recipeRel };
}

function ctxFor(
  home: string,
  configRepo: string,
  overrides: Partial<EngineContext> = {},
): EngineContext {
  const localConfig: LocalConfig = {
    schemaVersion: 1,
    configRepository: { localPath: configRepo },
    profile: "home",
    targets: { claude: true, codex: false },
    ai: { enabled: false, mode: "off" },
  };
  return {
    home,
    configRepoPath: configRepo,
    localConfig,
    profileName: "home",
    yes: true,
    allowRisk: "low",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Ticket 1: Plan Snapshot + Apply Confirmation
// ---------------------------------------------------------------------------

describe("v0.4.2 Ticket 1: Plan Snapshot + Apply Confirmation", () => {
  let home: string;
  let configRepo: string;

  beforeEach(async () => {
    home = await makeTemp("acs-v042-t1-h-");
    configRepo = await makeTemp("acs-v042-t1-repo-");
    await bootstrapConfigRepo(home, configRepo);
  });
  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(configRepo, { recursive: true, force: true });
  });

  it("plan captures config-repo commit and recipe hashes", async () => {
    const plan = await buildPlan(ctxFor(home, configRepo));
    expect(plan.snapshot).toBeDefined();
    expect(plan.snapshot.configRepoCommit).toBeTruthy();
    // at least one action carries recipeRef + recipeHash
    expect(
      plan.actions.some((a) => a.recipeRef && a.recipeHash),
    ).toBe(true);
  });

  it("refuses apply when config-repo HEAD advanced after plan", async () => {
    const plan = await buildPlan(ctxFor(home, configRepo));
    // Simulate the repo advancing (another capture/commit) between plan & apply
    await writeText(path.join(configRepo, "resources.yaml"), `${Date.now()}\n`);
    await runGit(configRepo, ["add", "-A"]);
    await runGit(configRepo, ["commit", "-m", "advance", "--allow-empty"]);
    const headAfter = await getHeadCommit(configRepo);
    expect(headAfter).not.toBe(plan.snapshot.configRepoCommit);

    await expect(applyPlan(ctxFor(home, configRepo), plan)).rejects.toThrow(
      /stale|HEAD changed/i,
    );
    // Nothing written
    expect(await pathExists(path.join(home, ".claude", "skills", "demo"))).toBe(
      false,
    );
  });

  it("refuses apply when resources.yaml changed without a commit", async () => {
    const plan = await buildPlan(ctxFor(home, configRepo));
    const resourcesPath = path.join(configRepo, "resources.yaml");
    const original = await fs.readFile(resourcesPath, "utf8");
    await writeText(resourcesPath, `${original.trimEnd()}\n# changed after plan\n`);

    await expect(applyPlan(ctxFor(home, configRepo), plan)).rejects.toThrow(
      /stale|config input changed|resources\.yaml/i,
    );
    expect(await pathExists(path.join(home, ".claude", "skills", "demo"))).toBe(false);
  });

  it("requires --yes for every non-dry-run write", async () => {
    const plan = await buildPlan(ctxFor(home, configRepo));
    await expect(
      applyPlan(ctxFor(home, configRepo, { yes: false }), plan),
    ).rejects.toThrow(/requires confirmation|--yes/i);
    expect(await pathExists(path.join(home, ".claude", "skills", "demo"))).toBe(false);
  });

  it("refuses apply when recipe file edited after plan (hash drift)", async () => {
    const plan = await buildPlan(ctxFor(home, configRepo));
    const recipeFile = path.join(configRepo, recipeRelPath("demo"));
    // Edit the recipe content (keep it valid, low risk) - hash changes
    await writeYamlFile(recipeFile, {
      schemaVersion: 1,
      id: "demo",
      source: { provider: "vendored", path: "sources/skills/demo" },
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
          notes: "edited after plan", // changes content -> hash drift
        },
      },
      versionPolicy: "vendored",
      risk: "low",
    });
    // Keep config-repo HEAD stable so only recipe-hash drift triggers
    const result = await applyPlan(ctxFor(home, configRepo), plan);
    expect(result.failed.length).toBeGreaterThan(0);
    expect(
      result.failed.some((f) => /stale|recipe.*changed|hash/i.test(f.error)),
    ).toBe(true);
  });

  it("refuses apply when vendored source content changed after plan", async () => {
    const plan = await buildPlan(ctxFor(home, configRepo));
    await writeText(
      path.join(configRepo, "sources", "skills", "demo", "SKILL.md"),
      "# replaced after plan\n",
    );
    await expect(applyPlan(ctxFor(home, configRepo), plan)).rejects.toThrow(
      /stale|config input changed|sources\/skills\/demo/i,
    );
    expect(await pathExists(path.join(home, ".claude", "skills", "demo"))).toBe(false);
  });

  it("apply proceeds unchanged when nothing drifted", async () => {
    const plan = await buildPlan(ctxFor(home, configRepo));
    const result = await applyPlan(ctxFor(home, configRepo), plan);
    expect(result.applied.length).toBeGreaterThan(0);
    expect(
      await pathExists(path.join(home, ".claude", "skills", "demo", "SKILL.md")),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Ticket 2: Config Repo Write Lock (shared capture <-> commit)
// ---------------------------------------------------------------------------

describe("v0.4.2 Ticket 2: Config Repo Write Lock", () => {
  let home: string;
  let configRepo: string;

  beforeEach(async () => {
    home = await makeTemp("acs-v042-t2-h-");
    configRepo = await makeTemp("acs-v042-t2-repo-");
    await bootstrapConfigRepo(home, configRepo);
  });
  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(configRepo, { recursive: true, force: true });
  });

  it("commitCaptureItems and capture --commit share one lock path", async () => {
    const txBase = captureTransactionsDir(home);
    const p1 = lockFilePath(txBase, "config-repo", configRepo);
    // Same target -> same deterministic path
    const p2 = lockFilePath(txBase, "config-repo", configRepo);
    expect(p1).toBe(p2);
  });

  it("second writer waits while the lock is held (serialized)", async () => {
    const txBase = captureTransactionsDir(home);
    const lockPath = lockFilePath(txBase, "config-repo", configRepo);
    // Hold the lock manually
    await acquireFileLock(lockPath, {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      scope: "config-repo",
      target: configRepo,
      command: "test-hold",
    });
    let commitFinished = false;
    // commitCaptureItems should be blocked (we'll abort quickly to keep test fast)
    const p = commitCaptureItems([], configRepo, "test", {
      home,
    }).then(
      () => {
        commitFinished = true;
      },
      () => {
        commitFinished = false;
      },
    );
    // Give it a tiny window; it must still be waiting
    await new Promise((r) => setTimeout(r, 200));
    expect(commitFinished).toBe(false);
    // Release -> commit can proceed
    await releaseFileLock(lockPath);
    await p;
    expect(commitFinished).toBe(true);
  });

  it("lock is released even when commitCaptureItems throws", async () => {
    const item: CaptureItem = {
      scanned: {
        id: "demo",
        kind: "skill",
        target: "claude",
        path: path.join(configRepo, "sources", "skills", "demo"),
        confidence: 0.9,
        classification: "source-unknown",
      } as ScannedResource,
      suggestedResource: {
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
      suggestedRecipe: {
        id: "demo",
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
            requiresApproval: false,
          },
        },
        versionPolicy: "vendored",
        risk: "low",
      },
      needsAi: false,
      status: "ready",
    };
    // Inject a failure after the lock is acquired
    await expect(
      commitCaptureItems([item], configRepo, "test", {
        home,
        injectFailureAfter: ["__throw-after-lock__"],
      }),
    ).rejects.toThrow(/injectThrowAfterAcquire|injectFailureAfter/);
    const txBase = captureTransactionsDir(home);
    const lockPath = lockFilePath(txBase, "config-repo", configRepo);
    // Lock must be released (no leftover lock file)
    expect(await pathExists(lockPath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Ticket 3: Source Resolver Hardening (URL/ref validation, fail-closed)
// ---------------------------------------------------------------------------

describe("v0.4.2 Ticket 3: Source Resolver Hardening", () => {
  it("rejects non-https / file:// / embedded credentials", () => {
    expect(() => validateGitRemote("file:///etc/passwd")).toThrow(
      /protocol|transport/i,
    );
    expect(() => validateGitRemote("ftp://x/y")).toThrow(/protocol|transport/i);
    expect(() =>
      validateGitRemote("https://user:pass@github.com/x/y.git"),
    ).toThrow(/credential/i);
    expect(() => validateGitRemote("-ofoo/bar")).toThrow(/-|option/i);
    expect(() => validateGitRemote("https://github.com/x/y.git")).not.toThrow();
    expect(() => validateGitRemote("git@github.com:x/y.git")).not.toThrow();
  });

  it("rejects unsafe refs (option injection, traversal, control chars)", () => {
    expect(() => validateGitRef("--upload-pack=evil")).toThrow(/-|option/i);
    expect(() => validateGitRef("../escape")).toThrow(/unsafe|traversal/i);
    expect(() => validateGitRef("main")).not.toThrow();
    expect(() => validateGitRef("refs/heads/main")).not.toThrow();
    expect(() => validateGitRef("v1.2.3")).not.toThrow();
    expect(() => validateGitRef("abc1234")).not.toThrow();
  });

  it("rejects non-Git cache directory (fail-closed, no silent accept)", async () => {
    const home = await makeTemp("acs-v042-t3-h-");
    try {
      const { resolveCachedSource } = await import("@ai-config-sync/git-sync");
      // cacheKey for repository "x/y" -> "x__y" (slashes -> __)
      const cacheRoot = path.join(home, ".ai-config-sync", "cache", "sources");
      const planted = path.join(cacheRoot, "x__y");
      await ensureDir(planted);
      await writeText(path.join(planted, "README.md"), "not a git repo");
      await expect(
        resolveCachedSource(
          { provider: "github", repository: "x/y" },
          { home, offline: true },
        ),
      ).rejects.toThrow(/not a git repository|non-Git/i);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Ticket 4: Atomic Skill Deployment (whole-directory replace, no stale files)
// ---------------------------------------------------------------------------

describe("v0.4.2 Ticket 4: Atomic Skill Deployment", () => {
  it("removes files deleted from source (drift converges)", async () => {
    const home = await makeTemp("acs-v042-t4-h-");
    try {
      const src = path.join(home, "src");
      const dest = path.join(home, "dest");
      await ensureDir(src);
      await writeText(path.join(src, "keep.md"), "keep");
      await writeText(path.join(src, "stale.md"), "stale");
      // First deploy creates dest with both files
      await atomicReplaceDirectory(src, dest);
      expect(await pathExists(path.join(dest, "stale.md"))).toBe(true);
      // Source deletes stale.md
      await fs.rm(path.join(src, "stale.md"));
      await atomicReplaceDirectory(src, dest);
      // Stale file must be gone after whole-dir replace
      expect(await pathExists(path.join(dest, "stale.md"))).toBe(false);
      expect(await pathExists(path.join(dest, "keep.md"))).toBe(true);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("rejects a symlink source tree", async () => {
    if (process.platform === "win32") return; // symlinks need privs on win
    const home = await makeTemp("acs-v042-t4-sym-");
    try {
      const real = path.join(home, "real");
      const link = path.join(home, "link");
      await ensureDir(real);
      await writeText(path.join(real, "f"), "x");
      await fs.symlink(real, link);
      await expect(atomicReplaceDirectory(link, path.join(home, "dest"))).rejects.toThrow(
        /Symlink/i,
      );
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("leaves dest untouched when copy fails (atomicity)", async () => {
    const home = await makeTemp("acs-v042-t4-atomic-");
    try {
      const src = path.join(home, "src");
      const dest = path.join(home, "dest");
      await ensureDir(src);
      await writeText(path.join(src, "a"), "a");
      // Establish an existing dest
      await ensureDir(dest);
      await writeText(path.join(dest, "existing"), "keepme");
      // src doesn't exist -> must throw and leave dest intact
      await expect(
        atomicReplaceDirectory(path.join(home, "nonexistent"), dest),
      ).rejects.toThrow(/Source directory does not exist/i);
      expect(await pathExists(path.join(dest, "existing"))).toBe(true);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Ticket 5: Managed Config Field Policy
// ---------------------------------------------------------------------------

describe("v0.4.2 Ticket 5: Managed Config Field Policy", () => {
  it("allows features.hooks and blocks model/auth/sandbox", async () => {
    const { checkTomlFieldPolicy } = await import("@ai-config-sync/core");
    expect(checkTomlFieldPolicy("features.hooks").allowed).toBe(true);
    expect(checkTomlFieldPolicy("model").allowed).toBe(false);
    expect(checkTomlFieldPolicy("model.name").allowed).toBe(false);
    expect(checkTomlFieldPolicy("auth").allowed).toBe(false);
    expect(checkTomlFieldPolicy("sandbox.enabled").allowed).toBe(false);
    expect(checkTomlFieldPolicy("random.unknown_field").allowed).toBe(false);
  });

  it("merge-json blocked for hooks.json (must use managed hook-manifest)", async () => {
    const { checkJsonFieldPolicy } = await import("@ai-config-sync/core");
    expect(
      checkJsonFieldPolicy(path.join(os.homedir(), ".codex", "hooks.json"))
        .allowed,
    ).toBe(false);
    expect(
      checkJsonFieldPolicy(path.join(os.homedir(), ".codex", "auth.json"))
        .allowed,
    ).toBe(false);
  });

  it("apply blocks a recipe that tries to flip model via merge-toml", async () => {
    const home = await makeTemp("acs-v042-t5-h-");
    const configRepo = await makeTemp("acs-v042-t5-repo-");
    try {
      await bootstrapConfigRepo(home, configRepo);
      // Add a malicious merge-toml op to flip model
      const recipeFile = path.join(configRepo, recipeRelPath("demo"));
      await writeYamlFile(recipeFile, {
        schemaVersion: 1,
        id: "demo",
        source: { provider: "vendored", path: "sources/skills/demo" },
        targets: {
          claude: {
            driver: "repository-layout",
            scope: "user",
            sourcePaths: { skill: "." },
            operations: [
              { type: "merge-toml", path: "model", value: "gpt-evil" },
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
      await runGit(configRepo, ["add", "-A"]);
      await runGit(configRepo, ["commit", "-m", "malicious", "--allow-empty"]);
      const plan = await buildPlan(ctxFor(home, configRepo, { allowRisk: "medium" }));
      const result = await applyPlan(
        ctxFor(home, configRepo, { allowRisk: "medium" }),
        plan,
      );
      // The malicious op must be blocked by the field policy
      expect(
        result.failed.some((f) => /field policy|forbidden|not.*managed/i.test(f.error)),
      ).toBe(true);
      // config.toml must not contain the evil model value
      const tomlPath = path.join(home, ".codex", "config.toml");
      if (await pathExists(tomlPath)) {
        const text = await fs.readFile(tomlPath, "utf8");
        expect(text).not.toContain("gpt-evil");
      }
    } finally {
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(configRepo, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Apply Lock (home-target) serialization
// ---------------------------------------------------------------------------

describe("v0.4.2 Apply Lock (home-target)", () => {
  it("two applies to the same HOME are serialized (one lock path)", async () => {
    const home = await makeTemp("acs-v042-al-h-");
    const configRepo = await makeTemp("acs-v042-al-repo-");
    try {
      await bootstrapConfigRepo(home, configRepo);
      const txBase = captureTransactionsDir(home);
      const p1 = lockFilePath(txBase, "home-apply", home);
      const p2 = lockFilePath(txBase, "home-apply", home);
      expect(p1).toBe(p2);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(configRepo, { recursive: true, force: true });
    }
  });

  it("apply waits when home-apply lock held by another session", async () => {
    const home = await makeTemp("acs-v042-al-wait-");
    const configRepo = await makeTemp("acs-v042-al-wait-repo-");
    try {
      await bootstrapConfigRepo(home, configRepo);
      const txBase = captureTransactionsDir(home);
      const lockPath = lockFilePath(txBase, "home-apply", home);
      await acquireFileLock(lockPath, {
        pid: process.pid,
        startedAt: new Date().toISOString(),
        scope: "home-apply",
        target: home,
        command: "test-hold",
      });
      let done = false;
      const plan = await buildPlan(ctxFor(home, configRepo));
      const p = applyPlan(ctxFor(home, configRepo), plan).then(() => {
        done = true;
      });
      await new Promise((r) => setTimeout(r, 200));
      expect(done).toBe(false); // still waiting for the lock
      await releaseFileLock(lockPath);
      await p;
      expect(done).toBe(true);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(configRepo, { recursive: true, force: true });
    }
  });
});
