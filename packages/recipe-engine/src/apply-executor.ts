import path from "node:path";
import {
  assertNoSymlinksInTree,
  captureTransactionsDir,
  claudeSkillsDir,
  codexSkillsDir,
  hashDirectory,
  hashFile,
  loadLock,
  loadResources,
  localStatePath,
  pathExists,
  safeJoin,
  shortHash,
  validateRecipeRef,
  validateTargetRecipeForApply,
  type Plan,
  type PlanAction,
  type RiskLevel,
  type StateFile,
  type TargetTool,
} from "@ai-config-sync/core";
import { getDriver, type ApplyReceipt } from "@ai-config-sync/drivers";
import {
  acquireFileLock,
  appendLog,
  beginTransaction,
  confirmCreatedPaths,
  getState,
  lockFilePath,
  putState,
  releaseFileLock,
  rollbackBackup,
  type BackupRecord,
} from "@ai-config-sync/state-manager";
import { getHeadCommit } from "@ai-config-sync/git-sync";
import { loadRecipeRegistry } from "./analyzer.js";
import { buildPlan } from "./plan-builder.js";
import type {
  ApplyResult,
  EngineContext,
  ResourceTargetKey,
} from "./engine-types.js";
import {
  DIRECTORY_INPUT,
  FILE_INPUT,
  MISSING_INPUT,
  resolveRecipe,
  resolveSourceRoot,
} from "./planning-helpers.js";

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

/**
 * Detect whether the inputs a plan was built from have drifted since the plan
 * was created. Returns a human reason string when the plan is stale (so apply
 * must refuse), or undefined when the plan is fresh or carries no snapshot.
 *
 * - configRepoCommit: HEAD changed → user pulled/rewrote the repo after plan
 * - recipeHash: the recipe file this action came from was edited after plan
 * - sourceCommit: a locked source advanced past the snapshot
 */
async function detectSnapshotDrift(
  ctx: EngineContext,
  action: PlanAction | undefined,
): Promise<string | undefined> {
  if (!action) return undefined;

  // Recipe-file hash drift
  if (action.recipeRef && action.recipeHash) {
    const reqPath = validateRecipeRef(ctx.configRepoPath, action.recipeRef);
    if (await pathExists(reqPath.absPath)) {
      try {
        const now = shortHash(await hashFile(reqPath.absPath));
        if (now !== action.recipeHash) {
          return `recipe ${action.recipeRef} changed (hash ${action.recipeHash} → ${now})`;
        }
      } catch {
        /* unreadable: leave to security revalidation */
      }
    }
  }

  // Source-commit drift (git resources) — only when a lock records a *current*
  // commit that differs from the one snapshotted at plan time.
  if (action.resourceId && action.sourceCommit) {
    try {
      const lock = await loadLock(path.join(ctx.configRepoPath, "lock.yaml"));
      const locked = lock.entries.find((e) => e.resourceId === action.resourceId);
      if (locked?.commit && locked.commit !== action.sourceCommit) {
        return `source commit for ${action.resourceId} changed (${action.sourceCommit} → ${locked.commit})`;
      }
    } catch {
      /* ignore */
    }
  }

  return undefined;
}

/**
 * Verify the plan's config-repo commit still matches the live HEAD.
 * Used once at the top of applyPlan — refuses the whole apply when the repo
 * advanced under the user (e.g. they pulled between plan and apply).
 */
async function detectConfigRepoDrift(
  ctx: EngineContext,
  plan: Plan,
): Promise<string | undefined> {
  const snapshotted = plan.snapshot?.configRepoCommit;
  if (!snapshotted) return undefined;
  try {
    const head = await getHeadCommit(ctx.configRepoPath);
    if (head && head !== snapshotted) {
      return `config repo HEAD changed (${snapshotted} → ${head})`;
    }
  } catch {
    /* non-git repo: nothing to compare */
  }
  for (const [rel, expected] of Object.entries(plan.snapshot?.inputHashes ?? {})) {
    const abs = safeJoin(ctx.configRepoPath, rel);
    if (expected === MISSING_INPUT) {
      if (await pathExists(abs)) return `config input added: ${rel}`;
      continue;
    }
    if (!(await pathExists(abs))) {
      return `config input removed: ${rel}`;
    }
    const current = expected.startsWith(DIRECTORY_INPUT)
      ? `${DIRECTORY_INPUT}${shortHash(await hashDirectory(abs))}`
      : `${expected.startsWith(FILE_INPUT) ? FILE_INPUT : ""}${shortHash(await hashFile(abs))}`;
    if (current !== expected) {
      return `config input changed: ${rel} (hash ${expected} → ${current})`;
    }
  }
  return undefined;
}

export async function applyPlan(
  ctx: EngineContext,
  plan?: Plan,
): Promise<ApplyResult> {
  const activePlan = plan ?? (await buildPlan(ctx));

  // Ticket 1: a plan passed to apply must be immutable. If the config repo
  // advanced since the plan was built (user pulled, another capture committed),
  // refuse the whole apply - the user never saw this plan.
  const repoDrift = await detectConfigRepoDrift(ctx, activePlan);
  if (repoDrift) {
    throw new Error(
      `Plan is stale: ${repoDrift}. Re-run plan to see the current plan before apply.`,
    );
  }

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

  if (!ctx.dryRun && !ctx.yes) {
    throw new Error("Apply requires confirmation. Re-run with --yes after reviewing the plan.");
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

  // Ticket 6 / Apply Lock: serialize concurrent applies to the same HOME so two
  // sessions cannot simultaneously mutate Skills, Hooks and state.json.
  // Non-dryRun only; dry runs are read-only plan previews.
  const lockBase = captureTransactionsDir(ctx.home);
  const repoLockPath = lockFilePath(lockBase, "config-repo", ctx.configRepoPath);
  const lockPath = lockFilePath(
    lockBase,
    "home-apply",
    ctx.home,
  );
  const repoLock = ctx.dryRun
    ? undefined
    : await acquireFileLock(repoLockPath, {
        pid: process.pid,
        startedAt: new Date().toISOString(),
        scope: "config-repo",
        target: path.resolve(ctx.configRepoPath),
        command: "applyPlan",
      });
  let applyLock: string | undefined;
  try {
    applyLock = ctx.dryRun
      ? undefined
      : await acquireFileLock(lockPath, {
        pid: process.pid,
        startedAt: new Date().toISOString(),
        scope: "home-apply",
        target: path.resolve(ctx.home),
        command: "applyPlan",
      });
    // Re-check only after both locks are held. This closes the race where a
    // concurrent capture changed resources/profile/recipes after the initial
    // Plan check but before the first target write.
    const lockedDrift = await detectConfigRepoDrift(ctx, activePlan);
    if (lockedDrift) {
      throw new Error(
        `Plan is stale: ${lockedDrift}. Re-run plan to see the current plan before apply.`,
      );
    }
    return await runApplyBody(ctx, activePlan, actionable, paths);
  } finally {
    if (applyLock) await releaseFileLock(applyLock);
    if (repoLock) await releaseFileLock(repoLock);
  }
}

async function runApplyBody(
  ctx: EngineContext,
  activePlan: Plan,
  actionable: PlanAction[],
  paths: string[],
): Promise<ApplyResult> {
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

    const resolved = await resolveRecipe(
      ctx.configRepoPath,
      resource,
      target,
      registry,
    );
    const recipe = resolved?.recipe;
    const targetRecipe = recipe?.targets[target];
    if (!recipe || !targetRecipe) {
      manual.push(`No recipe for ${resourceId}@${target}`);
      continue;
    }

    // Stale-plan detection (Ticket 1): if the plan snapshotted a recipe hash
    // and/or config-repo commit, refuse to write when inputs drifted between
    // the plan the user approved and this apply.
    {
      const planAction = group[0];
      const drifted = await detectSnapshotDrift(ctx, planAction);
      if (drifted) {
        failed.push({
          actionId: group[0]!.id,
          error: `Plan is stale (${drifted}). Run plan again before apply. No files modified for ${resourceId}@${target}.`,
        });
        hardFailure = true;
        break;
      }
    }

    // Re-validate security on the *current* recipe before any driver.apply
    // (Plan may have been built earlier; recipe files may have changed.)
    let applyRisk = targetRecipe.risk;
    try {
      const revalidated = validateTargetRecipeForApply(
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
      applyRisk = revalidated.risk;
    } catch (e) {
      failed.push({
        actionId: group[0]!.id,
        error: `security revalidation blocked apply: ${(e as Error).message}`,
      });
      hardFailure = true;
      break;
    }

    // If recomputed risk exceeds plan action risk or --allow-risk, stop with no writes
    const planRisk = group.reduce(
      (max, a) => (riskRank(a.risk) > riskRank(max) ? a.risk : max),
      "low" as RiskLevel,
    );
    if (riskRank(applyRisk) > riskRank(planRisk)) {
      failed.push({
        actionId: group[0]!.id,
        error:
          `Recipe risk increased since plan (${planRisk} → ${applyRisk}). ` +
          `Re-run plan/apply. No files were modified for ${resourceId}@${target}.`,
      });
      hardFailure = true;
      break;
    }
    const maxAllow = ctx.allowRisk ?? "low";
    if (riskRank(applyRisk) > riskRank(maxAllow)) {
      failed.push({
        actionId: group[0]!.id,
        error:
          `Apply risk ${applyRisk} exceeds --allow-risk ${maxAllow} ` +
          `for ${resourceId}@${target}. No files were modified.`,
      });
      hardFailure = true;
      break;
    }

    let sourceRoot: string | undefined;
    try {
      sourceRoot = await resolveSourceRoot(ctx, resource);
    } catch (e) {
      if ((e as Error).message?.startsWith("Symlink rejected")) {
        failed.push({
          actionId: group[0]!.id,
          error: `security: ${(e as Error).message}`,
        });
        hardFailure = true;
        break;
      }
      throw e;
    }

    // Final symlink check on resolved source root before apply
    if (sourceRoot) {
      try {
        await assertNoSymlinksInTree(sourceRoot);
      } catch (e) {
        failed.push({
          actionId: group[0]!.id,
          error: `security: ${(e as Error).message}`,
        });
        hardFailure = true;
        break;
      }
    }

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
