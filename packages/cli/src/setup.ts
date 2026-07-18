import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import {
  ConfigRepoSchema,
  ensureDir,
  expandHome,
  isConfigRepository,
  loadLocalConfig,
  localConfigPath,
  pathExists,
  saveLocalConfig,
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
}

export interface SetupResult {
  status: "initialized" | "linked" | "repaired" | "no-changes" | "planned";
  messages: string[];
  localConfig?: LocalConfig;
  actions: string[];
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
    // default clone location
    const defaultPath = path.join(home, "ai-config", "yyq-ai-config");
    return {
      localPath: defaultPath,
      remote: options.repo,
      reason: "cli --repo",
    };
  }

  // existing local config
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

  // env
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

  // walk parents for config.yaml / resources.yaml
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

  // limited default dirs
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
  // base/home profiles
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

async function installIntegrationStubs(
  home: string,
  targets: { claude: boolean; codex: boolean },
): Promise<string[]> {
  const actions: string[] = [];
  // Claude: drop a skill entry that points at CLI
  if (targets.claude) {
    const skillDir = path.join(home, ".claude", "skills", "config-sync");
    const skillMd = path.join(skillDir, "SKILL.md");
    if (!(await pathExists(skillMd))) {
      await ensureDir(skillDir);
      await writeText(
        skillMd,
        `---
name: config-sync
description: AI Agent config sync — scan, capture, restore, doctor via ai-config-sync CLI
---

# config-sync

Use the \`ai-config-sync\` / \`agent-sync\` CLI for deterministic config sync.

## Commands

- \`ai-config-sync status\`
- \`ai-config-sync scan\`
- \`ai-config-sync capture\`
- \`ai-config-sync plan\`
- \`ai-config-sync apply --yes --allow-risk medium\`
- \`ai-config-sync doctor\`
- \`ai-config-sync restore\` (alias of apply)

Hooks should only run lightweight \`ai-config-sync scan --light\`.
`,
      );
      actions.push("INSTALL Claude skill: config-sync");
    }

    // SessionStart hook hint in settings — field-level, do not overwrite file
    // We only create a hook script the user can wire; avoid destructive settings writes in setup.
    const hooksDir = path.join(home, ".claude", "hooks");
    const hookScript = path.join(hooksDir, "ai-config-sync-session-start.js");
    if (!(await pathExists(hookScript))) {
      await ensureDir(hooksDir);
      await writeText(
        hookScript,
        `/**
 * Lightweight SessionStart hook for ai-config-sync.
 * Run: node ~/.claude/hooks/ai-config-sync-session-start.js
 * Wire this into Claude Code SessionStart hooks manually or via the plugin.
 */
const { spawnSync } = require("child_process");
const r = spawnSync(
  process.platform === "win32" ? "npx.cmd" : "npx",
  ["ai-config-sync", "scan", "--light", "--json"],
  { encoding: "utf8", timeout: 15000, windowsHide: true }
);
if (r.status === 0 && r.stdout) {
  try {
    const data = JSON.parse(r.stdout);
    const unmanaged = (data.resources || []).filter(
      (x) => x.classification !== "managed" && x.kind !== "config"
    );
    if (unmanaged.length > 0) {
      console.error(
        \`[ai-config-sync] \${unmanaged.length} unmanaged resource(s). Run /config-sync:capture or ai-config-sync capture.\`
      );
    }
  } catch {
    /* ignore */
  }
}
`,
      );
      actions.push("INSTALL Claude hook script: ai-config-sync-session-start.js");
    }
  }

  if (targets.codex) {
    const skillDir = path.join(home, ".codex", "skills", "config-sync");
    const skillMd = path.join(skillDir, "SKILL.md");
    if (!(await pathExists(skillMd))) {
      await ensureDir(skillDir);
      await writeText(
        skillMd,
        `---
name: config-sync
description: Sync AI agent skills/plugins via ai-config-sync
---

# config-sync

Run \`ai-config-sync\` CLI for scan/capture/restore/doctor.

Prefer deterministic recipes after first confirmation. Do not execute untrusted install scripts.
`,
      );
      actions.push("INSTALL Codex skill: config-sync");
    }
  }

  return actions;
}

export async function runSetup(options: SetupOptions = {}): Promise<SetupResult> {
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
      ],
      actions: [],
    };
  }

  let localPath = detected.localPath!;
  let remote = detected.remote;

  // Clone if needed
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
    // exists — verify remote if git
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
    return { status: "planned", messages, actions };
  }

  // Ensure schema skeleton (idempotent)
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

  if (await pathExists(cfgPath) && mode !== "reconfigure") {
    const prev = await loadLocalConfig(cfgPath);
    const samePath =
      path.resolve(prev.configRepository.localPath) === path.resolve(localPath);
    const sameProfile = prev.profile === profile;
    if (samePath && sameProfile && mode === "default") {
      // repair integrations only
      status = "no-changes";
    } else if (!samePath && mode !== "repair") {
      messages.push(
        `Existing link points to ${prev.configRepository.localPath}. Use --reconfigure to switch.`,
      );
      if (mode === "default") {
        // still allow repair of integrations
        status = "repaired";
      }
    }
  }

  // Write local config (idempotent content)
  if (mode === "reconfigure" || !(await pathExists(cfgPath)) || status !== "no-changes") {
    // only rewrite when needed
    let shouldWrite = true;
    if (await pathExists(cfgPath) && mode !== "reconfigure") {
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

  // Integrations
  const integ = await installIntegrationStubs(home, {
    claude: localConfig.targets.claude,
    codex: localConfig.targets.codex,
  });
  if (integ.length > 0) {
    actions.push(...integ);
    if (status === "no-changes") status = "repaired";
  }

  if (actions.length === 0) {
    status = "no-changes";
    messages.push("No changes");
  }

  await appendLog(`setup status=${status} path=${localPath}`, home);

  return {
    status,
    messages,
    localConfig: await loadLocalConfig(cfgPath).catch(() => localConfig),
    actions,
  };
}
