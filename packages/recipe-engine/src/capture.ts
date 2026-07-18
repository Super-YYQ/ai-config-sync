import path from "node:path";
import fs from "node:fs/promises";
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
import { isNeverCapturableResource } from "@ai-config-sync/scanner";
import { resolveCachedSource } from "@ai-config-sync/git-sync";
import { analyzeSourceTree } from "./analyzer.js";
import { analyzeWithOptionalAi } from "./ai-assistant.js";
import { vendorSkillDirectory } from "./vendor.js";

export type CaptureProposalStatus =
  | "ready"
  | "blocked"
  | "system-excluded"
  | "needs-review";

export interface CaptureItem {
  scanned: ScannedResource;
  /** All scanned installs merged into this logical resource. */
  scannedAll?: ScannedResource[];
  candidate?: CandidateRecipe;
  suggestedResource: Resource;
  suggestedRecipe?: Recipe;
  needsAi: boolean;
  usedAi?: boolean;
  status?: CaptureProposalStatus;
  blockReason?: string;
}

/** Tool state files that must never be treated as installable local sources. */
const FORBIDDEN_LOCAL_SOURCE_BASENAMES = new Set([
  "settings.json",
  "installed_plugins.json",
  "known_marketplaces.json",
  "config.toml",
  "hooks.json",
]);

function isForbiddenLocalSourcePath(p: string | undefined): boolean {
  if (!p) return false;
  const base = path.basename(p).toLowerCase();
  if (FORBIDDEN_LOCAL_SOURCE_BASENAMES.has(base)) return true;
  const norm = p.replace(/\\/g, "/").toLowerCase();
  return (
    norm.endsWith("/.claude/settings.json") ||
    norm.includes("/.claude/plugins/installed_plugins.json") ||
    norm.includes("/.claude/plugins/known_marketplaces.json") ||
    norm.endsWith("/.codex/config.toml") ||
    norm.endsWith("/.codex/hooks.json")
  );
}

function metaString(
  meta: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const v = meta?.[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function pluginIdentity(s: ScannedResource): {
  pluginName?: string;
  marketplace?: string;
  marketplaceRepository?: string;
} {
  const pluginName =
    metaString(s.metadata, "pluginName") ||
    (s.id.includes("@") ? s.id.slice(0, s.id.lastIndexOf("@")) : undefined);
  const marketplace =
    metaString(s.metadata, "marketplace") ||
    (s.id.includes("@")
      ? s.id.slice(s.id.lastIndexOf("@") + 1)
      : undefined);
  const marketplaceRepository =
    metaString(s.metadata, "marketplaceRepository") || s.sourceCandidate;
  return { pluginName, marketplace, marketplaceRepository };
}

function logicalId(s: ScannedResource): string {
  // Prefer stable id: name only for skills; plugins keep plugin@marketplace
  if (s.kind === "skill") return s.id;
  if (s.kind === "plugin") {
    const { pluginName, marketplace } = pluginIdentity(s);
    if (pluginName && marketplace) return `${pluginName}@${marketplace}`;
    if (pluginName) return pluginName;
    if (s.id.includes("@")) return s.id;
  }
  if (s.sourceCandidate) {
    const repo = s.sourceCandidate.replace(/\.git$/i, "");
    const short = repo.includes("/") ? repo.split("/").pop()! : repo;
    if (s.id.includes("@")) return s.id;
    return short || s.id;
  }
  return s.id;
}

export function validateCaptureProposal(item: {
  scanned: ScannedResource;
  suggestedResource: Resource;
  suggestedRecipe?: Recipe;
}): { ok: true } | { ok: false; reason: string } {
  if (isNeverCapturableResource(item.scanned)) {
    return { ok: false, reason: "system-resource-not-capturable" };
  }
  if (item.scanned.kind === "plugin") {
    const { pluginName, marketplace, marketplaceRepository } = pluginIdentity(
      item.scanned,
    );
    const src = item.suggestedResource.source;
    if (src?.provider === "local" && isForbiddenLocalSourcePath(src.path)) {
      return { ok: false, reason: "plugin-marketplace-source-unresolved" };
    }
    if (!pluginName) {
      return { ok: false, reason: "plugin-name-missing" };
    }
    const claude = item.suggestedRecipe?.targets?.claude;
    if (claude?.driver === "claude-marketplace") {
      if (!marketplace && !marketplaceRepository && !claude.marketplace && !claude.marketplaceRepository) {
        return { ok: false, reason: "plugin-marketplace-source-unresolved" };
      }
    }
    if (
      !marketplaceRepository &&
      !marketplace &&
      metaString(item.scanned.metadata, "sourceResolutionStatus") === "unresolved"
    ) {
      return { ok: false, reason: "plugin-marketplace-source-unresolved" };
    }
    if (
      !item.scanned.sourceCandidate &&
      !marketplaceRepository &&
      item.scanned.kind === "plugin"
    ) {
      // settings-only evidence without marketplace repo
      const evidence = item.scanned.metadata?.evidence;
      const onlySettings =
        Array.isArray(evidence) &&
        evidence.length > 0 &&
        evidence.every(
          (e) =>
            typeof e === "object" &&
            e !== null &&
            (e as { from?: string }).from === "settings.json",
        );
      if (onlySettings || !item.scanned.sourceCandidate) {
        return { ok: false, reason: "plugin-marketplace-source-unresolved" };
      }
    }
  }
  if (
    item.suggestedResource.source?.provider === "local" &&
    isForbiddenLocalSourcePath(item.suggestedResource.source.path)
  ) {
    return { ok: false, reason: "forbidden-local-source" };
  }
  return { ok: true };
}

/** Canonical key to avoid merging unrelated skills from same monorepo. */
function groupKey(s: ScannedResource): string {
  const name = logicalId(s);
  const repo = s.sourceCandidate?.replace(/\.git$/i, "") ?? "local";
  // Do not merge different skill names even if same repo
  return `${repo}::${name}::${s.kind}`;
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

  // Group by logical resource id (repo + name, not repo alone)
  const groups = new Map<string, ScannedResource[]>();
  for (const s of scanned) {
    if (s.kind === "config") continue;
    if (isNeverCapturableResource(s)) continue;
    if (s.classification === "system-cache") continue;
    if (isSelfManagedResourceId(s.id)) continue;
    if (s.classification === "managed" && !options.includeManaged) continue;
    const id = logicalId(s);
    if (isSelfManagedResourceId(id)) continue;
    if (existingIds.has(id) && !options.includeManaged) continue;
    const key = groupKey(s);
    const list = groups.get(key) ?? [];
    list.push(s);
    groups.set(key, list);
  }

  const items: CaptureItem[] = [];

  for (const [, group] of groups) {
    const id = logicalId(group[0]!);
    // Prefer a skill entry as representative for path
    const primary =
      group.find((g) => g.kind === "skill") ??
      group.find((g) => g.kind === "plugin") ??
      group[0]!;

    const identity = pluginIdentity(primary);
    const sourceCandidate =
      identity.marketplaceRepository ||
      group.map((g) => g.sourceCandidate).find(Boolean) ||
      primary.sourceCandidate;

    const isPlugin = group.some((g) => g.kind === "plugin");
    const isMarketplacePlugin = group.some(
      (g) =>
        g.kind === "plugin" ||
        String(g.id).startsWith("marketplace:") ||
        g.metadata?.installVia === "claude-marketplace",
    );

    // Block plugins whose marketplace source cannot be resolved — never local settings.json
    if (isPlugin && !sourceCandidate) {
      const blockedResource: Resource = {
        id,
        kind: "plugin",
        source: {
          provider: "unknown",
        },
        targets: {
          claude: {
            enabled: true,
            recipeRef: `recipes/${id}.yaml#claude`,
          },
        },
        profiles: ["home"],
        versionPolicy: "latest-confirm",
      };
      items.push({
        scanned: primary,
        scannedAll: group,
        suggestedResource: blockedResource,
        suggestedRecipe: undefined,
        needsAi: false,
        status: "blocked",
        blockReason: "plugin-marketplace-source-unresolved",
      });
      continue;
    }

    // Resolve original source tree when possible
    let analyzeRoot = primary.path;
    let usedRemoteSource = false;
    // Do not analyze marketplace cache dirs as if they were the plugin source tree —
    // that yields wrong plugin names from marketplace.json.
    const skipTreeAnalyze =
      isMarketplacePlugin &&
      (Boolean(identity.pluginName) || Boolean(identity.marketplace));

    if (sourceCandidate && options.home && !options.offline && !skipTreeAnalyze) {
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

    if (!skipTreeAnalyze) {
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

    // Prefer structured plugin inventory metadata over tree heuristics
    if (isMarketplacePlugin && sourceCandidate) {
      const pluginName =
        identity.pluginName ||
        (id.includes("@") ? id.slice(0, id.lastIndexOf("@")) : id.replace(/^marketplace:/, ""));
      const mktName =
        identity.marketplace ||
        (id.includes("@")
          ? id.slice(id.lastIndexOf("@") + 1)
          : sourceCandidate.includes("/")
            ? sourceCandidate.split("/").pop()!
            : sourceCandidate);
      const marketplaceRepository = sourceCandidate.includes("/")
        ? sourceCandidate
        : identity.marketplaceRepository;

      const existing = targetRecipes.claude;
      targetRecipes.claude = {
        driver: "claude-marketplace",
        scope: "user",
        marketplaceRepository,
        marketplace: mktName,
        plugin: pluginName,
        operations: existing?.operations?.length
          ? existing.operations
          : [
              { type: "register-marketplace" },
              { type: "install-plugin" },
              { type: "enable-plugin" },
            ],
        requiredPaths: existing?.requiredPaths ?? [],
        requirements: existing?.requirements ?? [],
        verification: existing?.verification ?? [],
        risk: "medium",
        evidence: existing?.evidence?.length
          ? existing.evidence
          : [
              {
                path: primary.path,
                section: "marketplace-install",
              },
            ],
        requiresApproval: true,
        confidence: Math.max(primary.confidence, existing?.confidence ?? 0),
        sourcePaths: existing?.sourcePaths,
      };
      needsAi = false;
    }

    let source: Resource["source"] = sourceCandidate
      ? {
          provider: isMarketplacePlugin ? "marketplace" : "github",
          repository: sourceCandidate,
          marketplace: identity.marketplace,
        }
      : {
          // Will be rewritten to vendored on commit if still local absolute
          provider: "local",
          path: primary.path,
        };

    if (source.provider === "local" && isForbiddenLocalSourcePath(source.path)) {
      items.push({
        scanned: primary,
        scannedAll: group,
        suggestedResource: {
          id,
          kind: isPlugin ? "plugin" : "skill",
          source: { provider: "unknown" },
          targets: {},
          profiles: ["home"],
          versionPolicy: "latest-confirm",
        },
        suggestedRecipe: undefined,
        needsAi: false,
        status: "blocked",
        blockReason: "forbidden-local-source",
      });
      continue;
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
      source,
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
      versionPolicy: sourceCandidate ? "latest-confirm" : "vendored",
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

    const draft: CaptureItem = {
      scanned: primary,
      scannedAll: group,
      candidate: candidates[0],
      suggestedResource,
      suggestedRecipe,
      needsAi: needsAi && !suggestedRecipe,
      usedAi,
      status: suggestedRecipe && !needsAi ? "ready" : "needs-review",
    };

    const validation = validateCaptureProposal(draft);
    if (!validation.ok) {
      draft.suggestedRecipe = undefined;
      draft.needsAi = false;
      draft.status = "blocked";
      draft.blockReason = validation.reason;
      if (draft.suggestedResource.source?.provider === "local") {
        draft.suggestedResource = {
          ...draft.suggestedResource,
          source: { provider: "unknown" },
        };
      }
    }

    items.push(draft);
  }

  return items;
}

/**
 * Persist confirmed capture items into the private config repo.
 * Transactional: stage under .ai-config-sync-staging/, validate, then
 * backup existing targets and atomically replace.
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

  // Stage all writes under a temp dir, then swap into place
  const stagingRoot = path.join(
    configRepoPath,
    `.ai-config-sync-staging-${Date.now()}`,
  );
  const backupRoot = path.join(
    configRepoPath,
    `.ai-config-sync-backup-${Date.now()}`,
  );
  const stagedRecipeRels: string[] = [];
  const stagedVendorRels: string[] = [];

  try {
    await fs.mkdir(path.join(stagingRoot, "recipes"), { recursive: true });

    for (const item of batchById.values()) {
      if (item.status === "blocked" || item.status === "system-excluded") {
        continue;
      }
      const validation = validateCaptureProposal(item);
      if (!validation.ok) {
        continue;
      }
      // Auto-vendor local absolute skills into staging
      if (
        item.suggestedResource.source?.provider === "local" &&
        item.suggestedResource.source.path &&
        path.isAbsolute(item.suggestedResource.source.path) &&
        item.scanned.kind === "skill"
      ) {
        const v = await vendorSkillDirectory(
          item.suggestedResource.source.path,
          configRepoPath,
          item.suggestedResource.id,
          { stagingRoot },
        );
        if (!v.ok) {
          throw new Error(
            `Cannot capture ${item.suggestedResource.id}: ${v.message}` +
              (v.blockedSecrets.length
                ? ` secrets=${v.blockedSecrets.map((s) => s.path + ":" + s.rule).join(",")}`
                : ""),
          );
        }
        stagedVendorRels.push(v.destRel);
        item.suggestedResource = {
          ...item.suggestedResource,
          source: {
            provider: "vendored",
            path: v.destRel,
          },
          versionPolicy: "vendored",
        };
        if (item.suggestedRecipe) {
          item.suggestedRecipe = {
            ...item.suggestedRecipe,
            source: item.suggestedResource.source,
            versionPolicy: "vendored",
            targets: Object.fromEntries(
              Object.entries(item.suggestedRecipe.targets).map(([t, tr]) => [
                t,
                tr
                  ? {
                      ...tr,
                      sourcePaths: { skill: "." },
                      requiredPaths: ["SKILL.md"],
                      driver:
                        tr.driver === "claude-marketplace"
                          ? tr.driver
                          : "generic-skill",
                    }
                  : tr,
              ]),
            ) as Recipe["targets"],
          };
        }
      }

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
        const recipeRel = path.posix.join(
          "recipes",
          `${item.suggestedResource.id}.yaml`,
        );
        const recipeFileLive = path.join(configRepoPath, recipeRel);
        const recipeFileStage = path.join(stagingRoot, recipeRel);
        let baseTargets = item.suggestedRecipe.targets;
        if (await pathExists(recipeFileLive)) {
          try {
            const existingRecipe = await loadRecipe(recipeFileLive);
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
        // Validate schema before any live write
        RecipeSchema.parse(recipe);
        await saveRecipe(recipeFileStage, recipe);
        stagedRecipeRels.push(recipeRel);
        recipePaths.push(recipeFileLive);
      }
    }

    // Stage resources.yaml
    const stagedResources = path.join(stagingRoot, "resources.yaml");
    await saveResources(stagedResources, {
      schemaVersion: 1,
      resources: [...byId.values()],
    });
    // Re-load staged resources to ensure file is valid
    await loadResources(stagedResources);

    // Backup live targets that will be replaced
    const toBackup: string[] = ["resources.yaml", ...stagedRecipeRels, ...stagedVendorRels];
    await fs.mkdir(backupRoot, { recursive: true });
    for (const rel of toBackup) {
      const live = path.join(configRepoPath, rel);
      if (await pathExists(live)) {
        const bak = path.join(backupRoot, rel);
        await fs.mkdir(path.dirname(bak), { recursive: true });
        await fs.cp(live, bak, { recursive: true });
      }
    }

    // Atomic-ish replace: move staged files into place
    for (const rel of stagedVendorRels) {
      const from = path.join(stagingRoot, rel);
      const to = path.join(configRepoPath, rel);
      if (await pathExists(to)) {
        await fs.rm(to, { recursive: true, force: true });
      }
      await fs.mkdir(path.dirname(to), { recursive: true });
      await fs.rename(from, to).catch(async () => {
        await fs.cp(from, to, { recursive: true });
        await fs.rm(from, { recursive: true, force: true });
      });
    }
    for (const rel of stagedRecipeRels) {
      const from = path.join(stagingRoot, rel);
      const to = path.join(configRepoPath, rel);
      await fs.mkdir(path.dirname(to), { recursive: true });
      await fs.rename(from, to).catch(async () => {
        await fs.copyFile(from, to);
        await fs.rm(from, { force: true });
      });
    }
    {
      const from = stagedResources;
      const to = resourcesPath;
      await fs.rename(from, to).catch(async () => {
        await fs.copyFile(from, to);
        await fs.rm(from, { force: true });
      });
    }

    // Success — drop backup and staging
    await fs.rm(backupRoot, { recursive: true, force: true }).catch(() => {});
    await fs.rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
  } catch (e) {
    // Restore from backup if present
    try {
      if (await pathExists(backupRoot)) {
        const entries = await fs.readdir(backupRoot, { withFileTypes: true });
        // restore top-level + nested via recursive copy
        await fs.cp(backupRoot, configRepoPath, { recursive: true, force: true });
        void entries;
      }
    } catch {
      /* best effort */
    }
    await fs.rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
    // keep backup on failure for manual recovery
    throw e;
  }

  return { resourcesPath, recipePaths };
}
