import path from "node:path";
import {
  claudeSkillsDir,
  codexSkillsDir,
  hashDirectory,
  hashFile,
  isUnder,
  loadLock,
  loadResources,
  pathExists,
  resolveProfileResources,
  shortHash,
  validateTargetRecipeForApply,
  type Plan,
  type PlanAction,
  type Profile,
  type RiskLevel,
  type TargetTool,
} from "@ai-config-sync/core";
import { getDriver, recipePathsValid } from "@ai-config-sync/drivers";
import { getHeadCommit } from "@ai-config-sync/git-sync";
import { getState } from "@ai-config-sync/state-manager";
import { loadRecipeRegistry } from "./analyzer.js";
import { computeResourceDrift } from "./drift.js";
import type { EngineContext } from "./engine-types.js";
import {
  DIRECTORY_INPUT,
  FILE_INPUT,
  MISSING_INPUT,
  loadResolvedProfile,
  resolveRecipe,
  resolveSourceRoot,
} from "./planning-helpers.js";

function sameResolvedPath(left: string | undefined, right: string): boolean {
  if (!left) return false;
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function skillTargetPath(home: string, target: TargetTool, resourceId: string): string {
  return target === "claude"
    ? path.join(claudeSkillsDir(home), resourceId)
    : path.join(codexSkillsDir(home), resourceId);
}

export async function buildPlan(ctx: EngineContext): Promise<Plan> {
  const resourcesFile = await loadResources(
    path.join(ctx.configRepoPath, "resources.yaml"),
  );
  const { profile, parents, files: profileFiles } = await loadResolvedProfile(
    ctx.configRepoPath,
    ctx.profileName,
  );
  const allIds = resourcesFile.resources.map((r) => r.id);
  const selectedIds = new Set(
    resolveProfileResources(
      profile,
      allIds,
      parents,
      resourcesFile.resources.map((r) => ({ id: r.id, profiles: r.profiles })),
    ),
  );
  const resources = resourcesFile.resources.filter((r) =>
    selectedIds.has(r.id),
  );

  const maxRisk = profile.security?.maxRisk ?? "medium";
  const riskRankLocal = (r: "low" | "medium" | "high") =>
    r === "low" ? 1 : r === "medium" ? 2 : 3;

  const registry = await loadRecipeRegistry(
    path.join(ctx.configRepoPath, "recipes"),
  );
  const actions: PlanAction[] = [];
  const machineState = await getState(ctx.home);
  const repoSourceDirs = new Set<string>();
  let actionSeq = 0;

  const enabledTargets: TargetTool[] = [];
  if (ctx.localConfig.targets.claude) enabledTargets.push("claude");
  if (ctx.localConfig.targets.codex) enabledTargets.push("codex");

  for (const resource of resources) {
    for (const target of enabledTargets) {
      const tcfg = resource.targets[target];
      if (!tcfg?.enabled) continue;

      const resolved = await resolveRecipe(
        ctx.configRepoPath,
        resource,
        target,
        registry,
      );
      if (!resolved) {
        actions.push({
          id: `a${++actionSeq}`,
          type: "MANUAL",
          target,
          resourceId: resource.id,
          description: `MANUAL: no confirmed recipe for ${resource.id}@${target}`,
          risk: "medium",
          paths: [],
          requiresConfirmation: true,
        });
        continue;
      }
      const recipe = resolved.recipe;
      const recipeFileRel = resolved.absPath
        ? path.relative(ctx.configRepoPath, resolved.absPath).replace(/\\/g, "/")
        : undefined;
      // Stale-plan signal: content hash of the recipe file at plan-build time.
      // Apply re-hashes and refuses if anyone edited the recipe in between.
      let recipeHash: string | undefined;
      if (resolved.absPath) {
        try {
          recipeHash = shortHash(await hashFile(resolved.absPath));
        } catch {
          /* unreadable file: no hash recorded */
        }
      }
      // Lock-derived source commit (for git sources), captured into the plan.
      let sourceCommit: string | undefined;
      if (resource.source?.provider === "github" || resource.source?.provider === "git") {
        try {
          const lock = await loadLock(path.join(ctx.configRepoPath, "lock.yaml"));
          const locked = lock.entries.find((e) => e.resourceId === resource.id);
          sourceCommit = locked?.commit ?? resource.source?.commit;
        } catch {
          /* ignore */
        }
      }

      const targetRecipe = recipe.targets[target];
      if (!targetRecipe) {
        actions.push({
          id: `a${++actionSeq}`,
          type: "MANUAL",
          target,
          resourceId: resource.id,
          description: `MANUAL: recipe ${recipe.id} has no target ${target}`,
          risk: "medium",
          paths: [],
          requiresConfirmation: true,
        });
        continue;
      }

      // Central path/risk validation — never trust recipe.risk or raw paths
      let engineRisk: RiskLevel = targetRecipe.risk;
      try {
        const validated = validateTargetRecipeForApply(
          ctx.home,
          target,
          ctx.configRepoPath,
          targetRecipe,
          {
            resourceSourcePath:
              resource.source?.provider === "vendored" ||
              resource.source?.provider === "local"
                ? resource.source.path
                : undefined,
          },
        );
        engineRisk = validated.risk;
      } catch (e) {
        actions.push({
          id: `a${++actionSeq}`,
          type: "MANUAL",
          target,
          resourceId: resource.id,
          description: `MANUAL security: ${(e as Error).message}`,
          risk: "high",
          driver: targetRecipe.driver,
          paths: [],
          requiresConfirmation: true,
        });
        continue;
      }
      // Prefer higher of declared vs recomputed for gating, but recompute is authority
      const effectiveRisk = engineRisk;

      const sourceRoot = await resolveSourceRoot(ctx, resource);
      const sourcesRoot = path.join(ctx.configRepoPath, "sources");
      if (sourceRoot && isUnder(sourcesRoot, sourceRoot)) {
        repoSourceDirs.add(path.resolve(sourceRoot));
      }

      // Layout drivers need a local source tree; marketplace may work without it.
      if (
        (targetRecipe.driver === "repository-layout" ||
          targetRecipe.driver === "generic-skill") &&
        !sourceRoot
      ) {
        actions.push({
          id: `a${++actionSeq}`,
          type: "MANUAL",
          target,
          resourceId: resource.id,
          description: `MANUAL: source not available locally for ${resource.id}@${target} (clone/cache or vendor first)`,
          risk: "medium",
          driver: targetRecipe.driver,
          paths: [],
          requiresConfirmation: true,
        });
        continue;
      }

      if (sourceRoot) {
        const validity = await recipePathsValid(targetRecipe, sourceRoot);
        if (!validity.ok) {
          actions.push({
            id: `a${++actionSeq}`,
            type: "MANUAL",
            target,
            resourceId: resource.id,
            description: `MANUAL recipe-stale: missing ${validity.missing.join(", ")}`,
            risk: "high",
            driver: targetRecipe.driver,
            paths: validity.missing,
            requiresConfirmation: true,
          });
          continue;
        }
      }

      let targetSnapshot: PlanAction["targetSnapshot"];
      if (
        targetRecipe.driver === "generic-skill" ||
        targetRecipe.driver === "repository-layout"
      ) {
        const targetPath = skillTargetPath(ctx.home, target, resource.id);
        if (!(await pathExists(targetPath))) {
          targetSnapshot = {
            path: targetPath,
            existed: false,
            ownership: "absent",
          };
        } else {
          let actualHash: string | undefined;
          try {
            actualHash = shortHash(await hashDirectory(targetPath));
          } catch {
            /* unreadable target is not considered owned */
          }
          const recorded = machineState.installed[resource.id]?.[target];
          const owned =
            recorded?.status === "installed" &&
            sameResolvedPath(recorded.path, targetPath) &&
            !!recorded.hash &&
            !!actualHash &&
            recorded.hash === actualHash;
          if (!owned) {
            const reason = recorded
              ? "existing target no longer matches the recorded deployment"
              : "existing target has no AI Config Sync ownership record";
            actions.push({
              id: `a${++actionSeq}`,
              type: "MANUAL",
              target,
              resourceId: resource.id,
              description:
                `MANUAL collision-unmanaged: ${targetPath} (${reason}). ` +
                "Adopt it explicitly or move it aside; no files will be replaced.",
              risk: "high",
              driver: targetRecipe.driver,
              paths: [targetPath],
              requiresConfirmation: true,
            });
            continue;
          }
          targetSnapshot = {
            path: targetPath,
            existed: true,
            hash: actualHash,
            ownership: "managed",
          };
        }
      }

      // Skip when already installed and in sync (generic-skill / copy targets)
      if (
        targetRecipe.driver === "generic-skill" ||
        targetRecipe.driver === "repository-layout"
      ) {
        const drift = await computeResourceDrift({
          home: ctx.home,
          resource,
          target,
          sourceRoot,
        });
        if (drift.kind === "in-sync") {
          actions.push({
            id: `a${++actionSeq}`,
            type: "SKIP",
            target,
            resourceId: resource.id,
            description: `SKIP ${target} ${resource.id}: already installed and in sync`,
            risk: "low",
            driver: targetRecipe.driver,
            paths: drift.path ? [drift.path] : [],
            requiresConfirmation: false,
            targetSnapshot,
          });
          continue;
        }
      }

      const driver = getDriver(targetRecipe.driver);
      const planned = await driver.plan(targetRecipe, {
        home: ctx.home,
        resourceId: resource.id,
        target,
        sourceRoot,
        dryRun: true,
      });

      for (const p of planned) {
        const type =
          p.description.startsWith("COPY")
            ? "COPY"
            : p.description.startsWith("MERGE")
              ? "MERGE"
              : p.description.startsWith("UPDATE")
                ? "UPDATE"
                : p.description.startsWith("ENABLE")
                  ? "ENABLE"
                  : p.description.startsWith("CREATE")
                    ? "CREATE"
                    : "UPDATE";
        // Engine-recomputed risk is authoritative; never trust recipe.risk alone
        let risk = effectiveRisk;
        // Still consider path-level plan risk if higher
        if (riskRankLocal(p.risk) > riskRankLocal(risk)) {
          risk = p.risk;
        }
        let requiresConfirmation = risk !== "low";
        let description = p.description;
        if (riskRankLocal(risk) > riskRankLocal(maxRisk)) {
          actions.push({
            id: `a${++actionSeq}`,
            type: "MANUAL",
            target,
            resourceId: resource.id,
            description: `MANUAL blocked by profile maxRisk=${maxRisk}: ${p.description}`,
            risk,
            driver: targetRecipe.driver,
            paths: p.paths,
            requiresConfirmation: true,
          });
          continue;
        }
        actions.push({
          id: `a${++actionSeq}`,
          type,
          target,
          resourceId: resource.id,
          description,
          risk,
          driver: targetRecipe.driver,
          paths: p.paths,
          requiresConfirmation,
          recipeRef: recipeFileRel,
          recipeHash,
          sourceCommit,
          targetSnapshot,
        });
      }
    }
  }

  // secret manual hints from lock optional — skip

  // Capture the config-repo HEAD so a later apply can detect the plan is stale
  // (remote changed / recipe files edited between plan and apply).
  let configRepoCommit: string | undefined;
  try {
    configRepoCommit = await getHeadCommit(ctx.configRepoPath);
  } catch {
    /* non-git repos: no commit snapshotted */
  }
  const inputHashes: Record<string, string> = {};
  const mutableInputs = [
    path.join(ctx.configRepoPath, "resources.yaml"),
    path.join(ctx.configRepoPath, "lock.yaml"),
    path.join(ctx.configRepoPath, "config.yaml"),
    ...profileFiles,
  ];
  for (const file of mutableInputs) {
    const rel = path.relative(ctx.configRepoPath, file).replace(/\\/g, "/");
    inputHashes[rel] = (await pathExists(file))
      ? `${FILE_INPUT}${shortHash(await hashFile(file))}`
      : MISSING_INPUT;
  }
  for (const dir of repoSourceDirs) {
    const rel = path.relative(ctx.configRepoPath, dir).replace(/\\/g, "/");
    inputHashes[rel] = `${DIRECTORY_INPUT}${shortHash(await hashDirectory(dir))}`;
  }

  const plan: Plan = {
    id: `plan-${Date.now()}`,
    profile: ctx.profileName,
    configRepository: ctx.configRepoPath,
    createdAt: new Date().toISOString(),
    actions,
    summary:
      actions.length === 0
        ? "No changes"
        : `${actions.length} action(s) for profile ${ctx.profileName}`,
    snapshot: {
      configRepoCommit,
      recipeHashes: {},
      sourceCommits: {},
      inputHashes,
    },
  };
  // Populate snapshot maps keyed by recipeRef / resourceId (deduped).
  const recipeHashes: Record<string, string> = {};
  const sourceCommits: Record<string, string> = {};
  for (const a of actions) {
    if (a.recipeRef && a.recipeHash) recipeHashes[a.recipeRef] = a.recipeHash;
    if (a.resourceId && a.sourceCommit)
      sourceCommits[a.resourceId] = a.sourceCommit;
  }
  plan.snapshot = {
    configRepoCommit,
    recipeHashes,
    sourceCommits,
    inputHashes,
  };
  return plan;
}

export function formatPlan(plan: Plan): string {
  const lines: string[] = [];
  lines.push(`Profile: ${plan.profile}`);
  if (plan.configRepository) {
    lines.push(`Config repository: ${plan.configRepository}`);
  }
  lines.push("");
  if (plan.actions.length === 0) {
    lines.push("No changes");
    return lines.join("\n");
  }
  for (const a of plan.actions) {
    lines.push(a.description);
  }
  lines.push("");
  lines.push("No OAuth, session or cache files will be changed.");
  return lines.join("\n");
}
