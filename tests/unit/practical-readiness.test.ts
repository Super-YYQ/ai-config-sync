import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  cacheDir,
  ensureDir,
  pathExists,
  writeText,
  writeYamlFile,
  type LocalConfig,
} from "@ai-config-sync/core";
import {
  acquireFileLock,
  appendPendingEvents,
  loadPending,
  lockFilePath,
  markInstalled,
  getState,
  releaseFileLock,
} from "@ai-config-sync/state-manager";
import { resolveCachedSource, runGit } from "@ai-config-sync/git-sync";
import { buildPlan } from "@ai-config-sync/recipe-engine";

const roots: string[] = [];

async function temp(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(async () => {
  while (roots.length) {
    await fs.rm(roots.pop()!, { recursive: true, force: true });
  }
});

describe("practical readiness hardening", () => {
  it("an old lock owner cannot delete a replacement lock", async () => {
    const home = await temp("acs-lock-owner-");
    const lockPath = lockFilePath(path.join(home, "locks"), "repo", home);
    await acquireFileLock(lockPath, {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      scope: "repo",
      target: home,
      command: "test",
    });
    const replacement = {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      ownerId: "replacement-owner",
      scope: "repo",
      target: home,
      command: "replacement",
    };
    await fs.writeFile(lockPath, JSON.stringify(replacement), "utf8");

    await releaseFileLock(lockPath);
    expect(await pathExists(lockPath)).toBe(true);
  });

  it("does not break a fresh lock while its owner is still writing", async () => {
    const home = await temp("acs-lock-partial-");
    const lockPath = lockFilePath(path.join(home, "locks"), "repo", home);
    await ensureDir(path.dirname(lockPath));
    await fs.writeFile(lockPath, "", "utf8");

    await expect(
      acquireFileLock(
        lockPath,
        {
          pid: process.pid,
          startedAt: new Date().toISOString(),
          scope: "repo",
          target: home,
          command: "contender",
        },
        { maxAttempts: 2, baseDelayMs: 1, stepDelayMs: 1 },
      ),
    ).rejects.toThrow(/Lock busy/);
    expect(await pathExists(lockPath)).toBe(true);
  });

  it("serializes concurrent pending-event and state updates", async () => {
    const home = await temp("acs-state-race-");
    await Promise.all(
      Array.from({ length: 16 }, (_, i) =>
        appendPendingEvents([{ type: "resource-added", resourceId: `r${i}` }], home),
      ),
    );
    const pending = await loadPending(home);
    expect(pending).toHaveLength(16);
    expect(new Set(pending.map((batch) => batch.batchId)).size).toBe(16);

    await Promise.all([
      markInstalled("shared", "claude", { status: "installed" }, home),
      markInstalled("shared", "codex", { status: "installed" }, home),
    ]);
    const state = await getState(home);
    expect(state.installed.shared?.claude?.status).toBe("installed");
    expect(state.installed.shared?.codex?.status).toBe("installed");
  });

  it("checks out the requested cached commit even while offline", async () => {
    const home = await temp("acs-source-ref-");
    const root = path.join(cacheDir(home), "sources", "owner__repo");
    await ensureDir(root);
    await runGit(root, ["init", "-q"]);
    await runGit(root, ["config", "user.email", "test@example.invalid"]);
    await runGit(root, ["config", "user.name", "test"]);
    await runGit(root, ["remote", "add", "origin", "https://github.com/owner/repo.git"]);
    await writeText(path.join(root, "value.txt"), "one\n");
    await runGit(root, ["add", "value.txt"]);
    await runGit(root, ["commit", "-m", "one"]);
    const first = (await runGit(root, ["rev-parse", "HEAD"])).stdout.trim();
    await writeText(path.join(root, "value.txt"), "two\n");
    await runGit(root, ["add", "value.txt"]);
    await runGit(root, ["commit", "-m", "two"]);

    const resolved = await resolveCachedSource(
      { provider: "github", repository: "owner/repo", commit: first },
      { home, offline: true },
    );
    expect(resolved?.commit).toBe(first);
    expect((await fs.readFile(path.join(root, "value.txt"), "utf8")).trim()).toBe("one");

    await writeText(path.join(root, "untracked.txt"), "tampered\n");
    await expect(
      resolveCachedSource(
        { provider: "github", repository: "owner/repo", commit: first },
        { home, offline: true },
      ),
    ).rejects.toThrow(/uncommitted|untracked|mutable source/i);
  });

  it("resolves transitive profile inheritance and rejects cycles", async () => {
    const home = await temp("acs-profile-home-");
    const repo = await temp("acs-profile-repo-");
    await ensureDir(path.join(repo, "profiles"));
    await writeYamlFile(path.join(repo, "resources.yaml"), {
      schemaVersion: 1,
      resources: [],
    });
    await writeYamlFile(path.join(repo, "profiles", "base.yaml"), {
      profile: "base",
      extends: [],
      include: { resources: [] },
      exclude: { resources: [] },
    });
    await writeYamlFile(path.join(repo, "profiles", "middle.yaml"), {
      profile: "middle",
      extends: ["base"],
      include: { resources: [] },
      exclude: { resources: [] },
    });
    await writeYamlFile(path.join(repo, "profiles", "home.yaml"), {
      profile: "home",
      extends: ["middle"],
      include: { resources: [] },
      exclude: { resources: [] },
    });
    const localConfig: LocalConfig = {
      schemaVersion: 1,
      configRepository: { localPath: repo },
      profile: "home",
      targets: { claude: true, codex: false },
      ai: { enabled: false, mode: "off" },
    };
    const plan = await buildPlan({
      home,
      configRepoPath: repo,
      localConfig,
      profileName: "home",
    });
    expect(plan.snapshot.inputHashes).toHaveProperty("profiles/base.yaml");
    expect(plan.snapshot.inputHashes).toHaveProperty("profiles/middle.yaml");

    await writeYamlFile(path.join(repo, "profiles", "base.yaml"), {
      profile: "base",
      extends: ["home"],
      include: { resources: [] },
      exclude: { resources: [] },
    });
    await expect(
      buildPlan({
        home,
        configRepoPath: repo,
        localConfig,
        profileName: "home",
      }),
    ).rejects.toThrow(/cycle/i);
  });
});
