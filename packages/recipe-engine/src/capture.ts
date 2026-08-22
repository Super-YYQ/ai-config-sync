import path from "node:path";
import {
  RecipeSchema,
  hashDirectory,
  loadResources,
  loadRecipe,
  pathExists,
  isSelfManagedResourceId,
  recipeRelPath,
  toStorageKey,
  type Resource,
  type Recipe,
  type TargetTool,
  type TargetRecipe,
  type CandidateRecipe,
} from "@ai-config-sync/core";
import type { ScannedResource } from "@ai-config-sync/scanner";
import { isNeverCapturableResource } from "@ai-config-sync/scanner";
import { resolveCachedSource } from "@ai-config-sync/git-sync";
import { analyzeSourceTree } from "./analyzer.js";
import { analyzeWithOptionalAi } from "./ai-assistant.js";
import {
  groupKey,
  isForbiddenLocalSourcePath,
  logicalId,
  pluginIdentity,
  validateCaptureProposal,
} from "./capture-policy.js";
import type { CaptureItem } from "./capture-types.js";

export type {
  CaptureCommitResult,
  CaptureItem,
  CaptureProposalStatus,
  CaptureTransaction,
  CaptureTxEntry,
} from "./capture-types.js";
export {
  isReadyForAutoCapture,
  validateCaptureProposal,
} from "./capture-policy.js";
export {
  commitCaptureItems,
  rollbackCaptureTransaction,
} from "./capture-transaction.js";

/**
 * Detect the multi-machine semantic conflict: the resource id is already
 * backed up with a vendored copy, but this machine's local directory hashes
 * differently. Only directory-based vendored skills can be compared this way;
 * anything else keeps the previous silent-skip behavior.
 */
async function differsFromVendoredCopy(
  recorded: Resource,
  scanned: ScannedResource,
  configRepoPath: string,
): Promise<boolean> {
  if (scanned.kind !== "skill") return false;
  const source = recorded.source;
  if (source?.provider !== "vendored") return false;
  const rel = source.path;
  if (
    !rel ||
    path.isAbsolute(rel) ||
    rel.split("/").some((seg) => !seg || seg === "." || seg === "..")
  ) {
    return false;
  }
  if (!scanned.path || !path.isAbsolute(scanned.path)) return false;
  try {
    const localHash = await hashDirectory(scanned.path);
    const vendoredHash = await hashDirectory(path.join(configRepoPath, rel));
    return localHash !== vendoredHash;
  } catch {
    return false;
  }
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
  const existingById = new Map(existing.resources.map((r) => [r.id, r]));
  const existingIds = new Set(existingById.keys());

  // Group by logical resource id (repo + name, not repo alone)
  const groups = new Map<string, ScannedResource[]>();
  const sameIdConflicts: { id: string; resource: Resource; scanned: ScannedResource }[] = [];
  for (const s of scanned) {
    if (s.kind === "config") continue;
    if (isNeverCapturableResource(s)) continue;
    if (s.classification === "system-cache") continue;
    if (isSelfManagedResourceId(s.id)) continue;
    if (s.classification === "managed" && !options.includeManaged) continue;
    const id = logicalId(s);
    if (isSelfManagedResourceId(id)) continue;
    if (existingIds.has(id) && !options.includeManaged) {
      // The id is already backed up. Same content means nothing to do, but a
      // different local copy (e.g. the same skill edited on two machines)
      // must surface as NEEDS-REVIEW instead of being silently skipped.
      const recorded = existingById.get(id);
      if (recorded && (await differsFromVendoredCopy(recorded, s, configRepoPath))) {
        sameIdConflicts.push({ id, resource: recorded, scanned: s });
      }
      continue;
    }
    const key = groupKey(s);
    const list = groups.get(key) ?? [];
    list.push(s);
    groups.set(key, list);
  }

  const items: CaptureItem[] = [];

  for (const conflict of sameIdConflicts) {
    items.push({
      scanned: conflict.scanned,
      scannedAll: [conflict.scanned],
      suggestedResource: conflict.resource,
      suggestedRecipe: undefined,
      needsAi: false,
      status: "needs-review",
      blockReason: "same-id-different-content",
    });
  }

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
            recipeRef: `${recipeRelPath(id)}#claude`,
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
                recipeRef: `${recipeRelPath(id)}#claude`,
              },
            }
          : targetsPresent.has("claude")
            ? {
                claude: {
                  enabled: true,
                  recipeRef: `${recipeRelPath(id)}#claude`,
                },
              }
            : {}),
        ...(targetRecipes.codex
          ? {
              codex: {
                enabled: true,
                recipeRef: `${recipeRelPath(id)}#codex`,
              },
            }
          : targetsPresent.has("codex")
            ? {
                codex: {
                  enabled: true,
                  recipeRef: `${recipeRelPath(id)}#codex`,
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
      const recipeFile = path.join(configRepoPath, recipeRelPath(id));
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
