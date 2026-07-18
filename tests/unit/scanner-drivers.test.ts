import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { scanLocal } from "@ai-config-sync/scanner";
import { analyzeSourceTree } from "@ai-config-sync/recipe-engine";
import { getDriver } from "@ai-config-sync/drivers";
import {
  mergeTomlText,
  getTomlValue,
  writeText,
  ensureDir,
} from "@ai-config-sync/core";

async function makeTempHome(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "acs-test-"));
}

describe("scanner", () => {
  let home: string;
  beforeEach(async () => {
    home = await makeTempHome();
    await ensureDir(path.join(home, ".claude", "skills", "my-skill"));
    await writeText(
      path.join(home, ".claude", "skills", "my-skill", "SKILL.md"),
      "# my-skill\nhttps://github.com/acme/my-skill\n",
    );
    await ensureDir(path.join(home, ".codex", "skills", "other"));
    await writeText(
      path.join(home, ".codex", "skills", "other", "SKILL.md"),
      "---\nname: other\n---\n",
    );
  });
  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  it("finds skills and source candidates", async () => {
    const result = await scanLocal({ home, light: true });
    const ids = result.resources.map((r) => r.id);
    expect(ids).toContain("my-skill");
    expect(ids).toContain("other");
    const mine = result.resources.find((r) => r.id === "my-skill");
    expect(mine?.sourceCandidate).toBe("acme/my-skill");
    expect(mine?.target).toBe("claude");
  });
});

describe("analyzer", () => {
  let root: string;
  beforeEach(async () => {
    root = await makeTempHome();
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("detects generic skill at root", async () => {
    await writeText(path.join(root, "SKILL.md"), "# demo\n");
    const result = await analyzeSourceTree(root, ["claude"]);
    expect(result[0]!.needsAi).toBe(false);
    expect(result[0]!.candidates[0]!.driver).toBe("generic-skill");
  });

  it("detects claude marketplace layout", async () => {
    await ensureDir(path.join(root, ".claude-plugin"));
    await writeText(
      path.join(root, ".claude-plugin", "marketplace.json"),
      JSON.stringify({
        name: "demo-mkt",
        plugins: [{ name: "demo-plugin" }],
      }),
    );
    const result = await analyzeSourceTree(root, ["claude"]);
    expect(result[0]!.standardMatch?.kind).toBe("marketplace-plugin");
    expect(result[0]!.candidates[0]!.driver).toBe("claude-marketplace");
  });

  it("detects codex layout", async () => {
    await ensureDir(path.join(root, ".codex", "skills", "x"));
    await writeText(
      path.join(root, ".codex", "skills", "x", "SKILL.md"),
      "# x\n",
    );
    await writeText(
      path.join(root, ".codex", "hooks.json"),
      JSON.stringify({ hooks: [{ id: "h1" }] }),
    );
    const result = await analyzeSourceTree(root, ["codex"]);
    expect(result[0]!.candidates[0]!.driver).toBe("repository-layout");
  });
});

describe("generic-skill driver idempotent", () => {
  let home: string;
  let src: string;
  beforeEach(async () => {
    home = await makeTempHome();
    src = path.join(home, "src-skill");
    await ensureDir(src);
    await writeText(path.join(src, "SKILL.md"), "# s\n");
  });
  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  it("copies twice without error", async () => {
    const driver = getDriver("generic-skill");
    const recipe = {
      driver: "generic-skill" as const,
      scope: "user" as const,
      sourcePaths: { skill: "." },
      operations: [],
      requiredPaths: ["SKILL.md"],
      requirements: [],
      verification: [],
      risk: "low" as const,
      evidence: [],
      requiresApproval: false,
    };
    const ctx = {
      home,
      resourceId: "s",
      target: "claude" as const,
      sourceRoot: src,
    };
    const r1 = await driver.apply(recipe, ctx);
    const r2 = await driver.apply(recipe, ctx);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    const dest = path.join(home, ".claude", "skills", "s", "SKILL.md");
    const content = await fs.readFile(dest, "utf8");
    expect(content).toContain("# s");
  });
});

describe("toml merge no duplicate sections", () => {
  it("does not create duplicate [features]", () => {
    let text = "[features]\nhooks = false\n";
    text = mergeTomlText(text, [
      { section: "features", key: "hooks", value: true },
    ]);
    const count = (text.match(/\[features\]/g) ?? []).length;
    expect(count).toBe(1);
    expect(getTomlValue(text, "features", "hooks")).toBe(true);
  });
});
