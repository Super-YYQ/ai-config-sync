import { describe, it, expect } from "vitest";
import {
  mergeJson,
  setByPath,
  getByPath,
  mergeTomlText,
  getTomlValue,
  scanTextForSecrets,
  sanitizeForAi,
  expandHome,
  pathsEqual,
  ResourceSchema,
  RecipeSchema,
  LocalConfigSchema,
  resolveProfileResources,
  isSelfManagedResourceId,
  type Profile,
} from "@ai-config-sync/core";

describe("mergeJson", () => {
  it("preserves unknown base fields", () => {
    const base = { a: 1, b: { x: 1, y: 2 }, keep: true };
    const managed = { b: { x: 9 }, c: 3 };
    const out = mergeJson(base, managed) as Record<string, unknown>;
    expect(out.keep).toBe(true);
    expect(out.a).toBe(1);
    expect((out.b as { x: number; y: number }).x).toBe(9);
    expect((out.b as { x: number; y: number }).y).toBe(2);
    expect(out.c).toBe(3);
  });

  it("merges arrays by id", () => {
    const base = {
      hooks: [
        { id: "a", cmd: "old" },
        { id: "b", cmd: "keep" },
      ],
    };
    const managed = { hooks: [{ id: "a", cmd: "new" }, { id: "c", cmd: "add" }] };
    const out = mergeJson(base, managed) as {
      hooks: Array<{ id: string; cmd: string }>;
    };
    expect(out.hooks).toEqual([
      { id: "a", cmd: "new" },
      { id: "b", cmd: "keep" },
      { id: "c", cmd: "add" },
    ]);
  });

  it("setByPath / getByPath", () => {
    const obj = setByPath({}, "features.hooks", true);
    expect(getByPath(obj, "features.hooks")).toBe(true);
  });
});

describe("mergeTomlText", () => {
  it("adds section and key idempotently", () => {
    let text = "# comment\n";
    text = mergeTomlText(text, [{ section: "features", key: "hooks", value: true }]);
    expect(getTomlValue(text, "features", "hooks")).toBe(true);
    const again = mergeTomlText(text, [
      { section: "features", key: "hooks", value: true },
    ]);
    expect(again).toBe(text.endsWith("\n") ? text : text + "\n");
    // unknown keys preserved
    const withOther = mergeTomlText(
      "[features]\nother = 1\n",
      [{ section: "features", key: "hooks", value: true }],
    );
    expect(withOther).toContain("other = 1");
    expect(getTomlValue(withOther, "features", "hooks")).toBe(true);
  });
});

describe("secrets", () => {
  it("detects github pat and redacts", () => {
    const text = "token: ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    const findings = scanTextForSecrets(text, "x.yaml");
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0]!.preview).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
  });

  it("sanitizeForAi strips home paths", () => {
    const s = sanitizeForAi("file at C:\\Users\\alice\\secret\\a", "C:\\Users\\alice");
    expect(s.toLowerCase()).not.toContain("alice");
  });
});

describe("paths", () => {
  it("expands home", () => {
    expect(expandHome("~/x", "/home/u")).toMatch(/x$/);
  });
  it("pathsEqual normalizes", () => {
    expect(pathsEqual("/a/b", "/a/b")).toBe(true);
  });
});

describe("schemas", () => {
  it("parses resource and recipe", () => {
    const r = ResourceSchema.parse({
      id: "demo",
      kind: "skill",
      targets: { claude: { enabled: true } },
    });
    expect(r.id).toBe("demo");
    const recipe = RecipeSchema.parse({
      id: "demo",
      targets: {
        claude: { driver: "generic-skill", risk: "low" },
      },
    });
    expect(recipe.targets.claude?.driver).toBe("generic-skill");
  });

  it("parses local config", () => {
    const c = LocalConfigSchema.parse({
      configRepository: { localPath: "/tmp/cfg" },
      profile: "home",
    });
    expect(c.schemaVersion).toBe(1);
  });
});

describe("resolveProfileResources", () => {
  it("includes and excludes across extends", () => {
    const base: Profile = {
      profile: "base",
      extends: [],
      include: { resources: [] },
      exclude: { resources: [] },
      security: {
        maxRisk: "medium",
        allowAutomaticLatest: false,
        secrets: { provider: "local-only" },
      },
    };
    const company: Profile = {
      profile: "company",
      extends: ["base"],
      include: { resources: ["a", "b"] },
      exclude: { resources: ["b"] },
      security: {
        maxRisk: "medium",
        allowAutomaticLatest: false,
        secrets: { provider: "local-only" },
      },
    };
    const ids = resolveProfileResources(company, ["a", "b", "c"], [base]);
    expect(ids).toContain("a");
    expect(ids).not.toContain("b");
  });

  it("enforces resource.profiles isolation", () => {
    const company: Profile = {
      profile: "company",
      extends: [],
      include: { resources: [] },
      exclude: { resources: [] },
      security: {
        maxRisk: "medium",
        allowAutomaticLatest: false,
        secrets: { provider: "local-only" },
      },
    };
    const ids = resolveProfileResources(
      company,
      ["home-only", "both", "unrestricted"],
      [],
      [
        { id: "home-only", profiles: ["home"] },
        { id: "both", profiles: ["home", "company"] },
        { id: "unrestricted", profiles: [] },
      ],
    );
    expect(ids).not.toContain("home-only");
    expect(ids).toContain("both");
    expect(ids).toContain("unrestricted");
  });

  it("does not treat base as wildcard for company", () => {
    const company: Profile = {
      profile: "company",
      extends: [],
      include: { resources: [] },
      exclude: { resources: [] },
      security: {
        maxRisk: "medium",
        allowAutomaticLatest: false,
        secrets: { provider: "local-only" },
      },
    };
    const ids = resolveProfileResources(
      company,
      ["demo"],
      [],
      [{ id: "demo", profiles: ["base", "home"] }],
    );
    expect(ids).not.toContain("demo");
  });
});

describe("self-managed exclusion", () => {
  it("excludes config-sync and ai-config-sync ids", () => {
    expect(isSelfManagedResourceId("config-sync")).toBe(true);
    expect(isSelfManagedResourceId("ai-config-sync@ai-config-sync")).toBe(true);
    expect(isSelfManagedResourceId("marketplace:ai-config-sync")).toBe(true);
    expect(isSelfManagedResourceId("docx")).toBe(false);
  });
});
