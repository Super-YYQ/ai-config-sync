import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ensureDir,
  readText,
  writeText,
  writeYamlFile,
} from "@ai-config-sync/core";
import {
  ASSET_CATALOG_HTML_REL,
  ASSET_CATALOG_MARKDOWN_REL,
  PAGES_WORKFLOW_REL,
  buildAssetCatalog,
  renderAssetCatalogHtml,
  writeAssetCatalog,
} from "@ai-config-sync/recipe-engine";

describe("private repository asset catalog", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await fs.mkdtemp(path.join(os.tmpdir(), "acs-catalog-"));
    await ensureDir(path.join(repo, "profiles"));
    await ensureDir(path.join(repo, "recipes"));
    await ensureDir(path.join(repo, "sources", "skills", "portable-skill"));
    await writeYamlFile(path.join(repo, "config.yaml"), {
      schemaVersion: 1,
      name: "personal-agent-assets",
      defaultProfile: "home",
      targets: { claude: true, codex: true },
      security: { blockSecretCommit: true, maxRiskWithoutConfirm: "low" },
      ai: { enabled: false, mode: "off" },
    });
    await writeYamlFile(path.join(repo, "profiles", "home.yaml"), {
      profile: "home",
      extends: [],
      include: { resources: [] },
      exclude: { resources: [] },
      security: {
        maxRisk: "medium",
        allowAutomaticLatest: false,
        secrets: { provider: "local-only" },
      },
    });
    await writeYamlFile(path.join(repo, "resources.yaml"), {
      schemaVersion: 1,
      resources: [
        {
          id: "portable-skill",
          kind: "skill",
          source: { provider: "vendored", path: "sources/skills/portable-skill" },
          targets: {
            claude: { enabled: true, recipeRef: "recipes/portable-skill.yaml#claude" },
            codex: { enabled: true, recipeRef: "recipes/portable-skill.yaml#codex" },
          },
          profiles: ["home"],
          versionPolicy: "vendored",
          notes:
            "Portable skill <script>alert('catalog')</script> at E:\\Projects\\private and /opt/company/private",
        },
        {
          id: "frontend-design@official",
          kind: "plugin",
          source: { provider: "marketplace", marketplace: "claude-plugins-official" },
          targets: { claude: { enabled: true } },
          profiles: ["home"],
          versionPolicy: "latest-confirm",
        },
        {
          id: "local-review",
          kind: "skill",
          source: { provider: "local", path: "C:\\Users\\private-user\\secret-skill" },
          targets: { codex: { enabled: true } },
          profiles: ["home"],
          versionPolicy: "latest-confirm",
        },
      ],
    });
    await writeYamlFile(path.join(repo, "lock.yaml"), {
      schemaVersion: 1,
      entries: [{ resourceId: "portable-skill", commit: "1234567890abcdef" }],
    });
  });

  afterEach(async () => {
    await fs.rm(repo, { recursive: true, force: true });
  });

  it("builds a deterministic repository-only inventory", async () => {
    const catalog = await buildAssetCatalog(repo);
    expect(catalog.repository.name).toBe("personal-agent-assets");
    expect(catalog.summary).toMatchObject({
      total: 3,
      portable: 1,
      referenced: 1,
      needsReview: 1,
      byTarget: { claude: 2, codex: 2 },
    });
    const local = catalog.assets.find((asset) => asset.id === "local-review");
    expect(local?.source.label).toBe("Local source · machine path hidden");
    expect(JSON.stringify(catalog)).not.toContain("private-user");
  });

  it("writes GitHub Markdown and a self-contained, XSS-safe HTML view", async () => {
    const first = await writeAssetCatalog(repo);
    expect(first.changedRelPaths).toEqual([
      ASSET_CATALOG_MARKDOWN_REL,
      ASSET_CATALOG_HTML_REL,
      PAGES_WORKFLOW_REL,
    ]);

    const markdown = await readText(first.markdownPath);
    const html = await readText(first.htmlPath);
    expect(markdown).toContain("AI Config 备份资产目录");
    expect(markdown).toContain("portable-skill");
    expect(markdown).toContain("catalog/index.html");
    expect(markdown).not.toContain("private-user");
    expect(html).toContain('content="ai-config-sync asset-catalog/v1"');
    expect(html).toContain("搜索名称、来源或说明");
    expect(html).not.toContain("<script>alert('catalog')</script>");
    expect(html).toContain("\\u003cscript\\u003ealert");
    expect(html).not.toContain("E:\\Projects\\private");
    expect(html).not.toContain("/opt/company/private");

    const second = await writeAssetCatalog(repo);
    expect(second.changedRelPaths).toEqual([]);
  });

  it("preserves user Markdown outside the managed catalog block", async () => {
    const assetsPath = path.join(repo, ASSET_CATALOG_MARKDOWN_REL);
    await writeText(assetsPath, "# Personal notes\n\nKeep this text.\n");
    await writeAssetCatalog(repo);
    const first = await readText(assetsPath);
    expect(first).toContain("Keep this text.");
    expect(first).toContain("<!-- ai-config-sync:assets:start -->");

    await writeAssetCatalog(repo);
    const second = await readText(assetsPath);
    expect(second.match(/ai-config-sync:assets:start/g)).toHaveLength(1);
  });

  it("refuses to replace an unrelated HTML page before changing Markdown", async () => {
    const assetsPath = path.join(repo, ASSET_CATALOG_MARKDOWN_REL);
    const htmlPath = path.join(repo, ASSET_CATALOG_HTML_REL);
    await ensureDir(path.dirname(htmlPath));
    await writeText(assetsPath, "user-owned markdown\n");
    await writeText(htmlPath, "<!doctype html><title>user page</title>\n");

    await expect(writeAssetCatalog(repo)).rejects.toThrow(
      "Refusing to replace non-generated catalog page",
    );
    expect(await readText(assetsPath)).toBe("user-owned markdown\n");
  });

  it("does not emit executable asset text into the document shell", async () => {
    const catalog = await buildAssetCatalog(repo);
    const html = renderAssetCatalogHtml(catalog);
    expect(html).not.toContain("Portable skill <script>");
    expect(html).toContain('type="application/json"');
  });

  it("deploys the catalog via GitHub Pages and never clobbers a user workflow", async () => {
    const first = await writeAssetCatalog(repo);
    const workflowPath = path.join(repo, PAGES_WORKFLOW_REL);
    const workflow = await readText(workflowPath);
    // Only the self-contained catalog directory is published — never recipes,
    // profiles, lock, or vendored sources.
    expect(workflow).toContain("path: catalog");
    expect(workflow).toContain("actions/deploy-pages@v4");
    expect(workflow).toContain("pages: write");

    // Deterministic content — a no-op capture reports no changes.
    const second = await writeAssetCatalog(repo);
    expect(second.changedRelPaths).toEqual([]);

    // A user-owned workflow at the same path is left untouched.
    await fs.rm(workflowPath, { force: true });
    await writeText(workflowPath, "# my own pages setup\n");
    const third = await writeAssetCatalog(repo);
    expect(third.changedRelPaths).not.toContain(PAGES_WORKFLOW_REL);
    expect(await readText(workflowPath)).toBe("# my own pages setup\n");
  });
});
