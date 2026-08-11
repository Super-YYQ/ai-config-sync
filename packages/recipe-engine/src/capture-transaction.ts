import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import crypto from "node:crypto";
import {
  RecipeSchema,
  saveRecipe,
  saveResources,
  loadResources,
  loadRecipe,
  pathExists,
  isSelfManagedResourceId,
  captureTransactionsDir,
  ensureDir,
  recipeRelPath,
  safeJoin,
  assertSafeRelPath,
  type Recipe,
  type Resource,
} from "@ai-config-sync/core";
import {
  acquireFileLock,
  releaseFileLock,
  lockFilePath,
} from "@ai-config-sync/state-manager";
import { validateCaptureProposal } from "./capture-policy.js";
import type {
  CaptureCommitResult,
  CaptureItem,
  CaptureTransaction,
  CaptureTxEntry,
} from "./capture-types.js";
import { vendorSkillDirectory } from "./vendor.js";
import {
  ASSET_CATALOG_HTML_REL,
  ASSET_CATALOG_MARKDOWN_REL,
  writeAssetCatalog,
} from "./catalog.js";

async function entryType(abs: string): Promise<"file" | "directory"> {
  try {
    const st = await fs.stat(abs);
    return st.isDirectory() ? "directory" : "file";
  } catch {
    return "file";
  }
}
/**
 * Precise rollback: delete newly created paths; for pre-existing paths,
 * remove current content then restore full backup.
 */
export async function rollbackCaptureTransaction(
  tx: CaptureTransaction,
  configRepoPath: string,
): Promise<void> {
  for (const entry of tx.entries) {
    const live = path.join(configRepoPath, entry.path);
    try {
      if (!entry.existedBefore) {
        if (await pathExists(live)) {
          await fs.rm(live, { recursive: true, force: true });
        }
        continue;
      }
      if (await pathExists(live)) {
        await fs.rm(live, { recursive: true, force: true });
      }
      if (entry.backupPath && (await pathExists(entry.backupPath))) {
        await ensureDir(path.dirname(live));
        await fs.cp(entry.backupPath, live, { recursive: true });
      }
    } catch {
      /* best effort per path */
    }
  }
}

/**
 * Persist confirmed capture items into the private config repo.
 * Transactional: stage under ~/.ai-config-sync/capture-transactions/,
 * backup existing targets, replace, and precisely roll back on failure.
 * Merges dual-target recipes instead of overwriting.
 */
export async function commitCaptureItems(
  items: CaptureItem[],
  configRepoPath: string,
  confirmedBy = "user",
  options: {
    home?: string;
    /** Test hook: throw after replace of these relative paths. */
    injectFailureAfter?: string[];
    /** Test hook: delay after lock acquired, before reading resources. */
    injectDelayMs?: number;
    /**
     * Optional follow-up executed while the config-repo lock is still held.
     * Used by the CLI to make capture + git commit one serialized operation.
     */
    afterWrite?: (result: CaptureCommitResult) => Promise<void>;
  } = {},
): Promise<CaptureCommitResult> {
  // Stage/backup outside the private git repo
  const home = options.home ?? os.homedir();
  const txBase = captureTransactionsDir(home);
  await ensureDir(txBase);

  // Repo-level mutex — acquire BEFORE reading resources.yaml so concurrent
  // captures (and capture → commit) re-read under one lock (no lost updates,
  // no cross-commit). Shared across capture/commit/push so the user's commit
  // can never race a second capture writing resources.yaml.
  const lockPath = lockFilePath(txBase, "config-repo", configRepoPath);
  const lockPayload = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    target: path.resolve(configRepoPath),
    scope: "config-repo",
    command: "commitCaptureItems",
  };

  await acquireFileLock(lockPath, lockPayload, {
    maxAttempts: 60,
    injectThrowAfterAcquire: options.injectFailureAfter?.includes("__throw-after-lock__"),
  });

  // ALL post-lock work is under try/finally so corrupt resources.yaml,
  // permission errors, or inject failures always release the lock.
  try {
    if (options.injectDelayMs && options.injectDelayMs > 0) {
      await new Promise((r) => setTimeout(r, options.injectDelayMs));
    }

    const resourcesPath = path.join(configRepoPath, "resources.yaml");
    // Re-read under lock so concurrent captures see each other's commits
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

    const txId = crypto.randomUUID();
    const stagingRoot = path.join(txBase, `${txId}-staging`);
    const backupRoot = path.join(txBase, `${txId}-backup`);
    const stagedRecipeRels: string[] = [];
    const stagedVendorRels: string[] = [];
    const txEntries: CaptureTxEntry[] = [];

    const trackPath = async (rel: string) => {
      if (txEntries.some((e) => e.path === rel)) return;
      const live = path.join(configRepoPath, rel);
      const existedBefore = await pathExists(live);
      const type = existedBefore ? await entryType(live) : "file";
      let backupPath: string | undefined;
      if (existedBefore) {
        backupPath = path.join(backupRoot, rel);
        await ensureDir(path.dirname(backupPath));
        await fs.cp(live, backupPath, { recursive: true });
      }
      txEntries.push({ path: rel, existedBefore, backupPath, type });
    };

    let completed: CaptureCommitResult;
    try {
      await fs.mkdir(path.join(stagingRoot, "recipes"), { recursive: true });
      await fs.mkdir(backupRoot, { recursive: true });

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
        const recipeRel = assertSafeRelPath(
          recipeRelPath(item.suggestedResource.id),
        );
        const recipeFileLive = safeJoin(configRepoPath, recipeRel);
        const recipeFileStage = safeJoin(stagingRoot, recipeRel);
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

    // Track + backup every path we will touch (existedBefore drives rollback)
    await trackPath("resources.yaml");
    for (const rel of stagedRecipeRels) await trackPath(rel);
    for (const rel of stagedVendorRels) await trackPath(rel);
    await trackPath(ASSET_CATALOG_MARKDOWN_REL);
    await trackPath(ASSET_CATALOG_HTML_REL);

    // Replace: vendor dirs first, then recipes, then resources
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
      if (options.injectFailureAfter?.includes(rel)) {
        throw new Error(`injectFailureAfter: ${rel}`);
      }
    }
    for (const rel of stagedRecipeRels) {
      const from = path.join(stagingRoot, rel);
      const to = path.join(configRepoPath, rel);
      if (await pathExists(to)) {
        await fs.rm(to, { recursive: true, force: true });
      }
      await fs.mkdir(path.dirname(to), { recursive: true });
      await fs.rename(from, to).catch(async () => {
        await fs.copyFile(from, to);
        await fs.rm(from, { force: true });
      });
      if (options.injectFailureAfter?.includes(rel)) {
        throw new Error(`injectFailureAfter: ${rel}`);
      }
    }
    {
      const from = stagedResources;
      const to = resourcesPath;
      if (await pathExists(to)) {
        await fs.rm(to, { force: true });
      }
      await fs.rename(from, to).catch(async () => {
        await fs.copyFile(from, to);
        await fs.rm(from, { force: true });
      });
      if (options.injectFailureAfter?.includes("resources.yaml")) {
        throw new Error("injectFailureAfter: resources.yaml");
      }
    }

    // The catalog is a deterministic read-only projection of the live repo.
    // Generate it inside the same transaction so a render/write failure rolls
    // back resources, recipes, vendored sources, and both catalog views.
    const catalogResult = await writeAssetCatalog(configRepoPath);
    for (const rel of [ASSET_CATALOG_MARKDOWN_REL, ASSET_CATALOG_HTML_REL]) {
      if (options.injectFailureAfter?.includes(rel)) {
        throw new Error(`injectFailureAfter: ${rel}`);
      }
    }

    // Success — drop backup and staging
      await fs.rm(backupRoot, { recursive: true, force: true }).catch(() => {});
      await fs.rm(stagingRoot, { recursive: true, force: true }).catch(() => {});

      const changedRelPaths = [
        "resources.yaml",
        ...stagedRecipeRels,
        ...stagedVendorRels,
        ASSET_CATALOG_MARKDOWN_REL,
        ASSET_CATALOG_HTML_REL,
      ];
      // Deduplicate while preserving order
      const seen = new Set<string>();
      const uniqueChanged = changedRelPaths.filter((p) => {
        if (seen.has(p)) return false;
        seen.add(p);
        return true;
      });

      completed = {
        resourcesPath,
        recipePaths,
        catalogPaths: [catalogResult.markdownPath, catalogResult.htmlPath],
        changedRelPaths: uniqueChanged,
      };
    } catch (e) {
      // Precise restore: delete new paths; restore pre-existing from backup
      try {
        await rollbackCaptureTransaction(
          {
            id: txId,
            stagingRoot,
            backupRoot,
            entries: txEntries,
          },
          configRepoPath,
        );
      } catch {
        /* best effort */
      }
      await fs.rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
      // keep backup on failure for manual recovery (outside git repo)
      throw e;
    }
    if (options.afterWrite) await options.afterWrite(completed);
    return completed;
  } finally {
    await releaseFileLock(lockPath);
  }
}
