import path from "node:path";
import {
  loadResources,
  resolveProfileResources,
  type TargetTool,
} from "@ai-config-sync/core";
import { computeResourceDrift } from "./drift.js";
import type { EngineContext } from "./engine-types.js";
import {
  loadResolvedProfile,
  resolveSourceRoot,
} from "./planning-helpers.js";

/** Build a drift report for all profile resources. */
export async function buildDriftReport(ctx: EngineContext): Promise<{
  items: Awaited<ReturnType<typeof computeResourceDrift>>[];
  summary: string;
}> {
  const resourcesFile = await loadResources(
    path.join(ctx.configRepoPath, "resources.yaml"),
  );
  const { profile, parents } = await loadResolvedProfile(
    ctx.configRepoPath,
    ctx.profileName,
  );
  const selected = new Set(
    resolveProfileResources(
      profile,
      resourcesFile.resources.map((r) => r.id),
      parents,
    ),
  );
  const items = [];
  const targets: TargetTool[] = [];
  if (ctx.localConfig.targets.claude) targets.push("claude");
  if (ctx.localConfig.targets.codex) targets.push("codex");

  for (const resource of resourcesFile.resources) {
    if (!selected.has(resource.id)) continue;
    for (const target of targets) {
      if (!resource.targets[target]?.enabled) continue;
      const sourceRoot = await resolveSourceRoot(ctx, resource);
      items.push(
        await computeResourceDrift({
          home: ctx.home,
          resource,
          target,
          sourceRoot,
        }),
      );
    }
  }

  const drifted = items.filter((i) => i.kind !== "in-sync");
  return {
    items,
    summary:
      drifted.length === 0
        ? "No drift"
        : `${drifted.length} drifted / missing resource(s)`,
  };
}
