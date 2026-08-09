import path from "node:path";
import os from "node:os";
import {
  ensureDir,
  expandHome,
  loadLocalConfig,
  localConfigPath,
  pathExists,
  saveLocalConfig,
  writeText,
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
  appendLog,
  ensureStateDirs,
} from "@ai-config-sync/state-manager";
import {
  detectConfigRepo,
  detectPackageRoot,
  detectPluginRoot,
  ensureMinimalConfigRepo,
  isRunningInsideSelfPlugin,
} from "./setup-discovery.js";
import {
  installClaudePlugin,
  installCodexIntegration,
} from "./setup-integrations.js";
import type { SetupOptions, SetupResult } from "./setup-types.js";

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
    if (options.codex === true) {
      actions.push("INSTALL Codex skill config-sync");
      if (options.enableCodexHook) {
        actions.push("MERGE Codex hooks.json + features.hooks");
      } else {
        actions.push("SKIP Codex hooks (need --enable-codex-hook)");
      }
    }
    return { status: "planned", messages, actions };
  }

  actions.push(...(await ensureMinimalConfigRepo(localPath)));

  // Detect plugin early so defaults can prefer Claude-only inside plugin
  const packageRootEarly = await detectPackageRoot(options.programRoot);
  const pluginRootEarly = await detectPluginRoot();
  const insideSelfEarly =
    !!options.skipSelfPluginInstall ||
    (await isRunningInsideSelfPlugin(pluginRootEarly));

  // Defaults: inside Claude plugin → Claude only; otherwise both unless overridden.
  // Explicit options.claude / options.codex always win.
  const defaultClaude = true;
  const defaultCodex = insideSelfEarly ? false : true;
  const wantClaude = options.claude ?? defaultClaude;
  const wantCodex = options.codex ?? defaultCodex;

  const profile = options.profile ?? "home";
  const localConfig: LocalConfig = {
    schemaVersion: 1,
    configRepository: {
      remote,
      localPath,
    },
    profile,
    targets: {
      claude: wantClaude,
      codex: wantCodex,
    },
    ai: { enabled: false, mode: "off" },
  };

  // Preview planned writes before applying
  if (options.preview !== false) {
    messages.push("Setup will create/modify:");
    messages.push(`  · link ${localConfigPath(home)} → ${localPath}`);
    messages.push(`  · profile ${profile}`);
    if (wantClaude) {
      messages.push("  · Claude: plugin install/enable (or skip if already self)");
    } else {
      messages.push("  · Claude: skipped");
    }
    if (wantCodex) {
      messages.push("  · Codex: agents skill config-sync");
      if (options.enableCodexHook) {
        messages.push("  · Codex: hooks.json SessionStart + config.toml features.hooks");
      } else {
        messages.push(
          "  · Codex: hooks skipped (pass --enable-codex-hook to enable)",
        );
      }
    } else {
      messages.push(
        "  · Codex: skipped (use --target codex|all or omit plugin-only default)",
      );
    }
    messages.push("");
  }

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

  const packageRoot = packageRootEarly ?? (await detectPackageRoot(options.programRoot));
  const pluginRoot = pluginRootEarly ?? (await detectPluginRoot());
  const insideSelf =
    insideSelfEarly ||
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
    if (options.codex === undefined && !wantCodex) {
      messages.push(
        "Default: Claude-only (inside plugin). Pass --target all or --target codex for Codex.",
      );
    }
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
      { enableCodexHook: !!options.enableCodexHook },
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
