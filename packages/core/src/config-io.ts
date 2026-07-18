import path from "node:path";
import {
  ConfigRepoSchema,
  LocalConfigSchema,
  LockFileSchema,
  ProfileSchema,
  RecipeSchema,
  ResourcesFileSchema,
  StateFileSchema,
  type ConfigRepo,
  type LocalConfig,
  type LockFile,
  type Profile,
  type Recipe,
  type ResourcesFile,
  type StateFile,
} from "./schemas.js";
import {
  pathExists,
  readValidatedJson,
  readValidatedYaml,
  writeJsonFile,
  writeYamlFile,
} from "./fs.js";

export async function loadLocalConfig(filePath: string): Promise<LocalConfig> {
  return readValidatedYaml(filePath, LocalConfigSchema);
}

export async function saveLocalConfig(
  filePath: string,
  config: LocalConfig,
): Promise<void> {
  const parsed = LocalConfigSchema.parse(config);
  await writeYamlFile(filePath, parsed);
}

export async function loadConfigRepo(filePath: string): Promise<ConfigRepo> {
  return readValidatedYaml(filePath, ConfigRepoSchema);
}

export async function saveConfigRepo(
  filePath: string,
  config: ConfigRepo,
): Promise<void> {
  await writeYamlFile(filePath, ConfigRepoSchema.parse(config));
}

export async function loadResources(filePath: string): Promise<ResourcesFile> {
  if (!(await pathExists(filePath))) {
    return ResourcesFileSchema.parse({ resources: [] });
  }
  return readValidatedYaml(filePath, ResourcesFileSchema);
}

export async function saveResources(
  filePath: string,
  data: ResourcesFile,
): Promise<void> {
  await writeYamlFile(filePath, ResourcesFileSchema.parse(data));
}

export async function loadLock(filePath: string): Promise<LockFile> {
  if (!(await pathExists(filePath))) {
    return LockFileSchema.parse({ entries: [] });
  }
  return readValidatedYaml(filePath, LockFileSchema);
}

export async function saveLock(filePath: string, data: LockFile): Promise<void> {
  await writeYamlFile(filePath, LockFileSchema.parse(data));
}

export async function loadProfile(filePath: string): Promise<Profile> {
  return readValidatedYaml(filePath, ProfileSchema);
}

export async function loadRecipe(filePath: string): Promise<Recipe> {
  return readValidatedYaml(filePath, RecipeSchema);
}

export async function saveRecipe(filePath: string, data: Recipe): Promise<void> {
  await writeYamlFile(filePath, RecipeSchema.parse(data));
}

export async function loadState(filePath: string): Promise<StateFile> {
  if (!(await pathExists(filePath))) {
    return StateFileSchema.parse({});
  }
  return readValidatedJson(filePath, StateFileSchema);
}

export async function saveState(filePath: string, data: StateFile): Promise<void> {
  await writeJsonFile(filePath, StateFileSchema.parse(data));
}

/** Resolve a recipeRef like "recipes/foo.yaml#claude" */
export function parseRecipeRef(ref: string): {
  file: string;
  target?: string;
} {
  const [file, target] = ref.split("#");
  if (!file) throw new Error(`Invalid recipeRef: ${ref}`);
  return { file, target };
}

export function recipePath(configRepoRoot: string, rel: string): string {
  return path.join(configRepoRoot, rel);
}

/**
 * Resolve profile resource ids: start from include list (or all if empty include + base),
 * apply extends chain, then exclude.
 */
export function resolveProfileResources(
  profile: Profile,
  allResourceIds: string[],
  parentProfiles: Profile[] = [],
): string[] {
  const chain = [...parentProfiles, profile];
  let included = new Set<string>();
  let excluded = new Set<string>();

  for (const p of chain) {
    if (p.include.resources.length === 0 && p.profile === "base") {
      for (const id of allResourceIds) included.add(id);
    } else {
      for (const id of p.include.resources) included.add(id);
    }
    for (const id of p.exclude.resources) excluded.add(id);
  }

  // If final profile has empty include and is not base, inherit parents only;
  // if still empty, include all then exclude.
  if (included.size === 0) {
    for (const id of allResourceIds) included.add(id);
  }

  return [...included].filter((id) => !excluded.has(id));
}

export function isConfigRepository(rootFiles: string[]): boolean {
  const set = new Set(rootFiles.map((f) => f.toLowerCase()));
  return set.has("config.yaml") || set.has("resources.yaml");
}
