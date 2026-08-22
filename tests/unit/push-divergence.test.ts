import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runGit, pushRepo, pullRepo } from "@ai-config-sync/git-sync";
import { writeText } from "@ai-config-sync/core";

describe("push/pull multi-machine divergence handling", () => {
  let base: string;
  let origin: string;
  let work: string;

  beforeEach(async () => {
    base = await fs.mkdtemp(path.join(os.tmpdir(), "acs-divergence-"));
    origin = path.join(base, "origin.git");
    work = path.join(base, "machine-b");

    await runGit(base, ["init", "--bare", "-q", "-b", "main", origin]);
    await runGit(base, ["clone", "-q", origin, work]);
    await runGit(work, ["config", "user.email", "e2e@test.local"]);
    await runGit(work, ["config", "user.name", "e2e"]);
    await writeText(path.join(work, "resources.yaml"), "schemaVersion: 1\n");
    await runGit(work, ["add", "resources.yaml"]);
    await runGit(work, ["commit", "-q", "-m", "init"]);
    await runGit(work, ["push", "-q", "origin", "HEAD:refs/heads/main"]);
  });

  afterEach(async () => {
    await fs.rm(base, { recursive: true, force: true });
  });

  it("pushes cleanly when up to date", async () => {
    await expect(pushRepo(work)).resolves.toBeTruthy();
  });

  it("refuses to push after divergence with actionable rebase guidance", async () => {
    // Machine A pushes a capture...
    const other = path.join(base, "machine-a");
    await runGit(base, ["clone", "-q", origin, other]);
    await runGit(other, ["config", "user.email", "a@test.local"]);
    await runGit(other, ["config", "user.name", "a"]);
    await writeText(path.join(other, "a.txt"), "machine-a capture\n");
    await runGit(other, ["add", "a.txt"]);
    await runGit(other, ["commit", "-q", "-m", "capture from A"]);
    await runGit(other, ["push", "-q", "origin", "HEAD:refs/heads/main"]);

    // ...while machine B commits locally without pulling first.
    await writeText(path.join(work, "b.txt"), "machine-b capture\n");
    await runGit(work, ["add", "b.txt"]);
    await runGit(work, ["commit", "-q", "-m", "capture from B"]);

    // The divergence must be detected from fresh remote state (pushRepo
    // fetches first) and the error must tell the user how to resolve it.
    await expect(pushRepo(work)).rejects.toThrow(/git pull --rebase/);
    await expect(pushRepo(work)).rejects.toThrow(/union of resource ids/);
    // ff-only pull must also refuse rather than merge silently
    await expect(pullRepo(work)).rejects.toThrow(/Refusing to pull/);
  });

  it("fast-forwards machine B when only the remote moved", async () => {
    const other = path.join(base, "machine-a");
    await runGit(base, ["clone", "-q", origin, other]);
    await runGit(other, ["config", "user.email", "a@test.local"]);
    await runGit(other, ["config", "user.name", "a"]);
    await writeText(path.join(other, "a.txt"), "machine-a capture\n");
    await runGit(other, ["add", "a.txt"]);
    await runGit(other, ["commit", "-q", "-m", "capture from A"]);
    await runGit(other, ["push", "-q", "origin", "HEAD:refs/heads/main"]);

    await expect(pullRepo(work)).resolves.toBeTruthy();
    // After the pull, B can capture-commit and push without divergence.
    await writeText(path.join(work, "b.txt"), "machine-b capture\n");
    await runGit(work, ["add", "b.txt"]);
    await runGit(work, ["commit", "-q", "-m", "capture from B"]);
    await expect(pushRepo(work)).resolves.toBeTruthy();
  });
});
