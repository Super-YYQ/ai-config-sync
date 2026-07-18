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
  mergeJson,
  pathExists,
  readJsonFile,
  saveLocalConfig,
  writeJsonFile,
  writeText,
  writeYamlFile,
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
}

export interface SetupResult {
  status: "initialized" | "linked" | "repaired" | "no-changes" | "planned";
  messages: string[];
  localConfig?: LocalConfig;
  actions: string[];
}

function packageRootFromHere(): string | undefined {
  try {
    // packages/cli/src -> packages/cli -> packages -> repo root
    const here = path.dirname(fileURLToPath(import.meta.url));
    const root = path.resolve(here, "../../..");
    return root;
  } catch {
    return undefined;
  }
}

async function detectProgramRoot(
  explicit?: string,
): Promise<string | undefined> {
  if (explicit && (await pathExists(explicit))) return path.resolve(explicit);
  const fromModule = packageRootFromHere();
  if (
    fromModule &&
    (await pathExists(
      path.join(fromModule, "integrations", "claude-plugin", ".claude-plugin"),
    ))
  ) {
    return fromModule;
  }
  // cwd walk
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    if (
      await pathExists(
        path.join(dir, "integrations", "claude-plugin", ".claude-plugin"),
      )
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

async function detectConfigRepo(
  options: SetupOptions,
  home: string,
): Promise<{ localPath?: string; remote?: string; reason: string }> {
  if (options.configPath) {
    return {
      localPath: path.resolve(expandHome(options.configPath, home)),
      remote: options.repo,
      reason: "cli --config-path",
    };
  }
  if (options.repo && !options.configPath) {
    const defaultPath = path.join(home, "ai-config", "yyq-ai-config");
    return {
      localPath: defaultPath,
      remote: options.repo,
      reason: "cli --repo",
    };
  }

  if (await hasLocalConfig(home)) {
    try {
      const cfg = await loadLocalConfig(localConfigPath(home));
      return {
        localPath: cfg.configRepository.localPath,
        remote: cfg.configRepository.remote ?? options.repo,
        reason: "local config.yaml",
      };
    } catch {
      /* fallthrough */
    }
  }

  const envRepo = process.env.AI_CONFIG_SYNC_REPO;
  if (envRepo) {
    if (envRepo.includes("://") || envRepo.startsWith("git@")) {
      return {
        localPath: path.join(home, "ai-config", "yyq-ai-config"),
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
    path.join(home, "ai-config", "yyq-ai-config"),
    path.join(home, "Git", "yyq-ai-config"),
    path.join(home, "git", "yyq-ai-config"),
  ];
  for (const c of candidates) {
    if (!(await pathExists(c))) continue;
    const files = await fs.readdir(c).catch(() => [] as string[]);
    if (isConfigRepository(files)) {
      return { localPath: c, reason: "default directory" };
    }
  }

  return { reason: "not found" };
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
        "",
      ].join("\n"),
    );
    actions.push("CREATE .gitignore");
  }
  return actions;
}

/**
 * Install Claude Code plugin so user can use /ai-config-sync:* and skill in chat.
 * Prefer official `claude plugin` CLI; fall back to marketplace files + enable.
 */
async function installClaudePlugin(
  home: string,
  programRoot: string,
): Promise<string[]> {
  const actions: string[] = [];
  const pluginSrc = path.join(programRoot, "integrations", "claude-plugin");
  if (!(await pathExists(path.join(pluginSrc, ".claude-plugin", "plugin.json")))) {
    return actions;
  }

  const marketplacesDir = path.join(home, ".claude", "plugins", "marketplaces");
  const dest = path.join(marketplacesDir, "ai-config-sync");
  await ensureDir(marketplacesDir);

  const destPluginJson = path.join(dest, ".claude-plugin", "plugin.json");
  let needCopy = true;
  if (await pathExists(destPluginJson)) {
    try {
      const a = await readJsonFile<{ version?: string }>(
        path.join(pluginSrc, ".claude-plugin", "plugin.json"),
      );
      const b = await readJsonFile<{ version?: string }>(destPluginJson);
      if (a.version && a.version === b.version) needCopy = false;
    } catch {
      needCopy = true;
    }
  }
  if (needCopy) {
    await fs.rm(dest, { recursive: true, force: true });
    await fs.cp(pluginSrc, dest, { recursive: true });
    actions.push(`INSTALL Claude marketplace copy → ${dest}`);
  }

  // known_marketplaces.json (Claude also maintains this)
  const knownPath = path.join(
    home,
    ".claude",
    "plugins",
    "known_marketplaces.json",
  );
  let known: Record<string, unknown> = {};
  if (await pathExists(knownPath)) {
    try {
      known = await readJsonFile(knownPath);
    } catch {
      known = {};
    }
  }
  const prevKnown = known["ai-config-sync"] as
    | { installLocation?: string }
    | undefined;
  if (!prevKnown || prevKnown.installLocation !== dest || needCopy) {
    known["ai-config-sync"] = {
      source: {
        source: "directory",
        path: dest,
      },
      installLocation: dest,
      lastUpdated: new Date().toISOString(),
    };
    await writeJsonFile(knownPath, known);
    actions.push("UPDATE known_marketplaces.json: ai-config-sync");
  }

  // Official CLI: install + enable (creates cache entry that powers slash commands)
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  const claudeBin = process.platform === "win32" ? "claude.cmd" : "claude";

  try {
    await execFileAsync(
      claudeBin,
      ["plugin", "install", "ai-config-sync@ai-config-sync", "--scope", "user"],
      { windowsHide: true, timeout: 60000, maxBuffer: 2 * 1024 * 1024 },
    );
    actions.push("claude plugin install ai-config-sync@ai-config-sync");
  } catch (e) {
    const msg = (e as Error).message || String(e);
    if (/already installed/i.test(msg)) {
      actions.push("claude plugin already installed");
    } else {
      messagesPushSafe(actions, `WARN claude plugin install: ${msg.slice(0, 200)}`);
    }
  }

  try {
    await execFileAsync(
      claudeBin,
      ["plugin", "enable", "ai-config-sync@ai-config-sync"],
      { windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 },
    );
    actions.push("claude plugin enable ai-config-sync@ai-config-sync");
  } catch (e) {
    const msg = (e as Error).message || String(e);
    if (/already enabled/i.test(msg)) {
      actions.push("claude plugin already enabled");
    } else {
      // Fallback: write enabledPlugins in settings.json
      const settingsPath = path.join(home, ".claude", "settings.json");
      let settings: Record<string, unknown> = {};
      if (await pathExists(settingsPath)) {
        try {
          settings = await readJsonFile(settingsPath);
        } catch {
          settings = {};
        }
      }
      const enabled =
        (settings.enabledPlugins as Record<string, unknown> | undefined) ?? {};
      if (enabled["ai-config-sync@ai-config-sync"] !== true) {
        enabled["ai-config-sync@ai-config-sync"] = true;
        settings.enabledPlugins = enabled;
        await writeJsonFile(settingsPath, settings);
        actions.push(
          "ENABLE via settings.json: ai-config-sync@ai-config-sync (claude enable failed)",
        );
      }
      messagesPushSafe(actions, `WARN claude plugin enable: ${msg.slice(0, 160)}`);
    }
  }

  // User-level skill backup (works even if plugin slash cmds lag)
  const skillSrc = path.join(pluginSrc, "skills", "config-sync");
  const skillDest = path.join(home, ".claude", "skills", "config-sync");
  const skillMd = path.join(skillDest, "SKILL.md");
  if (await pathExists(skillSrc)) {
    if (!(await pathExists(skillMd)) || needCopy) {
      await ensureDir(path.dirname(skillDest));
      await fs.rm(skillDest, { recursive: true, force: true });
      await fs.cp(skillSrc, skillDest, { recursive: true });
      actions.push("INSTALL Claude user skill: config-sync");
    }
  }

  return actions;
}

function messagesPushSafe(actions: string[], line: string) {
  actions.push(line);
}

async function installCodexIntegration(
  home: string,
  programRoot?: string,
): Promise<string[]> {
  const actions: string[] = [];
  const skillDest = path.join(home, ".codex", "skills", "config-sync");
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

# config-sync (Codex)

运行本机 CLI：

- \`ai-config-sync status\`
- \`ai-config-sync scan\`
- \`ai-config-sync capture --yes\`
- \`ai-config-sync restore --yes --allow-risk medium\`
- \`ai-config-sync doctor\`

先 plan 再 apply。不要把密钥写进 git。
`,
      );
    }
    actions.push("INSTALL Codex skill: config-sync");
  }

  // Merge SessionStart hook into ~/.codex/hooks.json if present or create
  const hooksPath = path.join(home, ".codex", "hooks.json");
  const managedHook = {
    hooks: [
      {
        id: "ai-config-sync-session-start",
        event: "SessionStart",
        command: "ai-config-sync scan --light --write-pending",
        timeout_ms: 20000,
      },
    ],
  };
  let base: unknown = { hooks: [] };
  let hadManaged = false;
  if (await pathExists(hooksPath)) {
    try {
      base = await readJsonFile(hooksPath);
      const hooks = (base as { hooks?: Array<{ id?: string }> }).hooks;
      hadManaged = !!hooks?.some((h) => h.id === "ai-config-sync-session-start");
    } catch {
      base = { hooks: [] };
    }
  }
  if (!hadManaged) {
    const merged = mergeJson(base, managedHook, { preferManaged: true });
    await ensureDir(path.dirname(hooksPath));
    await writeJsonFile(hooksPath, merged);
    actions.push("MERGE Codex hooks.json: ai-config-sync-session-start");
  }

  return actions;
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

  if (!detected.localPath && !detected.remote) {
    return {
      status: "planned",
      messages: [
        ...messages,
        "No config repository found. Provide --config-path or --repo.",
        "",
        "快速开始：",
        "  1. 复制 examples/yyq-ai-config-template 为你的私有仓库",
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

  const programRoot = await detectProgramRoot(options.programRoot);
  if (programRoot) {
    messages.push(`Program root: ${programRoot}`);
  } else {
    messages.push(
      "Program root not found — Claude plugin files may be incomplete. Run setup from ai-config-sync repo or pass --program-root.",
    );
  }

  // Integrations
  if (localConfig.targets.claude) {
    if (programRoot) {
      const pluginActions = await installClaudePlugin(home, programRoot);
      if (pluginActions.length) {
        actions.push(...pluginActions);
        if (status === "no-changes") status = "repaired";
      }
    } else {
      // Minimal skill fallback without plugin
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
    const codexActions = await installCodexIntegration(home, programRoot);
    if (codexActions.length) {
      actions.push(...codexActions);
      if (status === "no-changes") status = "repaired";
    }
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
