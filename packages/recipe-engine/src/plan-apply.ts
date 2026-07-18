import path from "node:path";
import {
  claudeSkillsDir,
  codexSkillsDir,
  hashDirectory,
  loadLock,
  loadProfile,
  loadRecipe,
  loadResources,
  parseRecipeRef,
  pathExists,
  resolveProfileResources,
  shortHash,
  localStatePath,
  type LocalConfig,
  type Plan,
  type PlanAction,
  type Profile,
  type Recipe,
  type Resource,
  type RiskLevel,
  type TargetTool,
  type StateFile,
} from "@ai-config-sync/core";
import {
  getDriver,
  recipePathsValid,
  type ApplyReceipt,
} from "@ai-config-sync/drivers";
import {
  beginTransaction,
  confirmCreatedPaths,
  getState,
  putState,
  appendLog,
  rollbackBackup,
  type BackupRecord,
} from "@ai-config-sync/state-manager";
import { resolveCachedSource } from "@ai-config-sync/git-sync";
import { loadRecipeRegistry } from "./analyzer.js";
import { computeResourceDrift } from "./drift.js";

export interface EngineContext {
  home: string;
  configRepoPath: string;
  localConfig: LocalConfig;
  profileName: string;
  dryRun?: boolean;
  yes?: boolean;
  allowRisk?: RiskLevel;
  sourceRoots?: Record<string, string>;
  /** Fetch/update cached sources (for update command). */
  updateSources?: boolean;
  offline?: boolean;
}

/** Group key for apply — never join with characters that appear in resource ids. */
export interface ResourceTargetKey {
  resourceId: string;
  target: TargetTool | "_";
}

/**
 * Group plan actions by (resourceId, target) using nested maps so ids like
 * `hooks:SessionStart` or `plugin@marketplace` are not truncated by split(":").
 */
export function groupActionsByResourceTarget(
  actions: PlanAction[],
): Map<ResourceTargetKey, PlanAction[]> {
  const nested = new Map<string, Map<string, PlanAction[]>>();
  for (const a of actions) {
    const resourceId = a.resourceId ?? "_";
    const target = (a.target ?? "_") as string;
    let byTarget = nested.get(resourceId);
    if (!byTarget) {
      byTarget = new Map();
      nested.set(resourceId, byTarget);
    }
    const list = byTarget.get(target) ?? [];
    list.push(a);
    byTarget.set(target, list);
  }
  const out = new Map<ResourceTargetKey, PlanAction[]>();
  for (const [resourceId, byTarget] of nested) {
    for (const [target, list] of byTarget) {
      out.set(
        { resourceId, target: target as TargetTool | "_" },
        list,
      );
    }
  }
  return out;
}

async function resolveSourceRoot(
  ctx: EngineContext,
  resource: Resource,
): Promise<string | undefined> {
  if (ctx.sourceRoots?.[resource.id]) return ctx.sourceRoots[resource.id];

  // Relative path inside private config repo (vendored / local)
  if (resource.source?.path) {
    const p = path.isAbsolute(resource.source.path)
      ? resource.source.path
      : path.join(ctx.configRepoPath, resource.source.path);
    if (await pathExists(p)) return p;
  }

  const vendored = path.join(
    ctx.configRepoPath,
    "sources",
    "skills",
    resource.id,
  );
  if (await pathExists(vendored)) return vendored;

  // GitHub / git cache
  try {
    const lock = await loadLock(path.join(ctx.configRepoPath, "lock.yaml"));
    const locked = lock.entries.find((e) => e.resourceId === resource.id);
    const cached = await resolveCachedSource(resource.source, {
      home: ctx.home,
      ref: locked?.commit ?? resource.source?.commit,
      update: !!ctx.updateSources,
      offline: !!ctx.offline,
    });
    return cached?.root;
  } catch {
    return undefined;
  }
}

function installedSkillPath(
  home: string,
  target: TargetTool,
  resourceId: string,
): string {
  return target === "claude"
    ? path.join(claudeSkillsDir(home), resourceId)
    : path.join(codexSkillsDir(home), resourceId);
}

function riskRank(r: RiskLevel): number {
  return r === "low" ? 1 : r === "medium" ? 2 : 3;
}

function riskAllowed(
  actionRisk: RiskLevel,
  allowRisk: RiskLevel | undefined,
  yes: boolean | undefined,
): boolean {
  if (!yes) return false;
  const max = allowRisk ?? "low";
  return riskRank(actionRisk) <= riskRank(max);
}

async function loadResolvedProfile(
  configRepoPath: string,
  profileName: string,
): Promise<{ profile: Profile; parents: Profile[] }> {
  const profilePath = path.join(
    configRepoPath,
    "profiles",
    `${profileName}.yaml`,
  );
  if (!(await pathExists(profilePath))) {
    // synthetic default
    return {
      profile: {
        profile: profileName,
        extends: [],
        include: { resources: [] },
        exclude: { resources: [] },
        security: {
          maxRisk: "medium",
          allowAutomaticLatest: false,
          secrets: { provider: "local-only" },
        },
      },
      parents: [],
    };
  }
  const profile = await loadProfile(profilePath);
  const parents: Profile[] = [];
  for (const ext of profile.extends) {
    const p = path.join(configRepoPath, "profiles", `${ext}.yaml`);
    if (await pathExists(p)) parents.push(await loadProfile(p));
  }
  return { profile, parents };
}

async function resolveRecipe(
  configRepoPath: string,
  resource: Resource,
  target: TargetTool,
  registry: Map<string, Recipe>,
): Promise<Recipe | undefined> {
  const targetCfg = resource.targets[target];
  if (!targetCfg?.enabled) return undefined;

  if (targetCfg.recipeRef) {
    const { file, target: frag } = parseRecipeRef(targetCfg.recipeRef);
    const full = path.join(configRepoPath, file);
    if (await pathExists(full)) {
      const recipe = await loadRecipe(full);
      return recipe;
    }
    // try registry by basename
    const base = path.basename(file, path.extname(file));
    return registry.get(base);
  }

  return registry.get(resource.id);
}

export async function buildPlan(ctx: EngineContext): Promise<Plan> {
  const resourcesFile = await loadResources(
    path.join(ctx.configRepoPath, "resources.yaml"),
  );
  const { profile, parents } = await loadResolvedProfile(
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
  let actionSeq = 0;

  const enabledTargets: TargetTool[] = [];
  if (ctx.localConfig.targets.claude) enabledTargets.push("claude");
  if (ctx.localConfig.targets.codex) enabledTargets.push("codex");

  for (const resource of resources) {
    for (const target of enabledTargets) {
      const tcfg = resource.targets[target];
      if (!tcfg?.enabled) continue;

      const recipe = await resolveRecipe(
        ctx.configRepoPath,
        resource,
        target,
        registry,
      );
      if (!recipe) {
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

      const sourceRoot = await resolveSourceRoot(ctx, resource);

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
        // Profile security.maxRisk: downgrade/block higher risk actions
        let risk = p.risk;
        let requiresConfirmation = p.risk !== "low";
        let description = p.description;
        if (riskRankLocal(p.risk) > riskRankLocal(maxRisk)) {
          actions.push({
            id: `a${++actionSeq}`,
            type: "MANUAL",
            target,
            resourceId: resource.id,
            description: `MANUAL blocked by profile maxRisk=${maxRisk}: ${p.description}`,
            risk: p.risk,
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
        });
      }
    }
  }

  // secret manual hints from lock optional — skip

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

export interface ApplyResult {
  plan: Plan;
  applied: string[];
  failed: Array<{ actionId: string; error: string }>;
  manual: string[];
  backupId?: string;
  noChanges: boolean;
  /** True if a failure triggered automatic rollback of this apply. */
  autoRolledBack?: boolean;
}

export async function applyPlan(
  ctx: EngineContext,
  plan?: Plan,
): Promise<ApplyResult> {
  const activePlan = plan ?? (await buildPlan(ctx));
  const actionable = activePlan.actions.filter((a) => a.type !== "SKIP");
  if (actionable.length === 0) {
    return {
      plan: activePlan,
      applied: [],
      failed: [],
      manual: [],
      noChanges: true,
    };
  }

  // Risk gate (skip SKIP entries)
  for (const a of actionable) {
    if (a.requiresConfirmation && !riskAllowed(a.risk, ctx.allowRisk, ctx.yes)) {
      if (!ctx.yes) {
        throw new Error(
          `Apply requires confirmation. Re-run with --yes --allow-risk ${a.risk} (action: ${a.description})`,
        );
      }
      if (!riskAllowed(a.risk, ctx.allowRisk, true)) {
        throw new Error(
          `Action risk ${a.risk} exceeds --allow-risk ${ctx.allowRisk ?? "low"}: ${a.description}`,
        );
      }
    }
  }

  const paths = [
    ...new Set(
      actionable
        .filter((a) => a.type !== "MANUAL")
        .flatMap((a) => a.paths)
        .filter(Boolean),
    ),
  ];
  // Always include state.json in transaction so partial installed marks can be restored
  const statePath = localStatePath(ctx.home);
  if (!paths.includes(statePath)) paths.push(statePath);

  let tx: BackupRecord | undefined;
  let backupId: string | undefined;
  if (!ctx.dryRun) {
    tx = await beginTransaction(
      paths,
      `apply ${activePlan.id}`,
      ctx.home,
      activePlan.actions,
    );
    backupId = tx.id;
  }

  const resourcesFile = await loadResources(
    path.join(ctx.configRepoPath, "resources.yaml"),
  );
  const registry = await loadRecipeRegistry(
    path.join(ctx.configRepoPath, "recipes"),
  );

  // State draft: mutate in memory; commit only on full success
  const stateDraft: StateFile = structuredClone(await getState(ctx.home));
  const receipts: ApplyReceipt[] = [];

  function draftMark(
    resourceId: string,
    target: TargetTool,
    info: {
      status: "installed" | "missing" | "drift" | "failed" | "manual";
      version?: string;
      commit?: string;
      path?: string;
      hash?: string;
      notes?: string;
    },
  ) {
    const entry = stateDraft.installed[resourceId] ?? {};
    entry[target] = {
      ...info,
      lastChecked: new Date().toISOString(),
    };
    stateDraft.installed[resourceId] = entry;
  }

  const applied: string[] = [];
  const failed: Array<{ actionId: string; error: string }> = [];
  const manual: string[] = [];
  let hardFailure = false;

  // Group actions by resource+target without string-splitting (ids may contain ':')
  const groups = groupActionsByResourceTarget(actionable);

  for (const [{ resourceId, target }, group] of groups) {
    if (resourceId === "_" || target === "_") {
      for (const a of group) {
        if (a.type === "MANUAL") manual.push(a.description);
        else if (a.type !== "SKIP") applied.push(a.description);
      }
      continue;
    }

    if (group.every((a) => a.type === "MANUAL" || a.type === "SKIP")) {
      for (const a of group) {
        if (a.type === "MANUAL") manual.push(a.description);
      }
      continue;
    }

    const resource = resourcesFile.resources.find((r) => r.id === resourceId);
    if (!resource) {
      failed.push({
        actionId: group[0]!.id,
        error: `resource not found: ${resourceId}`,
      });
      hardFailure = true;
      break;
    }

    const recipe = await resolveRecipe(
      ctx.configRepoPath,
      resource,
      target,
      registry,
    );
    const targetRecipe = recipe?.targets[target];
    if (!recipe || !targetRecipe) {
      manual.push(`No recipe for ${resourceId}@${target}`);
      continue;
    }

    const sourceRoot = await resolveSourceRoot(ctx, resource);
    const driver = getDriver(targetRecipe.driver);
    try {
      const result = await driver.apply(targetRecipe, {
        home: ctx.home,
        resourceId,
        target,
        sourceRoot,
        dryRun: ctx.dryRun,
      });
      if (result.receipt) receipts.push(result.receipt);

      if (result.externalManual) {
        manual.push(result.message);
        draftMark(resourceId, target, {
          status: "manual",
          notes: result.message,
          path: result.pathsTouched[0],
        });
      } else if (!result.ok) {
        if (
          /sourceRoot|source not|recipe-stale|Source skill path missing|requiredPath missing/i.test(
            result.message,
          )
        ) {
          manual.push(result.message);
          draftMark(resourceId, target, {
            status: "manual",
            notes: result.message,
          });
        } else {
          failed.push({ actionId: group[0]!.id, error: result.message });
          draftMark(resourceId, target, {
            status: "failed",
            notes: result.message,
          });
          hardFailure = true;
          break;
        }
      } else {
        for (const a of group) {
          if (a.type !== "SKIP" && a.type !== "MANUAL") {
            applied.push(a.description);
          }
        }
        let hash: string | undefined;
        const dest =
          result.pathsTouched[0] ??
          installedSkillPath(ctx.home, target, resourceId);
        try {
          if (dest && (await pathExists(dest))) {
            hash = shortHash(await hashDirectory(dest));
          }
        } catch {
          /* ignore */
        }
        if (tx && result.pathsTouched.length) {
          await confirmCreatedPaths(tx, result.pathsTouched, ctx.home);
        }
        draftMark(resourceId, target, {
          status: "installed",
          path: dest,
          hash,
          notes: result.message,
        });
      }
      await appendLog(
        `apply ${resourceId}@${target}: ${result.message}`,
        ctx.home,
      );
    } catch (e) {
      failed.push({
        actionId: group[0]!.id,
        error: (e as Error).message,
      });
      hardFailure = true;
      break;
    }
  }

  let autoRolledBack = false;
  if (hardFailure && !ctx.dryRun) {
    // Compensating external driver rollbacks (newest first)
    for (const receipt of [...receipts].reverse()) {
      try {
        const d = getDriver(receipt.driver as never);
        if (d.rollback) {
          const rr = await d.rollback(receipt, {
            home: ctx.home,
            resourceId: receipt.resourceId,
            target: receipt.target,
          });
          await appendLog(
            `driver-rollback ${receipt.driver}:${receipt.resourceId}: ${rr.message}`,
            ctx.home,
          );
        }
      } catch (e) {
        failed.push({
          actionId: "driver-rollback",
          error: `${receipt.driver}: ${(e as Error).message}`,
        });
      }
    }
    if (tx) {
      try {
        await rollbackBackup(tx.id, ctx.home);
        autoRolledBack = true;
        await appendLog(
          `auto-rollback ${tx.id} after apply failure`,
          ctx.home,
        );
      } catch (e) {
        failed.push({
          actionId: "rollback",
          error: `auto-rollback failed: ${(e as Error).message}`,
        });
      }
    }
    // Do NOT commit stateDraft — disk state restored from backup
  } else if (!ctx.dryRun) {
    // Commit state only after full success (manuals/skips ok)
    stateDraft.lastSuccessfulApply = new Date().toISOString();
    stateDraft.profile = ctx.profileName;
    await putState(stateDraft, ctx.home);
  }

  return {
    plan: activePlan,
    applied: autoRolledBack ? [] : applied,
    failed,
    manual,
    backupId,
    noChanges:
      applied.length === 0 && failed.length === 0 && manual.length === 0,
    autoRolledBack,
  };
}

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
