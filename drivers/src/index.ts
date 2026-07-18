import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import {
  claudeSkillsDir,
  codexConfigPath,
  codexHooksDir,
  codexHooksManifestPath,
  codexSkillsDir,
  copyDirectory,
  ensureDir,
  expandHome,
  mergeJson,
  mergeTomlText,
  pathExists,
  readJsonFile,
  readText,
  writeJsonFile,
  writeText,
  type DriverName,
  type RecipeOperation,
  type RiskLevel,
  type TargetRecipe,
  type TargetTool,
} from "@ai-config-sync/core";

const execFileAsync = promisify(execFile);

export interface DriverContext {
  home: string;
  resourceId: string;
  target: TargetTool;
  /** Resolved source root (cloned/cache/vendored). */
  sourceRoot?: string;
  dryRun?: boolean;
  /** Allowlist for run-cli command prefixes. */
  commandAllowlist?: string[][];
}

export interface DriverResult {
  ok: boolean;
  skipped?: boolean;
  message: string;
  pathsTouched: string[];
  externalManual?: boolean;
}

export interface Driver {
  name: DriverName;
  plan(
    recipe: TargetRecipe,
    ctx: DriverContext,
  ): Promise<Array<{ description: string; risk: RiskLevel; paths: string[] }>>;
  apply(recipe: TargetRecipe, ctx: DriverContext): Promise<DriverResult>;
  verify?(recipe: TargetRecipe, ctx: DriverContext): Promise<DriverResult>;
}

function destSkillDir(target: TargetTool, resourceId: string, home: string): string {
  return target === "claude"
    ? path.join(claudeSkillsDir(home), resourceId)
    : path.join(codexSkillsDir(home), resourceId);
}

async function pathReady(p: string): Promise<boolean> {
  return pathExists(p);
}

// ---------------------------------------------------------------------------
// generic-skill
// ---------------------------------------------------------------------------

export const genericSkillDriver: Driver = {
  name: "generic-skill",
  async plan(recipe, ctx) {
    const fromRel = recipe.sourcePaths?.skill;
    const from = fromRel
      ? path.isAbsolute(fromRel)
        ? fromRel
        : ctx.sourceRoot
          ? path.join(ctx.sourceRoot, fromRel)
          : undefined
      : ctx.sourceRoot;
    const to = destSkillDir(ctx.target, ctx.resourceId, ctx.home);
    return [
      {
        description: `COPY ${ctx.target} skill: ${ctx.resourceId}`,
        risk: recipe.risk,
        paths: [to],
      },
    ];
  },
  async apply(recipe, ctx) {
    const fromRel = recipe.sourcePaths?.skill;
    const from = fromRel
      ? path.isAbsolute(fromRel)
        ? fromRel
        : path.join(ctx.sourceRoot ?? "", fromRel)
      : ctx.sourceRoot;
    if (!from || !(await pathReady(from))) {
      return {
        ok: false,
        message: `Source skill path missing: ${from ?? "(none)"}`,
        pathsTouched: [],
      };
    }
    // requiredPaths check
    for (const req of recipe.requiredPaths) {
      const p = path.isAbsolute(req)
        ? req
        : path.join(ctx.sourceRoot ?? from, req);
      if (!(await pathReady(p))) {
        return {
          ok: false,
          message: `requiredPath missing (recipe-stale): ${req}`,
          pathsTouched: [],
        };
      }
    }
    const to = destSkillDir(ctx.target, ctx.resourceId, ctx.home);
    if (ctx.dryRun) {
      return {
        ok: true,
        skipped: true,
        message: `dry-run copy ${from} -> ${to}`,
        pathsTouched: [to],
      };
    }
    await ensureDir(path.dirname(to));
    await copyDirectory(from, to, { overwrite: true });
    return {
      ok: true,
      message: `Installed skill ${ctx.resourceId} -> ${to}`,
      pathsTouched: [to],
    };
  },
  async verify(_recipe, ctx) {
    const to = destSkillDir(ctx.target, ctx.resourceId, ctx.home);
    const skillMd = path.join(to, "SKILL.md");
    const ok = (await pathReady(to)) && (await pathReady(skillMd));
    return {
      ok,
      message: ok
        ? `Skill present: ${to}`
        : `Skill missing or incomplete: ${to}`,
      pathsTouched: [to],
    };
  },
};

// ---------------------------------------------------------------------------
// repository-layout (Codex-oriented multi-op)
// ---------------------------------------------------------------------------

async function mergeHookManifest(
  destManifest: string,
  managedEntries: unknown,
): Promise<string[]> {
  let base: unknown = {};
  if (await pathReady(destManifest)) {
    base = await readJsonFile(destManifest);
  }
  // Normalize shapes
  const managedObj = Array.isArray(managedEntries)
    ? { hooks: managedEntries }
    : (managedEntries as Record<string, unknown>);

  const merged = mergeJson(base, managedObj, {
    // merge hooks array by id when possible
    preferManaged: true,
  });
  await ensureDir(path.dirname(destManifest));
  await writeJsonFile(destManifest, merged);
  return [destManifest];
}

export const repositoryLayoutDriver: Driver = {
  name: "repository-layout",
  async plan(recipe, ctx) {
    const items: Array<{
      description: string;
      risk: RiskLevel;
      paths: string[];
    }> = [];
    if (recipe.sourcePaths?.skill) {
      items.push({
        description: `COPY ${ctx.target} skill: ${ctx.resourceId}`,
        risk: recipe.risk,
        paths: [destSkillDir(ctx.target, ctx.resourceId, ctx.home)],
      });
    }
    if (recipe.sourcePaths?.hookManifest) {
      items.push({
        description: `MERGE ${ctx.target} hooks.json: managed entries`,
        risk: recipe.risk,
        paths: [codexHooksManifestPath(ctx.home)],
      });
    }
    if (recipe.sourcePaths?.hookScripts) {
      items.push({
        description: `COPY ${ctx.target} hook scripts: ${ctx.resourceId}`,
        risk: recipe.risk,
        paths: [codexHooksDir(ctx.home)],
      });
    }
    for (const op of recipe.operations) {
      if (op.type === "merge-toml") {
        items.push({
          description: `UPDATE ${ctx.target} config: ${op.path} = ${JSON.stringify(op.value)}`,
          risk: recipe.risk,
          paths: [codexConfigPath(ctx.home)],
        });
      }
    }
    if (items.length === 0) {
      items.push({
        description: `APPLY repository-layout for ${ctx.resourceId}`,
        risk: recipe.risk,
        paths: [],
      });
    }
    return items;
  },
  async apply(recipe, ctx) {
    const touched: string[] = [];
    if (!ctx.sourceRoot) {
      return {
        ok: false,
        message: "repository-layout requires sourceRoot",
        pathsTouched: [],
      };
    }
    for (const req of recipe.requiredPaths) {
      const p = path.join(ctx.sourceRoot, req);
      if (!(await pathReady(p))) {
        return {
          ok: false,
          message: `requiredPath missing (recipe-stale): ${req}`,
          pathsTouched: [],
        };
      }
    }

    if (ctx.dryRun) {
      return {
        ok: true,
        skipped: true,
        message: "dry-run repository-layout",
        pathsTouched: [],
      };
    }

    // skill
    if (recipe.sourcePaths?.skill) {
      const from = path.join(ctx.sourceRoot, recipe.sourcePaths.skill);
      const to = destSkillDir(ctx.target, ctx.resourceId, ctx.home);
      await ensureDir(path.dirname(to));
      await copyDirectory(from, to, { overwrite: true });
      touched.push(to);
    }

    // hooks scripts
    if (recipe.sourcePaths?.hookScripts) {
      const from = path.join(ctx.sourceRoot, recipe.sourcePaths.hookScripts);
      const to = path.join(codexHooksDir(ctx.home), ctx.resourceId);
      if (await pathReady(from)) {
        await copyDirectory(from, to, { overwrite: true });
        touched.push(to);
      }
    }

    // hook manifest merge
    if (recipe.sourcePaths?.hookManifest) {
      const from = path.join(ctx.sourceRoot, recipe.sourcePaths.hookManifest);
      if (await pathReady(from)) {
        const managed = await readJsonFile(from);
        const dest = codexHooksManifestPath(ctx.home);
        touched.push(...(await mergeHookManifest(dest, managed)));
      }
    }

    // operations — skip ones already handled via sourcePaths above
    for (const op of recipe.operations) {
      if (
        op.type === "copy-skill" ||
        op.type === "copy-hook-scripts" ||
        op.type === "merge-hook-manifest"
      ) {
        // Handled by sourcePaths.* blocks when present
        if (
          (op.type === "copy-skill" && recipe.sourcePaths?.skill) ||
          (op.type === "copy-hook-scripts" && recipe.sourcePaths?.hookScripts) ||
          (op.type === "merge-hook-manifest" && recipe.sourcePaths?.hookManifest)
        ) {
          continue;
        }
      }
      const r = await applyOperation(op, ctx, recipe);
      if (!r.ok) return { ...r, pathsTouched: [...touched, ...r.pathsTouched] };
      touched.push(...r.pathsTouched);
    }

    return {
      ok: true,
      message: `repository-layout applied for ${ctx.resourceId}`,
      pathsTouched: touched,
    };
  },
};

async function applyOperation(
  op: RecipeOperation,
  ctx: DriverContext,
  recipe: TargetRecipe,
): Promise<DriverResult> {
  switch (op.type) {
    case "merge-toml": {
      if (!op.path) {
        return { ok: false, message: "merge-toml requires path", pathsTouched: [] };
      }
      // path like features.hooks
      const parts = op.path.split(".");
      const key = parts.pop()!;
      const section = parts.join(".") || "features";
      const dest = codexConfigPath(ctx.home);
      let text = (await pathReady(dest)) ? await readText(dest) : "";
      text = mergeTomlText(text, [
        {
          section,
          key,
          value: op.value as string | number | boolean,
        },
      ]);
      if (!ctx.dryRun) {
        await ensureDir(path.dirname(dest));
        await writeText(dest, text);
      }
      return {
        ok: true,
        message: `merge-toml ${op.path}`,
        pathsTouched: [dest],
      };
    }
    case "merge-json": {
      const dest = op.to ? expandHome(op.to, ctx.home) : "";
      if (!dest) {
        return { ok: false, message: "merge-json requires to", pathsTouched: [] };
      }
      const base = (await pathReady(dest)) ? await readJsonFile(dest) : {};
      const managed = op.value ?? {};
      const merged = mergeJson(base, managed, { preferManaged: true });
      if (!ctx.dryRun) {
        await ensureDir(path.dirname(dest));
        await writeJsonFile(dest, merged);
      }
      return { ok: true, message: `merge-json ${dest}`, pathsTouched: [dest] };
    }
    case "copy-directory":
    case "copy-skill":
    case "copy-hook-scripts": {
      if (!op.from || !op.to) {
        return {
          ok: false,
          message: `${op.type} requires from/to`,
          pathsTouched: [],
        };
      }
      const from = path.isAbsolute(op.from)
        ? op.from
        : path.join(ctx.sourceRoot ?? "", op.from);
      const to = expandHome(op.to, ctx.home);
      if (!(await pathReady(from))) {
        return { ok: false, message: `source missing: ${from}`, pathsTouched: [] };
      }
      if (!ctx.dryRun) {
        await ensureDir(path.dirname(to));
        await copyDirectory(from, to, { overwrite: true });
      }
      return { ok: true, message: `${op.type} ${from} -> ${to}`, pathsTouched: [to] };
    }
    case "run-cli": {
      const cmd = op.command ?? [];
      if (cmd.length === 0) {
        return { ok: false, message: "run-cli empty command", pathsTouched: [] };
      }
      if (!isCommandAllowed(cmd, ctx.commandAllowlist, recipe.risk)) {
        return {
          ok: false,
          message: `run-cli blocked by allowlist: ${cmd.join(" ")}`,
          pathsTouched: [],
        };
      }
      if (ctx.dryRun) {
        return {
          ok: true,
          skipped: true,
          message: `dry-run: ${cmd.join(" ")}`,
          pathsTouched: [],
        };
      }
      try {
        const [bin, ...args] = cmd;
        await execFileAsync(bin!, args, {
          cwd: ctx.sourceRoot ?? ctx.home,
          windowsHide: true,
          maxBuffer: 5 * 1024 * 1024,
        });
        return {
          ok: true,
          message: `ran: ${cmd.join(" ")}`,
          pathsTouched: [],
        };
      } catch (e) {
        return {
          ok: false,
          message: `run-cli failed: ${(e as Error).message}`,
          pathsTouched: [],
        };
      }
    }
    case "manual":
      return {
        ok: true,
        message: op.args?.message
          ? String(op.args.message)
          : "Manual step required",
        pathsTouched: [],
        externalManual: true,
      };
    default:
      return {
        ok: true,
        skipped: true,
        message: `operation ${op.type} handled elsewhere or skipped`,
        pathsTouched: [],
      };
  }
}

function isCommandAllowed(
  cmd: string[],
  allowlist: string[][] | undefined,
  risk: RiskLevel,
): boolean {
  // Deny-by-default for free-form shell. Only exact safe prefixes.
  // Prefer dedicated drivers (install-plugin, npx-skills, generic-skill) over run-cli.
  const defaults = [
    ["claude", "plugin", "marketplace", "add"],
    ["claude", "plugin", "install"],
    ["claude", "plugin", "enable"],
    ["claude", "plugin", "disable"],
    ["claude", "plugin", "list"],
    ["npx", "skills", "add"],
    ["npx", "--yes", "skills", "add"],
    ["npx", "ai-config-sync"],
    ["npx", "--yes", "ai-config-sync"],
  ];
  const list = allowlist ?? defaults;
  const allowed = list.some(
    (prefix) =>
      prefix.length <= cmd.length && prefix.every((p, i) => cmd[i] === p),
  );
  // high risk never auto-allowed without explicit allowlist from caller
  if (risk === "high" && !allowlist) return false;
  // block dangerous git/node/npm free-form even if someone widens defaults by mistake
  const bin = cmd[0];
  if (bin === "git" || bin === "node" || bin === "npm" || bin === "npx") {
    if (bin === "npx") {
      // only skills / ai-config-sync as above
      return allowed;
    }
    return false;
  }
  return allowed;
}

// ---------------------------------------------------------------------------
// claude-marketplace
// ---------------------------------------------------------------------------

export const claudeMarketplaceDriver: Driver = {
  name: "claude-marketplace",
  async plan(recipe, ctx) {
    const items = [];
    if (recipe.marketplaceRepository || recipe.marketplace) {
      items.push({
        description: `CREATE Claude Marketplace: ${recipe.marketplace ?? recipe.marketplaceRepository}`,
        risk: recipe.risk,
        paths: [],
      });
    }
    items.push({
      description: `CREATE Claude Plugin: ${recipe.plugin ?? ctx.resourceId}${recipe.marketplace ? `@${recipe.marketplace}` : ""}`,
      risk: recipe.risk,
      paths: [],
    });
    items.push({
      description: `ENABLE Claude Plugin: ${recipe.plugin ?? ctx.resourceId}`,
      risk: "low" as RiskLevel,
      paths: [],
    });
    return items;
  },
  async apply(recipe, ctx) {
    const plugin = recipe.plugin ?? ctx.resourceId;
    const marketplace = recipe.marketplace;
    const scope = recipe.scope ?? "user";
    const pathsTouched: string[] = [];

    if (ctx.dryRun) {
      return {
        ok: true,
        skipped: true,
        message: `dry-run install plugin ${plugin}`,
        pathsTouched: [],
      };
    }

    const commands: string[][] = [];
    if (recipe.marketplaceRepository) {
      // github style: owner/repo
      commands.push([
        "claude",
        "plugin",
        "marketplace",
        "add",
        recipe.marketplaceRepository,
      ]);
    }
    if (marketplace && plugin) {
      commands.push([
        "claude",
        "plugin",
        "install",
        `${plugin}@${marketplace}`,
        "--scope",
        scope,
      ]);
      commands.push([
        "claude",
        "plugin",
        "enable",
        `${plugin}@${marketplace}`,
      ]);
    } else if (plugin) {
      commands.push([
        "claude",
        "plugin",
        "install",
        plugin,
        "--scope",
        scope,
      ]);
    }

    const messages: string[] = [];
    for (const cmd of commands) {
      try {
        const { execFile } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const execFileAsync = promisify(execFile);
        await execFileAsync(cmd[0]!, cmd.slice(1), {
          windowsHide: true,
          maxBuffer: 5 * 1024 * 1024,
        });
        messages.push(`ok: ${cmd.join(" ")}`);
      } catch (e) {
        const err = (e as Error).message;
        // treat already installed/enabled as ok
        if (/already installed|already enabled|already exists/i.test(err)) {
          messages.push(`ok(exists): ${cmd.join(" ")}`);
          continue;
        }
        messages.push(`fail: ${cmd.join(" ")} (${err})`);
        // ALL steps must succeed — fail the whole install
        return {
          ok: false,
          message: `Claude plugin install incomplete: ${messages.join("; ")}`,
          pathsTouched,
        };
      }
    }

    if (commands.length === 0) {
      return {
        ok: true,
        externalManual: true,
        message: `No install commands for plugin ${plugin}`,
        pathsTouched,
      };
    }

    return {
      ok: true,
      message: messages.join("; "),
      pathsTouched,
    };
  },
};

// ---------------------------------------------------------------------------
// npx-skills
// ---------------------------------------------------------------------------

export const npxSkillsDriver: Driver = {
  name: "npx-skills",
  async plan(recipe, ctx) {
    return [
      {
        description: `CREATE via npx skills --agent ${ctx.target}: ${ctx.resourceId}`,
        risk: recipe.risk,
        paths: [destSkillDir(ctx.target, ctx.resourceId, ctx.home)],
      },
    ];
  },
  async apply(recipe, ctx) {
    // Prefer full github repository source when available via recipe fields
    const pkgFromSource =
      (recipe as TargetRecipe & { packageName?: string }).packageName;
    const pkg =
      pkgFromSource ||
      recipe.marketplaceRepository ||
      recipe.sourcePaths?.skill ||
      ctx.resourceId;
    const cmd = [
      "npx",
      "--yes",
      "skills",
      "add",
      pkg,
      "--agent",
      ctx.target,
      "-y",
    ];
    if (ctx.dryRun) {
      return {
        ok: true,
        skipped: true,
        message: `dry-run: ${cmd.join(" ")}`,
        pathsTouched: [],
      };
    }
    try {
      await execFileAsync(cmd[0]!, cmd.slice(1), {
        windowsHide: true,
        maxBuffer: 10 * 1024 * 1024,
      });
      return {
        ok: true,
        message: `npx skills installed ${pkg}`,
        pathsTouched: [destSkillDir(ctx.target, ctx.resourceId, ctx.home)],
      };
    } catch (e) {
      return {
        ok: false,
        message: `npx skills failed: ${(e as Error).message}`,
        pathsTouched: [],
      };
    }
  },
};

// ---------------------------------------------------------------------------
// manual
// ---------------------------------------------------------------------------

export const manualDriver: Driver = {
  name: "manual",
  async plan(recipe, ctx) {
    return [
      {
        description: `MANUAL: ${ctx.resourceId} (${recipe.driver})`,
        risk: recipe.risk,
        paths: [],
      },
    ];
  },
  async apply(_recipe, ctx) {
    return {
      ok: true,
      externalManual: true,
      message: `Manual installation required for ${ctx.resourceId}`,
      pathsTouched: [],
    };
  },
};

const REGISTRY: Record<DriverName, Driver> = {
  "generic-skill": genericSkillDriver,
  "repository-layout": repositoryLayoutDriver,
  "claude-marketplace": claudeMarketplaceDriver,
  "npx-skills": npxSkillsDriver,
  manual: manualDriver,
};

export function getDriver(name: DriverName): Driver {
  const d = REGISTRY[name];
  if (!d) throw new Error(`Unknown driver: ${name}`);
  return d;
}

export function listDrivers(): DriverName[] {
  return Object.keys(REGISTRY) as DriverName[];
}

/** Check requiredPaths still exist under sourceRoot. */
export async function recipePathsValid(
  recipe: TargetRecipe,
  sourceRoot?: string,
): Promise<{ ok: boolean; missing: string[] }> {
  const missing: string[] = [];
  for (const req of recipe.requiredPaths) {
    const p =
      path.isAbsolute(req) || !sourceRoot
        ? expandHome(req)
        : path.join(sourceRoot, req);
    if (!(await pathExists(p))) missing.push(req);
  }
  return { ok: missing.length === 0, missing };
}
