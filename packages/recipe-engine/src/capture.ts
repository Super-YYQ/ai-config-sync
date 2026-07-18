import path from "node:path";
import {
  RecipeSchema,
  saveRecipe,
  saveResources,
  loadResources,
  type Resource,
  type Recipe,
  type TargetTool,
  type CandidateRecipe,
} from "@ai-config-sync/core";
import type { ScannedResource } from "@ai-config-sync/scanner";
import { analyzeSourceTree } from "./analyzer.js";
import { analyzeWithOptionalAi } from "./ai-assistant.js";

export interface CaptureItem {
  scanned: ScannedResource;
  candidate?: CandidateRecipe;
  suggestedResource: Resource;
  suggestedRecipe?: Recipe;
  needsAi: boolean;
  usedAi?: boolean;
}

/**
 * Build capture proposals from scan results (does not write until confirmed).
 */
export async function buildCaptureProposals(
  scanned: ScannedResource[],
  configRepoPath: string,
  options: { includeManaged?: boolean; aiEnabled?: boolean; homeHint?: string } = {},
): Promise<CaptureItem[]> {
  const existing = await loadResources(
    path.join(configRepoPath, "resources.yaml"),
  );
  const existingIds = new Set(existing.resources.map((r) => r.id));
  const items: CaptureItem[] = [];

  for (const s of scanned) {
    if (s.kind === "config") continue;
    if (s.classification === "system-cache") continue;
    if (s.classification === "managed" && !options.includeManaged) continue;
    if (existingIds.has(s.id) && !options.includeManaged) continue;

    let candidate: CandidateRecipe | undefined;
    let needsAi = false;
    let usedAi = false;

    // If path looks like a skill directory, analyze it
    if (s.kind === "skill" || s.kind === "plugin") {
      try {
        if (options.aiEnabled) {
          const aiResult = await analyzeWithOptionalAi(
            {
              sourceRoot: s.path,
              targets: [s.target],
              homeHint: options.homeHint,
            },
            { aiEnabled: true },
          );
          candidate = aiResult.candidates.find((c) => c.target === s.target);
          usedAi = aiResult.usedAi;
          needsAi = !candidate;
        } else {
          const analysis = await analyzeSourceTree(s.path, [s.target]);
          const forTarget = analysis.find((a) => a.target === s.target);
          candidate = forTarget?.candidates[0];
          needsAi = forTarget?.needsAi ?? true;
        }
      } catch {
        needsAi = true;
      }
    }

    const suggestedResource: Resource = {
      id: s.id,
      kind:
        s.kind === "plugin"
          ? "plugin"
          : s.kind === "hook"
            ? "hook"
            : "skill",
      source: s.sourceCandidate
        ? {
            provider: "github",
            repository: s.sourceCandidate,
          }
        : { provider: "local", path: s.path },
      targets: {
        [s.target]: {
          enabled: true,
          recipeRef: `recipes/${s.id}.yaml#${s.target}`,
        },
      },
      profiles: ["base", "home"],
      versionPolicy: "latest-confirm",
    };

    let suggestedRecipe: Recipe | undefined;
    if (candidate) {
      suggestedRecipe = RecipeSchema.parse({
        id: s.id,
        source: suggestedResource.source,
        targets: {
          [s.target]: {
            driver: candidate.driver,
            sourcePaths: candidate.sourcePaths,
            operations: candidate.operations,
            requiredPaths: candidate.requiredPaths,
            risk: candidate.risk,
            evidence: candidate.evidence,
            confidence: candidate.confidence,
            requiresApproval: true,
          },
        },
        versionPolicy: "latest-confirm",
        risk: candidate.risk,
        confirmedAt: undefined,
      });
    }

    items.push({
      scanned: s,
      candidate,
      suggestedResource,
      suggestedRecipe,
      needsAi,
      usedAi,
    });
  }

  return items;
}

/**
 * Persist confirmed capture items into the private config repo.
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

  for (const item of items) {
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
      const recipe: Recipe = {
        ...item.suggestedRecipe,
        confirmedAt: now,
        confirmedBy,
      };
      const rp = path.join(
        configRepoPath,
        "recipes",
        `${item.suggestedResource.id}.yaml`,
      );
      await saveRecipe(rp, recipe);
      recipePaths.push(rp);
    }
  }

  await saveResources(resourcesPath, {
    schemaVersion: 1,
    resources: [...byId.values()],
  });

  return { resourcesPath, recipePaths };
}
