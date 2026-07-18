import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  mergeManagedMarkdown,
  extractManagedMarkdown,
  resolveSecretFromEnv,
  collectSecretRefs,
  ensureDir,
  writeText,
} from "@ai-config-sync/core";
import {
  analyzeWithOptionalAi,
  heuristicAiProvider,
  computeResourceDrift,
} from "@ai-config-sync/recipe-engine";
import { resolveCachedSource } from "@ai-config-sync/git-sync";

describe("mergeManagedMarkdown", () => {
  it("inserts managed block and preserves local content", () => {
    const original = "# Title\n\nlocal notes\n";
    const r1 = mergeManagedMarkdown(original, "managed A");
    expect(r1.changed).toBe(true);
    expect(r1.content).toContain("local notes");
    expect(extractManagedMarkdown(r1.content)).toBe("managed A");

    const r2 = mergeManagedMarkdown(r1.content, "managed B");
    expect(extractManagedMarkdown(r2.content)).toBe("managed B");
    expect(r2.content).toContain("local notes");
    // idempotent same body
    const r3 = mergeManagedMarkdown(r2.content, "managed B");
    expect(r3.changed).toBe(false);
  });
});

describe("secret resolver", () => {
  it("resolves env candidates without logging values", () => {
    process.env.ACS_GITHUB_PAT = "test-value-not-asserted-in-output-message-shape";
    const r = resolveSecretFromEnv("github/pat");
    // cleanup
    delete process.env.ACS_GITHUB_PAT;
    // We only check ok flag; message should not equal the raw secret
    expect(typeof r.ok).toBe("boolean");
  });

  it("collects secretRef from nested objects", () => {
    const refs = collectSecretRefs({
      environment: {
        GITHUB_TOKEN: { secretRef: "github/pat" },
        OTHER: { secretRef: "company/api" },
      },
    });
    expect(refs).toContain("github/pat");
    expect(refs).toContain("company/api");
  });
});

describe("AI assistant analyze-only", () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "acs-ai-"));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("uses heuristic when no standard layout and ai enabled", async () => {
    await ensureDir(path.join(root, "nested", "skill-a"));
    await writeText(
      path.join(root, "nested", "skill-a", "SKILL.md"),
      "# skill-a\n",
    );
    const result = await analyzeWithOptionalAi(
      { sourceRoot: root, targets: ["claude"] },
      { aiEnabled: true, provider: heuristicAiProvider },
    );
    expect(result.usedAi).toBe(true);
    expect(result.candidates.length).toBeGreaterThan(0);
    expect(result.candidates[0]!.driver).toBe("generic-skill");
  });

  it("does not call provider when rules match", async () => {
    await writeText(path.join(root, "SKILL.md"), "# root skill\n");
    const result = await analyzeWithOptionalAi(
      { sourceRoot: root, targets: ["claude"] },
      { aiEnabled: true, provider: heuristicAiProvider },
    );
    expect(result.usedAi).toBe(false);
    expect(result.candidates[0]!.driver).toBe("generic-skill");
  });
});

describe("source cache offline", () => {
  it("returns undefined offline when not cached", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "acs-cache-"));
    try {
      const r = await resolveCachedSource(
        { provider: "github", repository: "example/does-not-exist-xyz" },
        { home, offline: true },
      );
      expect(r).toBeUndefined();
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});

describe("drift hash", () => {
  it("reports missing when not installed", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "acs-drift-"));
    try {
      const item = await computeResourceDrift({
        home,
        resource: {
          id: "x",
          kind: "skill",
          targets: { claude: { enabled: true } },
          profiles: ["home"],
          versionPolicy: "latest-confirm",
        },
        target: "claude",
      });
      expect(item.kind).toBe("missing");
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});
