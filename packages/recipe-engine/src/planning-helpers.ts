import path from "node:path";
import {
  assertNoSymlinksInTree,
  loadLock,
  loadProfile,
  loadRecipe,
  pathExists,
  safeJoin,
  validateRecipeRef,
  validateVendoredSourcePath,
  vendorSkillRelPath,
  type Profile,
  type Recipe,
  type Resource,
  type TargetTool,
} from "@ai-config-sync/core";
import { resolveCachedSource } from "@ai-config-sync/git-sync";
import type { EngineContext } from "./engine-types.js";

export const MISSING_INPUT = "missing:";
export const FILE_INPUT = "file:";
export const DIRECTORY_INPUT = "dir:";

export async function resolveSourceRoot(
  ctx: EngineContext,
  resource: Resource,
): Promise<string | undefined> {
  if (ctx.sourceRoots?.[resource.id]) return ctx.sourceRoots[resource.id];

  // Relative path inside private config repo (vendored / local)
  if (resource.source?.path) {
    if (path.isAbsolute(resource.source.path)) {
      throw new Error(
        `Absolute source.path rejected for ${resource.id}: ${resource.source.path}`,
      );
    }
    // Vendored sources must live under sources/
    const provider = resource.source.provider;
    if (provider === "vendored" || provider === "local") {
      const abs = validateVendoredSourcePath(
        ctx.configRepoPath,
        resource.source.path,
      );
      if (await pathExists(abs)) {
        await assertNoSymlinksInTree(abs);
        return abs;
      }
      return undefined;
    }
    // Other relative paths still join under config repo with safeJoin semantics
    const p = safeJoin(ctx.configRepoPath, resource.source.path);
    if (await pathExists(p)) {
      await assertNoSymlinksInTree(p);
      return p;
    }
  }

  // Storage-key based vendored path
  const vendoredKey = path.join(
    ctx.configRepoPath,
    vendorSkillRelPath(resource.id),
  );
  if (await pathExists(vendoredKey)) {
    await assertNoSymlinksInTree(vendoredKey);
    return vendoredKey;
  }

  // Legacy flat sources/skills/<id>
  const vendored = path.join(
    ctx.configRepoPath,
    "sources",
    "skills",
    resource.id,
  );
  if (await pathExists(vendored)) {
    await assertNoSymlinksInTree(vendored);
    return vendored;
  }

  // GitHub / git cache — symlink rejection is hard fail (no silent catch)
  try {
    const lock = await loadLock(path.join(ctx.configRepoPath, "lock.yaml"));
    const locked = lock.entries.find((e) => e.resourceId === resource.id);
    const cached = await resolveCachedSource(resource.source, {
      home: ctx.home,
      ref: locked?.commit ?? resource.source?.commit,
      update: !!ctx.updateSources,
      offline: !!ctx.offline,
    });
    if (cached?.root) {
      // Propagate symlink errors — do not swallow
      await assertNoSymlinksInTree(cached.root);
    }
    return cached?.root;
  } catch (e) {
    if ((e as Error).message?.startsWith("Symlink rejected")) {
      throw e;
    }
    return undefined;
  }
}

export async function loadResolvedProfile(
  configRepoPath: string,
  profileName: string,
): Promise<{ profile: Profile; parents: Profile[]; files: string[] }> {
  const validateName = (name: string) => {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name) || name.includes("..")) {
      throw new Error(`Invalid profile name: ${name}`);
    }
    return name;
  };
  validateName(profileName);
  const profilePath = safeJoin(configRepoPath, "profiles", `${profileName}.yaml`);
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
      files: [profilePath],
    };
  }
  const profile = await loadProfile(profilePath);
  if (profile.profile !== profileName) {
    throw new Error(
      `Profile identity mismatch: ${profilePath} declares ${profile.profile}, expected ${profileName}`,
    );
  }
  const parents: Profile[] = [];
  const files: string[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>([profileName]);
  const visit = async (name: string): Promise<void> => {
    validateName(name);
    if (visiting.has(name)) {
      throw new Error(`Profile inheritance cycle: ${[...visiting, name].join(" -> ")}`);
    }
    if (visited.has(name)) return;
    visiting.add(name);
    const p = safeJoin(configRepoPath, "profiles", `${name}.yaml`);
    if (!(await pathExists(p))) {
      throw new Error(`Extended profile not found: ${name} (${p})`);
    }
    const parent = await loadProfile(p);
    if (parent.profile !== name) {
      throw new Error(
        `Profile identity mismatch: ${p} declares ${parent.profile}, expected ${name}`,
      );
    }
    for (const ext of parent.extends) await visit(ext);
    visiting.delete(name);
    visited.add(name);
    parents.push(parent);
    files.push(p);
  };
  for (const ext of profile.extends) {
    await visit(ext);
  }
  files.push(profilePath);
  return { profile, parents, files };
}

export async function resolveRecipe(
  configRepoPath: string,
  resource: Resource,
  target: TargetTool,
  registry: Map<string, Recipe>,
): Promise<{ recipe: Recipe; absPath?: string } | undefined> {
  const targetCfg = resource.targets[target];
  if (!targetCfg?.enabled) return undefined;

  if (targetCfg.recipeRef) {
    // Central path security: recipeRef must stay under recipes/
    const { absPath, file } = validateRecipeRef(
      configRepoPath,
      targetCfg.recipeRef,
    );
    if (await pathExists(absPath)) {
      const recipe = await loadRecipe(absPath);
      return { recipe, absPath };
    }
    // try registry by basename (storage key)
    const base = path.basename(file, path.extname(file));
    const fromReg = registry.get(base) ?? registry.get(resource.id);
    if (fromReg) return { recipe: fromReg };
    return undefined;
  }

  const fromReg = registry.get(resource.id);
  return fromReg ? { recipe: fromReg } : undefined;
}
