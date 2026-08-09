import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  ConfigRepoSchema,
  ensureDir,
  expandHome,
  isConfigRepository,
  loadLocalConfig,
  localConfigPath,
  pathExists,
  readJsonFile,
  readText,
  writeText,
  writeYamlFile,
  type LocalConfig,
} from "@ai-config-sync/core";
import { remotesMatch } from "@ai-config-sync/git-sync";
import { hasLocalConfig } from "@ai-config-sync/state-manager";
import type { SetupOptions } from "./setup-types.js";

const SELF_PLUGIN_NAMES = new Set(["ai-config-sync", "config-sync"]);

async function looksLikePackageRoot(dir: string): Promise<boolean> {
  return pathExists(
    path.join(
      dir,
      "integrations",
      "claude-plugin",
      ".claude-plugin",
      "plugin.json",
    ),
  );
}

async function readPluginManifestName(
  pluginRoot: string,
): Promise<string | undefined> {
  const manifest = path.join(pluginRoot, ".claude-plugin", "plugin.json");
  if (!(await pathExists(manifest))) return undefined;
  try {
    const raw = await readJsonFile<{ name?: string }>(manifest);
    return typeof raw.name === "string" ? raw.name : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Detect Claude Plugin root (installed plugin layout, not monorepo).
 * Recognizes CLAUDE_PLUGIN_ROOT/.claude-plugin/plugin.json and bin layout.
 */
export async function detectPluginRoot(
  explicit?: string,
): Promise<string | undefined> {
  const candidates: string[] = [];
  if (explicit) candidates.push(path.resolve(explicit));
  if (process.env.CLAUDE_PLUGIN_ROOT) {
    candidates.push(path.resolve(process.env.CLAUDE_PLUGIN_ROOT));
  }
  try {
    const argv1 = process.argv[1];
    if (argv1) {
      const binDir = path.dirname(path.resolve(argv1));
      // plugin/bin/ai-config-sync.cjs → plugin root
      candidates.push(path.resolve(binDir, ".."));
    }
  } catch {
    /* ignore */
  }

  for (const c of candidates) {
    if (!(await pathExists(c))) continue;
    const name = await readPluginManifestName(c);
    if (name && SELF_PLUGIN_NAMES.has(name)) return c;
    // Manifest present but name unknown — still treat as plugin root if bin exists
    if (
      (await pathExists(path.join(c, ".claude-plugin", "plugin.json"))) &&
      ((await pathExists(path.join(c, "bin", "ai-config-sync.cjs"))) ||
        (await pathExists(path.join(c, "bin", "ai-config-sync"))))
    ) {
      return c;
    }
  }
  return undefined;
}

/**
 * True when this process is already running as the Claude plugin itself.
 * Prefer plugin.json name over directory basename.
 */
export async function isRunningInsideSelfPlugin(
  pluginRoot?: string,
): Promise<boolean> {
  const root =
    pluginRoot ??
    (process.env.CLAUDE_PLUGIN_ROOT
      ? path.resolve(process.env.CLAUDE_PLUGIN_ROOT)
      : undefined);
  if (!root) return false;
  const name = await readPluginManifestName(root);
  if (name && SELF_PLUGIN_NAMES.has(name)) return true;
  // Fallback: plugin root with our bin + manifest
  if (
    (await pathExists(path.join(root, ".claude-plugin", "plugin.json"))) &&
    ((await pathExists(path.join(root, "bin", "ai-config-sync.cjs"))) ||
      (await pathExists(path.join(root, "bin", "ai-config-sync"))))
  ) {
    // Only claim self when name is known or env is set to this root
    if (name) return SELF_PLUGIN_NAMES.has(name);
    if (
      process.env.CLAUDE_PLUGIN_ROOT &&
      path.resolve(process.env.CLAUDE_PLUGIN_ROOT) === root
    ) {
      // Env points here — still check name if readable; if unreadable, be conservative
      return false;
    }
  }
  return false;
}

/**
 * Locate the monorepo / npm package root (contains integrations/claude-plugin).
 */
export async function detectPackageRoot(
  explicit?: string,
): Promise<string | undefined> {
  if (explicit && (await pathExists(explicit))) {
    const resolved = path.resolve(explicit);
    if (await looksLikePackageRoot(resolved)) return resolved;
    // allow explicit even if incomplete — caller decides
    return resolved;
  }

  // From monorepo checkout or npm package install, package root may be
  // parent of CLAUDE_PLUGIN_ROOT when plugin is nested under integrations/
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  if (pluginRoot) {
    const candidates = [
      path.resolve(pluginRoot, ".."),
      path.resolve(pluginRoot, "../.."),
      path.resolve(pluginRoot, "../../.."),
      pluginRoot,
    ];
    for (const c of candidates) {
      if (await looksLikePackageRoot(c)) return c;
    }
  }

  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [
      path.resolve(here, "../../.."), // monorepo packages/cli/src
      path.resolve(here, ".."), // npm package dist/
      path.resolve(here, "../.."),
    ];
    for (const c of candidates) {
      if (await looksLikePackageRoot(c)) return c;
    }
  } catch {
    /* ignore */
  }

  try {
    const argv1 = process.argv[1];
    if (argv1) {
      const binDir = path.dirname(path.resolve(argv1));
      const candidates = [
        path.resolve(binDir, ".."), // package root from dist/ai-config-sync.cjs
        path.resolve(binDir, "../.."),
        path.resolve(binDir, "../../.."),
        path.resolve(binDir, "../../../.."),
      ];
      for (const c of candidates) {
        if (await looksLikePackageRoot(c)) return c;
      }
    }
  } catch {
    /* ignore */
  }

  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    if (await looksLikePackageRoot(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/** @deprecated Use detectPackageRoot — kept for call sites during transition. */
async function detectProgramRoot(
  explicit?: string,
): Promise<string | undefined> {
  return detectPackageRoot(explicit);
}

export async function detectConfigRepo(
  options: SetupOptions,
  home: string,
): Promise<{
  localPath?: string;
  remote?: string;
  reason: string;
  /** Existing machine link, if any — checked before any clone/write. */
  existingLink?: LocalConfig;
  blocked?: string;
}> {
  let existingLink: LocalConfig | undefined;
  if (await hasLocalConfig(home)) {
    try {
      existingLink = await loadLocalConfig(localConfigPath(home));
    } catch {
      existingLink = undefined;
    }
  }

  // Explicit path wins only after comparing with existing link (unless reconfigure handled later)
  if (options.configPath) {
    const localPath = path.resolve(expandHome(options.configPath, home));
    return {
      localPath,
      remote: options.repo ?? existingLink?.configRepository.remote,
      reason: "cli --config-path",
      existingLink,
    };
  }

  // --repo without path: prefer already-linked path when remote matches
  if (options.repo && !options.configPath) {
    if (existingLink) {
      const sameRemote = remotesMatch(
        options.repo,
        existingLink.configRepository.remote,
      );
      if (sameRemote || !existingLink.configRepository.remote) {
        return {
          localPath: existingLink.configRepository.localPath,
          remote: options.repo,
          reason: "existing link matches --repo",
          existingLink,
        };
      }
      // Different remote already linked — do not pick a new default clone path yet
      return {
        reason: "existing link conflicts with --repo",
        existingLink,
        remote: options.repo,
        localPath: existingLink.configRepository.localPath,
        blocked:
          `Already linked to ${existingLink.configRepository.localPath}` +
          (existingLink.configRepository.remote
            ? ` (${existingLink.configRepository.remote})`
            : "") +
          `. Requested --repo ${options.repo}. Use --reconfigure to switch, or --config-path for a different directory.`,
      };
    }
    const defaultPath = path.join(home, "ai-config", "my-ai-config");
    return {
      localPath: defaultPath,
      remote: options.repo,
      reason: "cli --repo (new default path)",
      existingLink,
    };
  }

  if (existingLink) {
    return {
      localPath: existingLink.configRepository.localPath,
      remote: existingLink.configRepository.remote ?? options.repo,
      reason: "local config.yaml",
      existingLink,
    };
  }

  const envRepo = process.env.AI_CONFIG_SYNC_REPO;
  if (envRepo) {
    if (envRepo.includes("://") || envRepo.startsWith("git@")) {
      return {
        localPath: path.join(home, "ai-config", "my-ai-config"),
        remote: envRepo,
        reason: "AI_CONFIG_SYNC_REPO",
      };
    }
    return {
      localPath: path.resolve(expandHome(envRepo, home)),
      reason: "AI_CONFIG_SYNC_REPO path",
    };
  }

  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const files = await fs.readdir(dir).catch(() => [] as string[]);
    if (isConfigRepository(files)) {
      return { localPath: dir, reason: "cwd walk" };
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  const candidates = [
    path.join(home, "ai-config", "my-ai-config"),
    path.join(home, "Git", "my-ai-config"),
    path.join(home, "git", "my-ai-config"),
  ];
  for (const c of candidates) {
    if (!(await pathExists(c))) continue;
    const files = await fs.readdir(c).catch(() => [] as string[]);
    if (isConfigRepository(files)) {
      return { localPath: c, reason: "default directory" };
    }
  }

  return { reason: "not found", existingLink };
}

export async function ensureMinimalConfigRepo(localPath: string): Promise<string[]> {
  const actions: string[] = [];
  await ensureDir(localPath);
  const configYaml = path.join(localPath, "config.yaml");
  if (!(await pathExists(configYaml))) {
    await writeYamlFile(
      configYaml,
      ConfigRepoSchema.parse({
        name: path.basename(localPath),
        defaultProfile: "home",
      }),
    );
    actions.push(`CREATE ${configYaml}`);
  }
  const resources = path.join(localPath, "resources.yaml");
  if (!(await pathExists(resources))) {
    await writeYamlFile(resources, { schemaVersion: 1, resources: [] });
    actions.push(`CREATE ${resources}`);
  }
  for (const d of [
    "profiles",
    "recipes",
    "sources/skills",
    "sources/hooks",
    "sources/claude-plugins",
    "sources/integrations",
    "instructions/common",
    "instructions/claude",
    "instructions/codex",
  ]) {
    const full = path.join(localPath, d);
    if (!(await pathExists(full))) {
      await ensureDir(full);
      actions.push(`CREATE dir ${d}`);
    }
  }
  const baseProfile = path.join(localPath, "profiles", "base.yaml");
  if (!(await pathExists(baseProfile))) {
    await writeYamlFile(baseProfile, {
      profile: "base",
      include: { resources: [] },
      exclude: { resources: [] },
    });
    actions.push("CREATE profiles/base.yaml");
  }
  const homeProfile = path.join(localPath, "profiles", "home.yaml");
  if (!(await pathExists(homeProfile))) {
    await writeYamlFile(homeProfile, {
      profile: "home",
      extends: ["base"],
      include: { resources: [] },
      exclude: { resources: [] },
      security: {
        maxRisk: "medium",
        allowAutomaticLatest: false,
        secrets: { provider: "local-only" },
      },
    });
    actions.push("CREATE profiles/home.yaml");
  }
  const gitignore = path.join(localPath, ".gitignore");
  const requiredIgnore = [
    ".ai-config-sync-staging-*",
    ".ai-config-sync-backup-*",
  ];
  if (!(await pathExists(gitignore))) {
    await writeText(
      gitignore,
      [
        ".DS_Store",
        "*.env",
        "*.secret.*",
        "auth.json",
        "local.yaml",
        ".ai-config-sync/",
        ...requiredIgnore,
        "",
      ].join("\n"),
    );
    actions.push("CREATE .gitignore");
  } else {
    const existing = await readText(gitignore);
    const missing = requiredIgnore.filter((line) => !existing.includes(line));
    if (missing.length) {
      const next =
        existing.trimEnd() +
        "\n" +
        missing.join("\n") +
        "\n";
      await writeText(gitignore, next);
      actions.push("UPDATE .gitignore (capture transaction patterns)");
    }
  }
  return actions;
}
