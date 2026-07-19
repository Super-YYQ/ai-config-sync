/**
 * Central path-security helpers for restore/apply.
 * Never trust recipe-authored absolute paths, traversal, or risk labels alone.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { assertSafeRelPath } from "./storage-key.js";
import {
  safeJoin,
  expandHome,
  isUnder,
  claudeSkillsDir,
  codexSkillsDir,
  codexConfigPath,
  codexHooksDir,
  codexHooksManifestPath,
  agentsSkillsDir,
  claudeHome,
  codexHome,
} from "./paths.js";
import type {
  RiskLevel,
  TargetTool,
  TargetRecipe,
} from "./schemas.js";

export { assertSafeRelPath };

/** recipeRef must resolve under configRepo/recipes/ (no abs, no ..). */
export function validateRecipeRef(
  configRepoPath: string,
  recipeRef: string,
): { file: string; target?: string; absPath: string } {
  const [filePart, frag] = recipeRef.split("#");
  if (!filePart) throw new Error(`Invalid recipeRef: ${recipeRef}`);
  const rel = assertSafeRelPath(filePart.replace(/\\/g, "/"));
  const norm = rel.replace(/^\/+/, "");
  if (!/^recipes[\/\\]/.test(norm)) {
    throw new Error(`recipeRef must be under recipes/: ${recipeRef}`);
  }
  const abs = safeJoin(configRepoPath, norm);
  return { file: norm, target: frag, absPath: abs };
}

/** Vendored/local source.path must stay under configRepo/sources/. */
export function validateVendoredSourcePath(
  configRepoPath: string,
  sourcePath: string,
): string {
  if (path.isAbsolute(sourcePath)) {
    throw new Error(
      `vendored source path must be relative under sources/: ${sourcePath}`,
    );
  }
  const rel = assertSafeRelPath(sourcePath.replace(/\\/g, "/"));
  if (!/^sources[\/\\]/.test(rel)) {
    throw new Error(
      `vendored source path must be under sources/: ${sourcePath}`,
    );
  }
  return safeJoin(configRepoPath, rel);
}

/** sourcePaths / requiredPaths: relative only, no .. */
export function validateRecipeRelativePath(
  label: string,
  p: string | undefined,
): void {
  if (p === undefined || p === null || p === "") return;
  if (path.isAbsolute(p)) {
    throw new Error(`${label} must not be absolute: ${p}`);
  }
  assertSafeRelPath(p.replace(/\\/g, "/"));
}

export function validateTargetRecipePaths(recipe: TargetRecipe): void {
  if (recipe.sourcePaths) {
    for (const [k, v] of Object.entries(recipe.sourcePaths)) {
      if (typeof v === "string") {
        validateRecipeRelativePath(`sourcePaths.${k}`, v);
      }
    }
  }
  for (const req of recipe.requiredPaths ?? []) {
    validateRecipeRelativePath("requiredPaths", req);
  }
  for (const op of recipe.operations ?? []) {
    if (op.from) validateRecipeRelativePath("operation.from", op.from);
  }
}

/** Allowed write roots for a target tool under a given home. */
export function managedWriteRoots(home: string, target: TargetTool): string[] {
  if (target === "claude") {
    return [claudeSkillsDir(home), path.join(claudeHome(home), "skills")];
  }
  return [
    codexSkillsDir(home),
    agentsSkillsDir(home),
    codexHooksDir(home),
    path.dirname(codexHooksManifestPath(home)),
    path.dirname(codexConfigPath(home)),
  ];
}

/**
 * Ensure a destination path is under a managed root for the target.
 * Relative paths are expanded with ~ against home.
 */
export function validateManagedWritePath(
  home: string,
  target: TargetTool,
  dest: string,
): string {
  const expanded = expandHome(dest, home);
  const abs = path.resolve(expanded);
  const roots = managedWriteRoots(home, target).map((r) => path.resolve(r));
  const extras =
    target === "codex"
      ? [path.resolve(codexConfigPath(home)), path.resolve(codexHooksManifestPath(home))]
      : [];

  if (extras.includes(abs)) return abs;
  for (const root of roots) {
    if (abs === root || isUnder(root, abs)) return abs;
  }
  throw new Error(`Write path not in managed directories for ${target}: ${dest}`);
}

/** Reject if path is a symlink. */
export async function assertNotSymlink(p: string): Promise<void> {
  try {
    const st = await fs.lstat(p);
    if (st.isSymbolicLink()) {
      throw new Error(`Symlink rejected: ${p}`);
    }
  } catch (e) {
    if ((e as Error).message?.startsWith("Symlink rejected")) throw e;
    /* missing is ok */
  }
}

/** Walk a source tree and reject any symlink entries. */
export async function assertNoSymlinksInTree(
  root: string,
  options: { maxDepth?: number } = {},
): Promise<void> {
  const maxDepth = options.maxDepth ?? 12;
  async function walk(current: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Symlink rejected in source tree: ${full}`);
      }
      try {
        const st = await fs.lstat(full);
        if (st.isSymbolicLink()) {
          throw new Error(`Symlink rejected in source tree: ${full}`);
        }
      } catch (e) {
        if ((e as Error).message?.startsWith("Symlink rejected")) throw e;
      }
      if (entry.isDirectory()) await walk(full, depth + 1);
    }
  }
  await assertNotSymlink(root);
  await walk(root, 0);
}

function maxRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  const rank = (r: RiskLevel) => (r === "low" ? 1 : r === "medium" ? 2 : 3);
  return rank(a) >= rank(b) ? a : b;
}

/**
 * Recompute risk from operations + paths. Never trust recipe.risk alone.
 */
export function recomputeTargetRisk(recipe: TargetRecipe): RiskLevel {
  let risk: RiskLevel = "low";
  for (const op of recipe.operations ?? []) {
    switch (op.type) {
      case "run-cli":
      case "install-plugin":
      case "register-marketplace":
      case "manual":
      case "merge-toml":
      case "merge-json":
      case "merge-hook-manifest":
        risk = maxRisk(risk, "medium");
        break;
      case "copy-directory":
      case "copy-skill":
      case "copy-hook-scripts":
      case "enable-plugin":
      case "enable-feature":
        risk = maxRisk(risk, "low");
        break;
      default:
        risk = maxRisk(risk, "medium");
    }
    if (op.to && path.isAbsolute(op.to)) {
      risk = maxRisk(risk, "high");
    }
    if (op.command?.some((c) => /rm\s+-rf|format|del\s+\/s/i.test(c))) {
      risk = maxRisk(risk, "high");
    }
  }
  if (recipe.driver === "claude-marketplace" || recipe.driver === "npx-skills") {
    risk = maxRisk(risk, "medium");
  }
  if (recipe.driver === "manual") {
    risk = maxRisk(risk, "medium");
  }
  return risk;
}

/** Full validation of a target recipe before apply. */
export function validateTargetRecipeForApply(
  home: string,
  target: TargetTool,
  configRepoPath: string,
  recipe: TargetRecipe,
  options: { resourceSourcePath?: string } = {},
): { risk: RiskLevel } {
  validateTargetRecipePaths(recipe);
  if (options.resourceSourcePath) {
    const sp = options.resourceSourcePath.replace(/\\/g, "/");
    if (!path.isAbsolute(sp) && sp.startsWith("sources/")) {
      validateVendoredSourcePath(configRepoPath, options.resourceSourcePath);
    }
  }
  for (const op of recipe.operations ?? []) {
    if (op.to) {
      try {
        validateManagedWritePath(home, target, op.to);
      } catch {
        if (path.isAbsolute(op.to) || op.to.includes("..")) {
          throw new Error(`operation.to not managed: ${op.to}`);
        }
      }
    }
  }
  return { risk: recomputeTargetRisk(recipe) };
}
