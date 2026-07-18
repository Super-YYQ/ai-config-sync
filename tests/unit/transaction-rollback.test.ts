import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  beginTransaction,
  confirmCreatedPaths,
  rollbackBackup,
} from "@ai-config-sync/state-manager";
import { pathExists, writeText, ensureDir } from "@ai-config-sync/core";

describe("transaction rollback", () => {
  let home: string;
  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "acs-tx-"));
  });
  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  it("restores replaced files and deletes newly created paths", async () => {
    const existing = path.join(home, "keep", "file.txt");
    await ensureDir(path.dirname(existing));
    await writeText(existing, "original\n");

    const created = path.join(home, "new", "skill", "SKILL.md");

    const tx = await beginTransaction(
      [existing, created],
      "test-tx",
      home,
    );
    // simulate apply: modify existing + create new
    await writeText(existing, "modified\n");
    await ensureDir(path.dirname(created));
    await writeText(created, "new skill\n");
    await confirmCreatedPaths(tx, [created], home);

    expect(await fs.readFile(existing, "utf8")).toBe("modified\n");
    expect(await pathExists(created)).toBe(true);

    await rollbackBackup(tx.id, home);

    expect(await fs.readFile(existing, "utf8")).toBe("original\n");
    expect(await pathExists(created)).toBe(false);
  });
});
