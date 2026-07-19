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
  codexConfigPath,
  codexHooksDir,
  codexHooksManifestPath,
  agentsSkillsDir,
  codexHome,
  normalizePath,
} from "./paths.js";
import type { RiskLevel, TargetTool, TargetRecipe } from "./schemas.js";

export { assertSafeRelPath };

/** Basename patterns that must never be written (auth/session/cache). */
const FORBIDDEN_BASENAMES = new Set(
  [
    "auth.json",
    "credentials.json",
    "session.json",
    "sessions.json",
    "history.jsonl",
    "history.json",
    "cache",
    ".cache",
  ].map((s) => s.toLowerCase()),
);

const FORBIDDEN_PATH_FRAGMENTS = [
  "/auth.json",
  "\\auth.json",
  "/history.",
  "\\history.",
  "/session",
  "\\session",
  "/cache/",
  "\\cache\\",
  "/.cache/",
  "\\.cache\\",
];

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

function isForbiddenDest(abs: string): boolean {
  const base = path.basename(abs).toLowerCase();
  if (FORBIDDEN_BASENAMES.has(base)) return true;
  const norm = abs.replace(/\\/g, "/").toLowerCase();
  return FORBIDDEN_PATH_FRAGMENTS.some((f) =>
    norm.includes(f.replace(/\\/g, "/").toLowerCase()),
  );
}

/**
 * Ensure a destination path is under a managed root for the target.
 *
 * Claude: only ~/.claude/skills/**
 * Codex:
 *   - ~/.agents/skills/**
 *   - ~/.codex/skills/**
 *   - ~/.codex/hooks/**
 *   - exact ~/.codex/hooks.json
 *   - exact ~/.codex/config.toml
 * Does NOT allow arbitrary writes under ~/.codex (auth/history/session/cache blocked).
 */
export function validateManagedWritePath(
  home: string,
  target: TargetTool,
  dest: string,
): string {
  const expanded = expandHome(dest, home);
  const abs = path.resolve(expanded);

  if (isForbiddenDest(abs)) {
    throw new Error(
      `Write path forbidden (auth/session/cache/history): ${dest}`,
    );
  }

  if (target === "claude") {
    const skills = path.resolve(claudeSkillsDir(home));
    if (abs === skills || isUnder(skills, abs)) return abs;
    throw new Error(
      `Write path not in managed Claude skills dir: ${dest} (allowed: ${skills}/**)`,
    );
  }

  // Codex / agents
  const agentsSkills = path.resolve(agentsSkillsDir(home));
  const codexSkills = path.resolve(path.join(codexHome(home), "skills"));
  const hooksDir = path.resolve(codexHooksDir(home));
  const hooksJson = path.resolve(codexHooksManifestPath(home));
  const configToml = path.resolve(codexConfigPath(home));

  if (abs === hooksJson || abs === configToml) return abs;
  if (abs === agentsSkills || isUnder(agentsSkills, abs)) return abs;
  if (abs === codexSkills || isUnder(codexSkills, abs)) return abs;
  if (abs === hooksDir || isUnder(hooksDir, abs)) return abs;

  throw new Error(
    `Write path not in managed Codex directories: ${dest}. ` +
      `Allowed: ${agentsSkills}/**, ${codexSkills}/**, ${hooksDir}/**, ` +
      `exact ${hooksJson}, exact ${configToml}`,
  );
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

/**
 * Full validation of a target recipe before apply.
 * Any operation.to that fails managed-path checks blocks apply (no silent pass).
 */
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
    if (op.to !== undefined && op.to !== null && String(op.to).length > 0) {
      // Strict: every destination must pass managed write validation
      validateManagedWritePath(home, target, String(op.to));
    }
  }
  return { risk: recomputeTargetRisk(recipe) };
}

/** Compare risk levels for plan-vs-apply revalidation. */
export function riskRank(r: RiskLevel): number {
  return r === "low" ? 1 : r === "medium" ? 2 : 3;
}

/** Normalize paths for set comparison (platform-aware). */
export function normalizeRelPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.?\//, "");
}

// silence unused import if normalizePath only needed in some builds
void normalizePath;
