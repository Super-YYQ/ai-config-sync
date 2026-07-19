import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { fileURLToPath } from "node:url";
import {
  ConfigRepoSchema,
  ensureDir,
  expandHome,
  isConfigRepository,
  loadLocalConfig,
  localConfigPath,
  mergeManagedCodexSessionStart,
  hasManagedCodexSessionStart,
  pathExists,
  readJsonFile,
  saveLocalConfig,
  writeJsonFile,
  writeText,
  writeYamlFile,
  mergeTomlText,
  getTomlValue,
  readText,
  agentsSkillsDir,
  codexConfigPath,
  codexHooksManifestPath,
  claudeExecutable,
  type LocalConfig,
} from "@ai-config-sync/core";
import {
  cloneRepo,
  getRemoteUrl,
  inspectGitSafety,
  isGitRepo,
  remotesMatch,
} from "@ai-config-sync/git-sync";
import {
  ensureStateDirs,
  hasLocalConfig,
  appendLog,
} from "@ai-config-sync/state-manager";

export type SetupMode = "default" | "plan" | "repair" | "reconfigure";

export interface SetupOptions {
  home?: string;
  configPath?: string;
  repo?: string;
  profile?: string;
  mode?: SetupMode;
  claude?: boolean;
  codex?: boolean;
  /** Absolute path to program repo (ai-config-sync). Auto-detected when possible. */
  programRoot?: string;
  /**
   * Explicit opt-in for offline/dev: copy integrations/claude-plugin into a
   * temporary directory marketplace via `claude plugin marketplace add <dir>`.
   * Never rewrites known_marketplaces.json / settings.json by hand.
   * Default false — production setup only uses official `claude plugin` CLI.
   */
  allowLocalPluginInstall?: boolean;
  /**
   * When true (or when CLAUDE_PLUGIN_ROOT is set and matches this install),
   * skip installing/enabling the Claude plugin — it is already running.
   */
  skipSelfPluginInstall?: boolean;
}

export type SetupStatus =
  | "initialized"
  | "linked"
  | "repaired"
  | "no-changes"
  | "planned"
  | "partial"
  | "failed";

export interface IntegrationInstallResult {
  ok: boolean;
  changed: boolean;
  warnings: string[];
  errors: string[];
  actions: string[];
}

export interface SetupResult {
  status: SetupStatus;
  messages: string[];
  localConfig?: LocalConfig;
  actions: string[];
}

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

async function detectConfigRepo(
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

async function ensureMinimalConfigRepo(localPath: string): Promise<string[]> {
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

/**
 * Install Claude Code plugin so user can use /ai-config-sync:* and skill in chat.
 *
 * Only uses official `claude plugin marketplace/install/enable` CLI.
 * Does NOT copy into ~/.claude/plugins/marketplaces or rewrite
 * known_marketplaces.json / settings.json (those are Claude-managed).
 *
 * Offline/dev: pass allowLocalPluginInstall to add a directory marketplace
 * via `claude plugin marketplace add <abs-path>` — still no hand-written state.
 */
async function installClaudePlugin(
  home: string,
  programRoot: string | undefined,
  options: {
    allowLocalPluginInstall?: boolean;
    skipSelfPluginInstall?: boolean;
    /** When true, never create ~/.claude/skills/config-sync fallback. */
    forbidSkillFallback?: boolean;
  } = {},
): Promise<IntegrationInstallResult> {
  const actions: string[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  let changed = false;

  const insideSelf =
    options.skipSelfPluginInstall || (await isRunningInsideSelfPlugin());
  if (insideSelf) {
    actions.push(
      "SKIP Claude plugin install (already running inside ai-config-sync plugin)",
    );
    return { ok: true, changed: false, warnings, errors, actions };
  }

  // Resolve plugin source: monorepo integrations/ or the plugin root itself
  let pluginSrc: string | undefined;
  if (programRoot) {
    const nested = path.join(programRoot, "integrations", "claude-plugin");
    if (
      await pathExists(path.join(nested, ".claude-plugin", "plugin.json"))
    ) {
      pluginSrc = nested;
    } else if (
      await pathExists(path.join(programRoot, ".claude-plugin", "plugin.json"))
    ) {
      pluginSrc = programRoot;
    }
  }
  if (!pluginSrc) {
    warnings.push(
      "Claude plugin source not found — skipped marketplace plugin install",
    );
    actions.push(
      "WARN Claude plugin source not found — skipped marketplace plugin install",
    );
    return { ok: true, changed: false, warnings, errors, actions };
  }

  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  const claudeBin = claudeExecutable();

  const runClaude = async (args: string[], timeout = 120000) => {
    await execFileAsync(claudeBin, args, {
      windowsHide: true,
      timeout,
      maxBuffer: 4 * 1024 * 1024,
    });
  };

  let claudeAvailable = true;
  try {
    await runClaude(["--version"], 15000);
  } catch {
    claudeAvailable = false;
  }

  if (!claudeAvailable) {
    const msg =
      "claude CLI not found — skipped marketplace plugin install. " +
      "Install Claude Code CLI, or install the plugin manually: " +
      "`claude plugin marketplace add Super-YYQ/ai-config-sync`.";
    warnings.push(msg);
    actions.push(`WARN ${msg}`);
    // Optional skill fallback only when not inside self plugin
    if (!options.forbidSkillFallback) {
      const skillSrc = path.join(pluginSrc, "skills", "config-sync");
      const skillDest = path.join(home, ".claude", "skills", "config-sync");
      const skillMd = path.join(skillDest, "SKILL.md");
      if ((await pathExists(skillSrc)) && !(await pathExists(skillMd))) {
        await ensureDir(path.dirname(skillDest));
        await fs.cp(skillSrc, skillDest, { recursive: true });
        actions.push(
          "INSTALL Claude user skill: config-sync (fallback, no claude CLI)",
        );
        changed = true;
      }
    }
    // Without claude CLI we cannot verify install — not a hard failure
    return { ok: true, changed, warnings, errors, actions };
  }

  // 1) Prefer GitHub marketplace registration
  let marketplaceReady = false;
  try {
    await runClaude([
      "plugin",
      "marketplace",
      "add",
      "Super-YYQ/ai-config-sync",
    ]);
    actions.push("claude plugin marketplace add Super-YYQ/ai-config-sync");
    marketplaceReady = true;
    changed = true;
  } catch (e) {
    const msg = (e as Error).message || String(e);
    if (/already|exists/i.test(msg)) {
      marketplaceReady = true;
      actions.push("claude marketplace already has ai-config-sync");
    } else if (options.allowLocalPluginInstall) {
      try {
        await runClaude(["plugin", "marketplace", "add", pluginSrc]);
        actions.push(
          `claude plugin marketplace add ${pluginSrc} (local/dev)`,
        );
        marketplaceReady = true;
        changed = true;
      } catch (e2) {
        const msg2 = (e2 as Error).message || String(e2);
        if (/already|exists/i.test(msg2)) {
          marketplaceReady = true;
          actions.push("claude local marketplace already registered");
        } else {
          const w = `claude marketplace add failed: ${msg2.slice(0, 200)}`;
          warnings.push(w);
          errors.push(w);
          actions.push(`WARN ${w}`);
        }
      }
    } else {
      const w =
        `claude marketplace add failed: ${msg.slice(0, 200)}. ` +
        "Pass --allow-local-plugin-install for offline/dev directory marketplace.";
      warnings.push(w);
      errors.push(w);
      actions.push(`WARN ${w}`);
    }
  }

  // 2) Install + enable via official CLI only
  let installOk = false;
  try {
    await runClaude(
      ["plugin", "install", "ai-config-sync@ai-config-sync", "--scope", "user"],
      60000,
    );
    actions.push("claude plugin install ai-config-sync@ai-config-sync");
    installOk = true;
    changed = true;
  } catch (e) {
    const msg = (e as Error).message || String(e);
    if (/already installed/i.test(msg)) {
      actions.push("claude plugin already installed");
      installOk = true;
    } else {
      const w = `claude plugin install: ${msg.slice(0, 200)}`;
      warnings.push(w);
      errors.push(w);
      actions.push(`WARN ${w}`);
    }
  }

  let enableOk = false;
  try {
    await runClaude(
      ["plugin", "enable", "ai-config-sync@ai-config-sync"],
      30000,
    );
    actions.push("claude plugin enable ai-config-sync@ai-config-sync");
    enableOk = true;
    changed = true;
  } catch (e) {
    const msg = (e as Error).message || String(e);
    if (/already enabled/i.test(msg)) {
      actions.push("claude plugin already enabled");
      enableOk = true;
    } else {
      const w =
        `claude plugin enable: ${msg.slice(0, 160)}. ` +
        "Run: claude plugin enable ai-config-sync@ai-config-sync";
      warnings.push(w);
      errors.push(w);
      actions.push(`WARN ${w}`);
    }
  }

  if (!marketplaceReady) {
    const note =
      "marketplace not registered; plugin install may be incomplete";
    warnings.push(note);
    actions.push(`NOTE: ${note}`);
  }

  // 3) Verify via claude plugin list --json when possible
  let verified = false;
  try {
    const listOut = await execFileAsync(
      claudeBin,
      ["plugin", "list", "--json"],
      {
        windowsHide: true,
        timeout: 30000,
        maxBuffer: 4 * 1024 * 1024,
        encoding: "utf8",
      },
    );
    const text = `${listOut.stdout ?? ""}`.trim();
    if (text) {
      const parsed = JSON.parse(text) as unknown;
      const list = Array.isArray(parsed)
        ? parsed
        : typeof parsed === "object" &&
            parsed !== null &&
            Array.isArray((parsed as { plugins?: unknown }).plugins)
          ? (parsed as { plugins: unknown[] }).plugins
          : typeof parsed === "object" &&
              parsed !== null &&
              Array.isArray((parsed as { installed?: unknown }).installed)
            ? (parsed as { installed: unknown[] }).installed
            : [];
      for (const item of list) {
        if (typeof item !== "object" || item === null) continue;
        const id = String(
          (item as { id?: string; name?: string }).id ??
            (item as { name?: string }).name ??
            "",
        ).toLowerCase();
        if (
          id === "ai-config-sync@ai-config-sync" ||
          id.startsWith("ai-config-sync@")
        ) {
          verified = true;
          const enabled = (item as { enabled?: boolean }).enabled;
          if (enabled === false) {
            enableOk = false;
            errors.push("plugin listed but not enabled");
          } else {
            installOk = true;
            enableOk = true;
          }
          break;
        }
      }
    }
  } catch {
    /* verification optional when list fails */
  }

  const ok =
    errors.length === 0 ||
    (installOk && enableOk) ||
    verified;

  if (!ok && errors.length === 0 && !installOk) {
    errors.push("Claude plugin install could not be confirmed");
  }

  return {
    ok: errors.length === 0 || (installOk && enableOk),
    changed,
    warnings,
    errors,
    actions,
  };
}

async function installCodexIntegration(
  home: string,
  programRoot?: string,
  pluginRoot?: string,
): Promise<IntegrationInstallResult> {
  const actions: string[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  let changed = false;

  // Prefer ~/.agents/skills (modern); still works if only legacy exists
  const skillDest = path.join(agentsSkillsDir(home), "config-sync");
  let skillSrc: string | undefined;
  if (programRoot) {
    const p = path.join(
      programRoot,
      "integrations",
      "codex",
      "skills",
      "config-sync",
    );
    if (await pathExists(p)) skillSrc = p;
  }
  // Plugin layout may only ship Claude skills; still allow template skill

  const skillMd = path.join(skillDest, "SKILL.md");
  if (!(await pathExists(skillMd))) {
    await ensureDir(skillDest);
    if (skillSrc) {
      await fs.cp(skillSrc, skillDest, { recursive: true });
    } else {
      await writeText(
        skillMd,
        `---
name: config-sync
description: 同步 AI Agent Skill/Plugin。用户说「同步配置」「扫描技能」「恢复环境」时使用。
---

# config-sync (Codex / agents)

运行本机 CLI（Plugin 内置 bin 或 npm 全局）：

- \`ai-config-sync status\`
- \`ai-config-sync scan\`
- \`ai-config-sync capture --yes\`
- \`ai-config-sync restore --yes --allow-risk medium\`
- \`ai-config-sync doctor\`

先 plan 再 apply。不要把密钥写进 git。
`,
      );
    }
    actions.push(`INSTALL agents skill: config-sync → ${skillDest}`);
    changed = true;
  }

  // Codex hooks.json — official event-map shape
  // Prefer absolute CLI path on Windows for commandWindows
  let cliAbsoluteCommand: string | undefined;
  try {
    if (pluginRoot) {
      const cjs = path.join(pluginRoot, "bin", "ai-config-sync.cjs");
      if (await pathExists(cjs)) {
        cliAbsoluteCommand = `"${process.execPath}" "${cjs}"`;
      }
    }
    if (programRoot) {
      const cjs = path.join(
        programRoot,
        "integrations",
        "claude-plugin",
        "bin",
        "ai-config-sync.cjs",
      );
      if (!cliAbsoluteCommand && (await pathExists(cjs))) {
        cliAbsoluteCommand = `"${process.execPath}" "${cjs}"`;
      }
      const distCjs = path.join(programRoot, "dist", "ai-config-sync.cjs");
      if (!cliAbsoluteCommand && (await pathExists(distCjs))) {
        cliAbsoluteCommand = `"${process.execPath}" "${distCjs}"`;
      }
    }
    if (!cliAbsoluteCommand) {
      const argv1 = process.argv[1];
      if (argv1 && (await pathExists(argv1))) {
        if (argv1.endsWith(".cjs") || argv1.endsWith(".js")) {
          cliAbsoluteCommand = `"${process.execPath}" "${path.resolve(argv1)}"`;
        } else {
          cliAbsoluteCommand = `"${path.resolve(argv1)}"`;
        }
      }
    }
  } catch {
    /* optional */
  }

  const hooksPath = codexHooksManifestPath(home);
  let base: unknown = {};
  if (await pathExists(hooksPath)) {
    try {
      base = await readJsonFile(hooksPath);
    } catch {
      await fs.copyFile(hooksPath, `${hooksPath}.bak-${Date.now()}`);
      base = {};
      actions.push(`BACKUP broken hooks.json → ${hooksPath}.bak-*`);
      changed = true;
    }
  }
  const { next, changed: hooksChanged } = mergeManagedCodexSessionStart(base, {
    cliAbsoluteCommand,
  });
  if (hooksChanged || !hasManagedCodexSessionStart(base)) {
    await ensureDir(path.dirname(hooksPath));
    await writeJsonFile(hooksPath, next);
    actions.push(
      cliAbsoluteCommand
        ? "MERGE Codex hooks.json SessionStart (event-map + commandWindows)"
        : "MERGE Codex hooks.json SessionStart (event-map format)",
    );
    changed = true;
  }

  // Ensure features.hooks = true
  const cfgPath = codexConfigPath(home);
  let toml = (await pathExists(cfgPath)) ? await readText(cfgPath) : "";
  if (getTomlValue(toml, "features", "hooks") !== true) {
    toml = mergeTomlText(toml, [
      { section: "features", key: "hooks", value: true },
    ]);
    await ensureDir(path.dirname(cfgPath));
    await writeText(cfgPath, toml);
    actions.push("UPDATE Codex config.toml: features.hooks = true");
    changed = true;
  }

  actions.push(
    "NOTE: Codex may prompt to trust the SessionStart hook on first run.",
  );

  return { ok: true, changed, warnings, errors, actions };
}

export async function runSetup(
  options: SetupOptions = {},
): Promise<SetupResult> {
  const home = options.home ?? os.homedir();
  const mode = options.mode ?? "default";
  const messages: string[] = [];
  const actions: string[] = [];

  await ensureStateDirs(home);

  const detected = await detectConfigRepo(options, home);
  messages.push(`Detection: ${detected.reason}`);

  if (detected.blocked && mode !== "reconfigure" && mode !== "plan") {
    return {
      status: "planned",
      messages: [...messages, detected.blocked],
      actions: [],
    };
  }

  if (detected.blocked && mode === "plan") {
    return {
      status: "planned",
      messages: [...messages, detected.blocked],
      actions: [],
    };
  }

  // Guard: existing link points elsewhere — stop before clone/skeleton
  if (
    detected.existingLink &&
    mode !== "reconfigure" &&
    options.configPath
  ) {
    const existingPath = path.resolve(
      detected.existingLink.configRepository.localPath,
    );
    const requested = path.resolve(expandHome(options.configPath, home));
    if (existingPath !== requested) {
      return {
        status: "planned",
        messages: [
          ...messages,
          `Already linked to ${existingPath}.`,
          `Requested --config-path ${requested}.`,
          "Use --reconfigure to switch, or omit --config-path to reuse the existing link.",
        ],
        actions: [],
      };
    }
  }

  if (!detected.localPath && !detected.remote) {
    return {
      status: "planned",
      messages: [
        ...messages,
        "No config repository found. Provide --config-path or --repo.",
        "",
        "快速开始：",
        "  1. 复制 examples/private-config-template 为你的私有仓库",
        "  2. ai-config-sync setup --config-path <路径> --profile home",
        "  3. 打开 Claude Code，说「扫描配置」或使用 /ai-config-sync:scan",
      ],
      actions: [],
    };
  }

  let localPath = detected.localPath!;
  let remote = detected.remote;

  if (!(await pathExists(localPath))) {
    if (!remote) {
      return {
        status: "planned",
        messages: [
          ...messages,
          `Path does not exist: ${localPath}. Provide --repo to clone.`,
        ],
        actions: [],
      };
    }
    if (mode === "plan") {
      actions.push(`CLONE ${remote} -> ${localPath}`);
    } else {
      // Only clone after all link conflicts resolved
      await cloneRepo(remote, localPath);
      actions.push(`CLONE ${remote} -> ${localPath}`);
      messages.push(`Cloned ${remote}`);
    }
  } else {
    if (await isGitRepo(localPath)) {
      const existingRemote = await getRemoteUrl(localPath);
      if (remote && existingRemote && !remotesMatch(remote, existingRemote)) {
        return {
          status: "planned",
          messages: [
            ...messages,
            `Refusing to proceed: directory ${localPath} has remote ${existingRemote}, expected ${remote}.`,
            "Choose a different path, or reconfigure explicitly.",
          ],
          actions: [],
        };
      }
      remote = remote ?? existingRemote;
      const safety = await inspectGitSafety(localPath);
      messages.push(...safety.messages);
    } else if (remote && mode !== "plan") {
      messages.push(
        `Directory exists but is not a git repo; linking as local path without clone.`,
      );
    }
  }

  if (mode === "plan") {
    actions.push(`LINK ~/.ai-config-sync -> ${localPath}`);
    actions.push(`PROFILE ${options.profile ?? "home"}`);
    actions.push("INSTALL Claude plugin ai-config-sync (skill + slash commands)");
    actions.push("INSTALL Codex skill config-sync");
    return { status: "planned", messages, actions };
  }

  actions.push(...(await ensureMinimalConfigRepo(localPath)));

  const profile = options.profile ?? "home";
  const localConfig: LocalConfig = {
    schemaVersion: 1,
    configRepository: {
      remote,
      localPath,
    },
    profile,
    targets: {
      claude: options.claude ?? true,
      codex: options.codex ?? true,
    },
    ai: { enabled: false, mode: "off" },
  };

  const cfgPath = localConfigPath(home);
  let status: SetupResult["status"] = "initialized";

  if ((await pathExists(cfgPath)) && mode !== "reconfigure") {
    try {
      const prev = await loadLocalConfig(cfgPath);
      const samePath =
        path.resolve(prev.configRepository.localPath) ===
        path.resolve(localPath);
      const sameProfile = prev.profile === profile;
      if (samePath && sameProfile && mode === "default") {
        status = "no-changes";
      } else if (!samePath && mode !== "repair") {
        messages.push(
          `Existing link points to ${prev.configRepository.localPath}. Use --reconfigure to switch.`,
        );
        if (mode === "default") status = "repaired";
      }
    } catch {
      /* rewrite */
    }
  }

  if (
    mode === "reconfigure" ||
    !(await pathExists(cfgPath)) ||
    status !== "no-changes"
  ) {
    let shouldWrite = true;
    if ((await pathExists(cfgPath)) && mode !== "reconfigure") {
      try {
        const prev = await loadLocalConfig(cfgPath);
        if (
          path.resolve(prev.configRepository.localPath) ===
            path.resolve(localPath) &&
          prev.profile === profile
        ) {
          shouldWrite = false;
        }
      } catch {
        shouldWrite = true;
      }
    }
    if (shouldWrite) {
      await saveLocalConfig(cfgPath, localConfig);
      actions.push(`WRITE ${cfgPath}`);
      status = status === "no-changes" ? "linked" : status;
      if (status === "initialized" && (await pathExists(cfgPath))) {
        status = "linked";
      }
    }
  }

  const packageRoot = await detectPackageRoot(options.programRoot);
  const pluginRoot = await detectPluginRoot();
  const insideSelf =
    !!options.skipSelfPluginInstall ||
    (await isRunningInsideSelfPlugin(pluginRoot));

  if (packageRoot) {
    messages.push(`Package root: ${packageRoot}`);
  }
  if (pluginRoot) {
    messages.push(`Plugin root: ${pluginRoot}`);
  }
  if (insideSelf) {
    messages.push("Running inside ai-config-sync Claude plugin — skip self install");
  }
  if (!packageRoot && !pluginRoot) {
    messages.push(
      "Package/plugin root not found — Claude plugin files may be incomplete. Run setup from ai-config-sync repo, plugin session, or pass --program-root.",
    );
  }

  // programRoot for integrations: prefer package (has integrations/), else plugin root
  const programRoot = packageRoot ?? pluginRoot;

  let integrationFailed = false;

  // Integrations
  if (localConfig.targets.claude) {
    if (programRoot || insideSelf) {
      const pluginResult = await installClaudePlugin(home, programRoot, {
        allowLocalPluginInstall: !!options.allowLocalPluginInstall,
        skipSelfPluginInstall: insideSelf,
        forbidSkillFallback: insideSelf,
      });
      if (pluginResult.actions.length) {
        actions.push(...pluginResult.actions);
        if (pluginResult.changed && status === "no-changes") status = "repaired";
      }
      if (!pluginResult.ok) {
        integrationFailed = true;
        messages.push(
          ...pluginResult.errors.map((e) => `Claude integration error: ${e}`),
        );
      }
    } else if (!insideSelf) {
      // Minimal skill fallback only when not inside self plugin and no roots
      const skillDir = path.join(home, ".claude", "skills", "config-sync");
      const skillMd = path.join(skillDir, "SKILL.md");
      if (!(await pathExists(skillMd))) {
        await ensureDir(skillDir);
        await writeText(
          skillMd,
          `---
name: config-sync
description: 同步 AI Agent 配置。用户说「同步配置」「扫描技能」时使用。
user-invocable: true
---

# config-sync

运行 \`ai-config-sync status|scan|capture|restore|doctor\`。
`,
        );
        actions.push("INSTALL Claude skill: config-sync (fallback)");
        if (status === "no-changes") status = "repaired";
      }
    }
  }

  if (localConfig.targets.codex) {
    const codexResult = await installCodexIntegration(
      home,
      packageRoot,
      pluginRoot,
    );
    if (codexResult.actions.length) {
      actions.push(...codexResult.actions);
      if (codexResult.changed && status === "no-changes") status = "repaired";
    }
    if (!codexResult.ok) {
      integrationFailed = true;
      messages.push(
        ...codexResult.errors.map((e) => `Codex integration error: ${e}`),
      );
    }
  }

  if (integrationFailed) {
    status = "partial";
  }

  if (actions.length === 0) {
    status = "no-changes";
    messages.push("No changes");
  } else {
    messages.push("");
    messages.push("接下来在 Claude Code 里可以：");
    messages.push("  · 输入 /ai-config-sync:scan   扫描本机技能");
    messages.push("  · 输入 /ai-config-sync:capture 把新技能写入私有仓库");
    messages.push("  · 或直接说：「帮我扫描配置」「同步配置到仓库」");
    messages.push("  · 新开会话后 SessionStart 会轻量提示未纳管资源");
  }

  await appendLog(`setup status=${status} path=${localPath}`, home);

  return {
    status,
    messages,
    localConfig: await loadLocalConfig(cfgPath).catch(() => localConfig),
    actions,
  };
}
