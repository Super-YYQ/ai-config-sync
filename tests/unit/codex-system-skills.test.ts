import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  scanLocal,
  inventryDiff,
  isSystemSkillDirectory,
  isNeverCapturableResource,
} from "@ai-config-sync/scanner";
import { buildCaptureProposals } from "@ai-config-sync/recipe-engine";
import { ensureDir, writeText } from "@ai-config-sync/core";

async function makeTempHome(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "acs-system-"));
}

describe("Codex .system skill exclusion", () => {
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

    // Codex system skills under modern agents root
    await ensureDir(
      path.join(home, ".agents", "skills", ".system", "example"),
    );
    await writeText(
      path.join(home, ".agents", "skills", ".system", "example", "SKILL.md"),
      "---\nname: example\n---\n# system skill\n",
    );

    // Normal user skill must still work
    await ensureDir(path.join(home, ".agents", "skills", "my-skill"));
    await writeText(
      path.join(home, ".agents", "skills", "my-skill", "SKILL.md"),
      "---\nname: my-skill\n---\n# user skill\n",
    );
  });

  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  it("isSystemSkillDirectory recognizes Codex .system only", () => {
    expect(isSystemSkillDirectory("codex", ".system")).toBe(true);
    expect(isSystemSkillDirectory("claude", ".system")).toBe(false);
    expect(isSystemSkillDirectory("codex", "my-skill")).toBe(false);
  });

  it("classifies Codex .system as system-cache", async () => {
    const result = await scanLocal({ home, light: true, targets: { codex: true, claude: false } });
    const system = result.resources.find((r) => r.id === ".system");
    expect(system).toBeDefined();
    expect(system!.classification).toBe("system-cache");
    expect(system!.metadata?.managedBy).toBe("codex");
    expect(system!.metadata?.role).toBe("system-skills");
  });

  it("still scans normal user skills", async () => {
    const result = await scanLocal({ home, light: true, targets: { codex: true, claude: false } });
    const mine = result.resources.find((r) => r.id === "my-skill");
    expect(mine).toBeDefined();
    expect(mine!.classification).not.toBe("system-cache");
  });

  it("excludes .system from inventryDiff / pending candidates", async () => {
    const result = await scanLocal({ home, light: true, targets: { codex: true, claude: false } });
    const unmanaged = inventryDiff(result, new Set());
    expect(unmanaged.some((r) => r.id === ".system")).toBe(false);
    expect(unmanaged.some((r) => r.id === "my-skill")).toBe(true);
  });

  it("never creates capture proposal for Codex .system", async () => {
    const systemResource = {
      id: ".system",
      kind: "skill" as const,
      target: "codex" as const,
      path: path.join(home, ".agents", "skills", ".system"),
      confidence: 1,
      classification: "system-cache" as const,
      metadata: { managedBy: "codex", role: "system-skills" },
    };
    expect(isNeverCapturableResource(systemResource)).toBe(true);

    const proposals = await buildCaptureProposals(
      [systemResource],
      configRepo,
      { home, offline: true },
    );
    expect(proposals.some((p) => p.scanned.id === ".system")).toBe(false);
    expect(proposals.some((p) => p.suggestedResource.id === ".system")).toBe(
      false,
    );
  });
});
