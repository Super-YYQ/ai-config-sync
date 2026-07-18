import path from "node:path";
import {
  RecipeSchema,
  saveRecipe,
  saveResources,
  loadResources,
  loadRecipe,
  pathExists,
  isSelfManagedResourceId,
  type Resource,
  type Recipe,
  type TargetTool,
  type CandidateRecipe,
  type TargetRecipe,
} from "@ai-config-sync/core";
import type { ScannedResource } from "@ai-config-sync/scanner";
import { resolveCachedSource } from "@ai-config-sync/git-sync";
import { analyzeSourceTree } from "./analyzer.js";
import { analyzeWithOptionalAi } from "./ai-assistant.js";

export interface CaptureItem {
  scanned: ScannedResource;
  /** All scanned installs merged into this logical resource. */
  scannedAll?: ScannedResource[];
  candidate?: CandidateRecipe;
  suggestedResource: Resource;
  suggestedRecipe?: Recipe;
  needsAi: boolean;
  usedAi?: boolean;
}

function logicalId(s: ScannedResource): string {
  // Prefer github repo short name as id when available
  if (s.sourceCandidate) {
    const repo = s.sourceCandidate.replace(/\.git$/i, "");
    const short = repo.includes("/") ? repo.split("/").pop()! : repo;
    return short || s.id;
  }
  return s.id;
}

/**
 * Build capture proposals from scan results (does not write until confirmed).
 *
 * P0 fixes:
 * - exclude self-managed ai-config-sync / config-sync
 * - aggregate Claude+Codex same resource into one recipe
 * - prefer analyzing original GitHub source tree, not only installed dir
 */
export async function buildCaptureProposals(
  scanned: ScannedResource[],
  configRepoPath: string,
  options: {
    includeManaged?: boolean;
    aiEnabled?: boolean;
    homeHint?: string;
    home?: string;
    offline?: boolean;
  } = {},
): Promise<CaptureItem[]> {
  const existing = await loadResources(
    path.join(configRepoPath, "resources.yaml"),
  );
  const existingIds = new Set(existing.resources.map((r) => r.id));

  // Group by logical resource id
  const groups = new Map<string, ScannedResource[]>();
  for (const s of scanned) {
    if (s.kind === "config") continue;
    if (s.classification === "system-cache") continue;
    if (isSelfManagedResourceId(s.id)) continue;
    if (s.classification === "managed" && !options.includeManaged) continue;
    const id = logicalId(s);
    if (isSelfManagedResourceId(id)) continue;
    if (existingIds.has(id) && !options.includeManaged) continue;
    const list = groups.get(id) ?? [];
    list.push(s);
    groups.set(id, list);
  }

  const items: CaptureItem[] = [];

  for (const [id, group] of groups) {
    // Prefer a skill entry as representative for path
    const primary =
      group.find((g) => g.kind === "skill") ??
      group.find((g) => g.kind === "plugin") ??
      group[0]!;

    const sourceCandidate =
      group.map((g) => g.sourceCandidate).find(Boolean) ?? primary.sourceCandidate;

    // Resolve original source tree when possible
    let analyzeRoot = primary.path;
    let usedRemoteSource = false;
    if (sourceCandidate && options.home && !options.offline) {
      try {
        const cached = await resolveCachedSource(
          { provider: "github", repository: sourceCandidate },
          { home: options.home, offline: false },
        );
        if (cached?.root) {
          analyzeRoot = cached.root;
          usedRemoteSource = true;
        }
      } catch {
        /* fall back to installed path */
      }
    }

    const targetsPresent = new Set(group.map((g) => g.target));
    // Always try both targets when analyzing original monorepo-style source
    const analyzeTargets: TargetTool[] = usedRemoteSource
      ? ["claude", "codex"]
      : [...targetsPresent];

    let needsAi = false;
    let usedAi = false;
    const targetRecipes: Partial<Record<TargetTool, TargetRecipe>> = {};
    const candidates: CandidateRecipe[] = [];

    try {
      if (options.aiEnabled) {
        const aiResult = await analyzeWithOptionalAi(
          {
            sourceRoot: analyzeRoot,
            targets: analyzeTargets,
            homeHint: options.homeHint,
          },
          { aiEnabled: true },
        );
        usedAi = aiResult.usedAi;
        for (const c of aiResult.candidates) {
          candidates.push(c);
        }
        if (aiResult.candidates.length === 0) needsAi = true;
      } else {
        const analysis = await analyzeSourceTree(analyzeRoot, analyzeTargets);
        for (const a of analysis) {
          if (a.candidates[0]) candidates.push(a.candidates[0]);
          if (a.needsAi) needsAi = true;
        }
      }
    } catch {
      needsAi = true;
    }

    for (const c of candidates) {
      targetRecipes[c.target] = {
        driver: c.driver,
        scope: "user",
        sourcePaths: c.sourcePaths,
        operations: c.operations,
        requiredPaths: c.requiredPaths ?? [],
        requirements: [],
        verification: [],
        risk: c.risk,
        evidence: c.evidence ?? [],
        confidence: c.confidence,
        requiresApproval: true,
      };
    }

    // If plugin from marketplace, force claude-marketplace driver candidate
    const isMarketplacePlugin = group.some(
      (g) =>
        g.kind === "plugin" ||
        String(g.id).startsWith("marketplace:") ||
        g.metadata?.installVia === "claude-marketplace",
    );
    if (isMarketplacePlugin && sourceCandidate && !targetRecipes.claude) {
      const mktName =
        sourceCandidate.includes("/")
          ? sourceCandidate.split("/").pop()!
          : sourceCandidate;
      const pluginName = id.replace(/^marketplace:/, "");
      targetRecipes.claude = {
        driver: "claude-marketplace",
        scope: "user",
        marketplaceRepository: sourceCandidate.includes("/")
          ? sourceCandidate
          : undefined,
        marketplace: mktName,
        plugin: pluginName,
        operations: [
          { type: "register-marketplace" },
          { type: "install-plugin" },
          { type: "enable-plugin" },
        ],
        requiredPaths: [],
        requirements: [],
        verification: [],
        risk: "medium",
        evidence: [
          {
            path: primary.path,
            section: "marketplace-install",
          },
        ],
        requiresApproval: true,
        confidence: primary.confidence,
      };
      needsAi = false;
    }

    const suggestedResource: Resource = {
      id,
      kind:
        group.some((g) => g.kind === "plugin")
          ? group.length > 1
            ? "integration"
            : "plugin"
          : group.length > 1
            ? "integration"
            : "skill",
      source: sourceCandidate
        ? {
            provider: "github",
            repository: sourceCandidate,
          }
        : usedRemoteSource
          ? { provider: "github", repository: sourceCandidate }
          : {
              provider: "local",
              // Prefer vendoring relative path later; keep path for now
              path: primary.path,
            },
      targets: {
        ...(targetRecipes.claude
          ? {
              claude: {
                enabled: true,
                recipeRef: `recipes/${id}.yaml#claude`,
              },
            }
          : targetsPresent.has("claude")
            ? {
                claude: {
                  enabled: true,
                  recipeRef: `recipes/${id}.yaml#claude`,
                },
              }
            : {}),
        ...(targetRecipes.codex
          ? {
              codex: {
                enabled: true,
                recipeRef: `recipes/${id}.yaml#codex`,
              },
            }
          : targetsPresent.has("codex")
            ? {
                codex: {
                  enabled: true,
                  recipeRef: `recipes/${id}.yaml#codex`,
                },
              }
            : {}),
      },
      profiles: ["home"],
      versionPolicy: "latest-confirm",
    };

    let suggestedRecipe: Recipe | undefined;
    if (Object.keys(targetRecipes).length > 0) {
      // Merge with existing recipe file targets if present
      let existingTargets: Recipe["targets"] = {};
      const recipeFile = path.join(configRepoPath, "recipes", `${id}.yaml`);
      if (await pathExists(recipeFile)) {
        try {
          const prev = await loadRecipe(recipeFile);
          existingTargets = prev.targets ?? {};
        } catch {
          /* ignore */
        }
      }
      suggestedRecipe = RecipeSchema.parse({
        id,
        source: suggestedResource.source,
        targets: {
          ...existingTargets,
          ...targetRecipes,
        },
        versionPolicy: "latest-confirm",
        risk:
          Object.values(targetRecipes).some((t) => t?.risk === "high")
            ? "high"
            : Object.values(targetRecipes).some((t) => t?.risk === "medium")
              ? "medium"
              : "low",
        confirmedAt: undefined,
      });
    }

    items.push({
      scanned: primary,
      scannedAll: group,
      candidate: candidates[0],
      suggestedResource,
      suggestedRecipe,
      needsAi: needsAi && !suggestedRecipe,
      usedAi,
    });
  }

  return items;
}

/**
 * Persist confirmed capture items into the private config repo.
 * Merges dual-target recipes instead of overwriting.
 */
export async function commitCaptureItems(
  items: CaptureItem[],
  configRepoPath: string,
  confirmedBy = "user",
): Promise<{ resourcesPath: string; recipePaths: string[] }> {
  const resourcesPath = path.join(configRepoPath, "resources.yaml");
  const existing = await loadResources(resourcesPath);
  const byId = new Map(existing.resources.map((r) => [r.id, r]));
  const recipePaths: string[] = [];
  const now = new Date().toISOString();

  // Also merge items that share the same id within this batch
  const batchById = new Map<string, CaptureItem>();
  for (const item of items) {
    if (isSelfManagedResourceId(item.suggestedResource.id)) continue;
    const prev = batchById.get(item.suggestedResource.id);
    if (!prev) {
      batchById.set(item.suggestedResource.id, item);
      continue;
    }
    // merge targets
    const mergedResource: Resource = {
      ...prev.suggestedResource,
      ...item.suggestedResource,
      targets: {
        ...prev.suggestedResource.targets,
        ...item.suggestedResource.targets,
      },
    };
    let mergedRecipe = prev.suggestedRecipe;
    if (item.suggestedRecipe) {
      mergedRecipe = RecipeSchema.parse({
        ...item.suggestedRecipe,
        targets: {
          ...(prev.suggestedRecipe?.targets ?? {}),
          ...item.suggestedRecipe.targets,
        },
      });
    }
    batchById.set(item.suggestedResource.id, {
      ...item,
      suggestedResource: mergedResource,
      suggestedRecipe: mergedRecipe,
      needsAi: prev.needsAi && item.needsAi,
      usedAi: prev.usedAi || item.usedAi,
    });
  }

  for (const item of batchById.values()) {
    const prev = byId.get(item.suggestedResource.id);
    if (prev) {
      byId.set(item.suggestedResource.id, {
        ...prev,
        ...item.suggestedResource,
        targets: {
          ...prev.targets,
          ...item.suggestedResource.targets,
        },
      });
    } else {
      byId.set(item.suggestedResource.id, item.suggestedResource);
    }

    if (item.suggestedRecipe) {
      const recipeFile = path.join(
        configRepoPath,
        "recipes",
        `${item.suggestedResource.id}.yaml`,
      );
      let baseTargets = item.suggestedRecipe.targets;
      if (await pathExists(recipeFile)) {
        try {
          const existingRecipe = await loadRecipe(recipeFile);
          baseTargets = {
            ...existingRecipe.targets,
            ...item.suggestedRecipe.targets,
          };
        } catch {
          /* ignore */
        }
      }
      const recipe: Recipe = {
        ...item.suggestedRecipe,
        targets: baseTargets,
        confirmedAt: now,
        confirmedBy,
      };
      await saveRecipe(recipeFile, recipe);
      recipePaths.push(recipeFile);
    }
  }

  await saveResources(resourcesPath, {
    schemaVersion: 1,
    resources: [...byId.values()],
  });

  return { resourcesPath, recipePaths };
}
