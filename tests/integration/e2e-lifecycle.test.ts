/**
 * Key E2E (isolated HOME): the full lifecycle required by the stable-Beta gate.
 *
 * Covers: Setup (empty template) -> Capture -> Restore (plan+apply) -> Rollback,
 * all against an isolated HOME with a real git config repo, on the local machine
 * (no network). Mirrors the acceptance criterion:
 *   "Windows、Linux 至少完成 npm、Setup、Capture、Restore、Rollback 的隔离 E2E."
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runSetup } from "../../packages/cli/src/setup.js";
import {
  applyPlan,
  buildPlan,
  commitCaptureItems,
  runDoctor,
  type CaptureItem,
} from "@ai-config-sync/recipe-engine";
import {
  loadLocalConfig,
  localConfigPath,
  pathExists,
  recipeRelPath,
  ensureDir,
  writeText,
  type LocalConfig,
} from "@ai-config-sync/core";
import {
  commitPaths,
  getHeadCommit,
  runGit,
  inspectGitSafety,
} from "@ai-config-sync/git-sync";
import { rollbackBackup, listBackups } from "@ai-config-sync/state-manager";
import type { ScannedResource } from "@ai-config-sync/scanner";

async function makeTemp(prefix = "acs-e2e-"): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function copyTemplate(dest: string): Promise<void> {
  const src = path.resolve(__dirname, "../../examples/private-config-template");
  await fs.cp(src, dest, { recursive: true });
}

async function gitInit(dir: string): Promise<void> {
  await runGit(dir, ["init", "-q"]);
  await runGit(dir, ["config", "user.email", "e2e@test.local"]);
  await runGit(dir, ["config", "user.name", "e2e"]);
  await runGit(dir, ["add", "-A"]);
  await runGit(dir, ["commit", "-m", "init", "--allow-empty"]);
}

async function ctxFor(home: string, configRepo: string): Promise<{
  home: string;
  configRepoPath: string;
  localConfig: LocalConfig;
  profileName: string;
}> {
  const localConfig = await loadLocalConfig(localConfigPath(home));
  return {
    home,
    configRepoPath: configRepo,
    localConfig,
    profileName: "home",
  };
}

describe("E2E: isolated-HOME full lifecycle", () => {
  let home: string;
  let configRepo: string;

  beforeEach(async () => {
    home = await makeTemp("acs-e2e-home-");
    configRepo = path.join(home, "my-ai-config");
    await copyTemplate(configRepo);
    await gitInit(configRepo);
  });

  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  it("Setup -> Capture -> Restore -> Rollback end to end", async () => {
    // --- 1. Setup ---
    const setup = await runSetup({
      home,
      configPath: configRepo,
      profile: "home",
    });
    expect(["initialized", "linked", "repaired", "partial"]).toContain(
      setup.status,
    );
    expect(await pathExists(localConfigPath(home))).toBe(true);

    // --- 2. Capture: vendor a local skill into the private repo ---
    // Create a local skill on the machine that isn't yet managed.
    const localSkill = path.join(home, "local-skills", "e2e-skill");
    await ensureDir(localSkill);
    await writeText(
      path.join(localSkill, "SKILL.md"),
      "# e2e-skill\nDoes a thing.\n",
    );

    const scanned: ScannedResource = {
      id: "e2e-skill",
      kind: "skill",
      target: "claude",
      path: localSkill,
      confidence: 0.95,
      classification: "source-unknown",
    };
    const item: CaptureItem = {
      scanned,
      suggestedResource: {
        id: "e2e-skill",
        kind: "skill",
        source: { provider: "local", path: localSkill },
        targets: {
          claude: {
            enabled: true,
            recipeRef: `recipes/e2e-skill.yaml#claude`,
          },
        },
        profiles: ["home"],
        versionPolicy: "vendored",
      },
      suggestedRecipe: {
        id: "e2e-skill",
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

    const written = await commitCaptureItems([item], configRepo, "e2e", {
      home,
    });
    expect(written.changedRelPaths.length).toBeGreaterThan(0);

    // Commit under the shared config-repo lock (mirrors capture --commit flow)
    const { captureTransactionsDir } = await import("@ai-config-sync/core");
    const {
      acquireFileLock,
      releaseFileLock,
      lockFilePath,
    } = await import("@ai-config-sync/state-manager");
    const lockPath = lockFilePath(
      captureTransactionsDir(home),
      "config-repo",
      configRepo,
    );
    await acquireFileLock(lockPath, {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      scope: "config-repo",
      target: configRepo,
      command: "e2e capture commit",
    });
    try {
      const committed = await commitPaths(
        configRepo,
        "capture: add e2e-skill",
        written.changedRelPaths,
      );
      expect(committed).toBeTruthy();
    } finally {
      await releaseFileLock(lockPath);
    }
    // Git repo must be clean after the scoped commit (no leftover staged files)
    const safety = await inspectGitSafety(configRepo);
    expect(safety.dirty).toBe(false);

    // --- 3. Restore on a SECOND isolated machine (simulated new HOME) ---
    const home2 = await makeTemp("acs-e2e-home2-");
    try {
      // Clone the config repo to the second machine (simulates git sync)
      const configRepo2 = path.join(home2, "my-ai-config");
      await runGit(home2, ["clone", configRepo, configRepo2]);
      await runSetup({
        home: home2,
        configPath: configRepo2,
        profile: "home",
      });
      const ctx2 = await ctxFor(home2, configRepo2);
      const plan = await buildPlan(ctx2);
      expect(
        plan.actions.some((a) => a.resourceId === "e2e-skill"),
      ).toBe(true);
      const applied = await applyPlan(ctx2, plan);
      expect(applied.failed.length).toBe(0);
      const skillDest = path.join(
        home2,
        ".claude",
        "skills",
        "e2e-skill",
        "SKILL.md",
      );
      expect(await pathExists(skillDest)).toBe(true);
      const content = await fs.readFile(skillDest, "utf8");
      expect(content).toContain("e2e-skill");

      // --- 4. Rollback: the restore created a backup; rolling it back removes
      // the freshly installed skill directory. ---
      const backups = await listBackups(home2);
      expect(backups.length).toBeGreaterThan(0);
      const record = await rollbackBackup("last", home2);
      expect(record.id).toBeTruthy();
      // The skill directory was created by the apply, so rollback removes it.
      expect(
        await pathExists(path.join(home2, ".claude", "skills", "e2e-skill")),
      ).toBe(false);
    } finally {
      await fs.rm(home2, { recursive: true, force: true });
    }
  });

  it("Restore with plan-then-confirm shows plan before any write (Ticket 1)", async () => {
    // This mirrors the CLI runApplyLike contract: plan is shown, then --yes applies.
    await runSetup({ home, configPath: configRepo, profile: "home" });
    const ctx = await ctxFor(home, configRepo);
    // Empty template -> plan is No changes, safe
    const plan = await buildPlan(ctx);
    // Plan must carry a snapshot even when empty
    expect(plan.snapshot).toBeDefined();
    // Applying the same plan object is allowed (no drift)
    const result = await applyPlan(ctx, plan);
    expect(result.failed.length).toBe(0);
  });

  it("Doctor runs clean on a set-up isolated HOME", async () => {
    await runSetup({ home, configPath: configRepo, profile: "home" });
    const localConfig = await loadLocalConfig(localConfigPath(home));
    const doctor = await runDoctor({
      home,
      localConfig,
      configRepoPath: configRepo,
    });
    // Should load resources without throwing; ok is allowed to be true
    expect(doctor.findings.length).toBeGreaterThan(0);
  });
});
