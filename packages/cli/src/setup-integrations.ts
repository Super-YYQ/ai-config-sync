import path from "node:path";
import fs from "node:fs/promises";
import {
  agentsSkillsDir,
  codexConfigPath,
  codexHooksManifestPath,
  ensureDir,
  getTomlValue,
  hasManagedCodexSessionStart,
  homeScopedEnv,
  mergeManagedCodexSessionStart,
  mergeTomlText,
  pathExists,
  readJsonFile,
  readText,
  runClaude,
  stableBinDir,
  stableCliCjs,
  stableCliCmd,
  stableCliSh,
  writeJsonFile,
  writeText,
} from "@ai-config-sync/core";
import { isRunningInsideSelfPlugin } from "./setup-discovery.js";
import type { IntegrationInstallResult } from "./setup-types.js";

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
export async function installClaudePlugin(
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

  const invokeClaude = async (args: string[], timeout = 120000) => {
    await runClaude(args, {
      timeout,
      maxBuffer: 4 * 1024 * 1024,
      env: homeScopedEnv(home),
    });
  };

  let claudeAvailable = true;
  try {
    await invokeClaude(["--version"], 15000);
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
    await invokeClaude([
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
      // Marketplace manifest lives at packageRoot/.claude-plugin/marketplace.json
      // Prefer packageRoot over the nested plugin directory.
      const marketplaceSrc =
        programRoot &&
        (await pathExists(
          path.join(programRoot, ".claude-plugin", "marketplace.json"),
        ))
          ? programRoot
          : pluginSrc;
      try {
        await invokeClaude(["plugin", "marketplace", "add", marketplaceSrc]);
        actions.push(
          `claude plugin marketplace add ${marketplaceSrc} (local/dev)`,
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
          // Marketplace registration failure is a warning; install/enable decide ok.
          warnings.push(w);
          actions.push(`WARN ${w}`);
        }
      }
    } else {
      const w =
        `claude marketplace add failed: ${msg.slice(0, 200)}. ` +
        "Pass --allow-local-plugin-install for offline/dev directory marketplace.";
      warnings.push(w);
      actions.push(`WARN ${w}`);
    }
  }

  // 2) Install + enable via official CLI only
  let installOk = false;
  try {
    await invokeClaude(
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
    await invokeClaude(
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
    const listOut = await runClaude(["plugin", "list", "--json"], {
      timeout: 30000,
      maxBuffer: 4 * 1024 * 1024,
      env: homeScopedEnv(home),
    });
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

/**
 * Install a stable CLI entry under ~/.ai-config-sync/bin so Codex hooks/skills
 * do not depend on Claude plugin cache paths that change on update.
 */
export async function installStableCliShim(
  home: string,
  sources: { programRoot?: string; pluginRoot?: string },
): Promise<{ cjs?: string; cmd?: string; sh?: string; changed: boolean; actions: string[] }> {
  const actions: string[] = [];
  let changed = false;

  // Resolve best source CJS
  const candidates: string[] = [];
  if (sources.pluginRoot) {
    candidates.push(path.join(sources.pluginRoot, "bin", "ai-config-sync.cjs"));
  }
  if (sources.programRoot) {
    candidates.push(
      path.join(
        sources.programRoot,
        "integrations",
        "claude-plugin",
        "bin",
        "ai-config-sync.cjs",
      ),
    );
    candidates.push(path.join(sources.programRoot, "dist", "ai-config-sync.cjs"));
  }
  try {
    const argv1 = process.argv[1];
    if (argv1 && (argv1.endsWith(".cjs") || argv1.endsWith(".js"))) {
      candidates.push(path.resolve(argv1));
    }
  } catch {
    /* ignore */
  }

  let sourceCjs: string | undefined;
  for (const c of candidates) {
    if (c && (await pathExists(c))) {
      sourceCjs = c;
      break;
    }
  }
  if (!sourceCjs) {
    return { changed: false, actions };
  }

  await ensureDir(stableBinDir(home));
  const destCjs = stableCliCjs(home);
  const destCmd = stableCliCmd(home);
  const destSh = stableCliSh(home);

  // Always refresh stable copy so plugin updates propagate
  const srcBuf = await fs.readFile(sourceCjs);
  let needCopy = true;
  if (await pathExists(destCjs)) {
    try {
      const destBuf = await fs.readFile(destCjs);
      if (srcBuf.equals(destBuf)) needCopy = false;
    } catch {
      needCopy = true;
    }
  }
  if (needCopy) {
    // Atomic refresh: temp + fsync + rename so a crash never leaves a truncated CJS
    const tmp = `${destCjs}.${process.pid}.${Date.now()}.tmp`;
    const fh = await fs.open(tmp, "w");
    try {
      await fh.writeFile(srcBuf);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fs.rename(tmp, destCjs).catch(async () => {
      // Windows: rename over existing may fail — unlink then rename
      await fs.rm(destCjs, { force: true }).catch(() => {});
      await fs.rename(tmp, destCjs);
    });
    actions.push(`INSTALL stable CLI shim → ${destCjs}`);
    changed = true;
  }

  const cmdBody = `@echo off\r\n"${process.execPath}" "%~dp0ai-config-sync.cjs" %*\r\n`;
  let needCmd = true;
  if (await pathExists(destCmd)) {
    try {
      const existing = await readText(destCmd);
      if (existing === cmdBody) needCmd = false;
    } catch {
      needCmd = true;
    }
  }
  if (needCmd) {
    await writeText(destCmd, cmdBody);
    actions.push(`INSTALL stable CLI cmd → ${destCmd}`);
    changed = true;
  }

  const shBody = `#!/usr/bin/env bash
exec "${process.execPath}" "$(dirname "$0")/ai-config-sync.cjs" "$@"
`;
  let needSh = true;
  if (await pathExists(destSh)) {
    try {
      const existing = await readText(destSh);
      if (existing === shBody) needSh = false;
    } catch {
      needSh = true;
    }
  }
  if (needSh) {
    await writeText(destSh, shBody);
    try {
      await fs.chmod(destSh, 0o755);
    } catch {
      /* windows */
    }
    actions.push(`INSTALL stable CLI shell → ${destSh}`);
    changed = true;
  }

  return { cjs: destCjs, cmd: destCmd, sh: destSh, changed, actions };
}

export async function installCodexIntegration(
  home: string,
  programRoot?: string,
  pluginRoot?: string,
  options: { enableCodexHook?: boolean } = {},
): Promise<IntegrationInstallResult> {
  const actions: string[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  let changed = false;
  const enableHook = !!options.enableCodexHook;

  // Stable CLI shim first — Codex skill + hooks both reference it
  const shim = await installStableCliShim(home, { programRoot, pluginRoot });
  if (shim.actions.length) {
    actions.push(...shim.actions);
    if (shim.changed) changed = true;
  }

  const stableCjs = shim.cjs ?? ((await pathExists(stableCliCjs(home))) ? stableCliCjs(home) : undefined);
  const cliAbsoluteCommand = stableCjs
    ? `"${process.execPath}" "${stableCjs}"`
    : undefined;
  const skillCliHint = stableCjs
    ? `"${process.execPath}" "${stableCjs}"`
    : "ai-config-sync";

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

  const skillMd = path.join(skillDest, "SKILL.md");
  const skillBody = `---
name: config-sync
description: 同步 AI Agent Skill/Plugin。用户说「同步配置」「扫描技能」「恢复环境」时使用。
---

# config-sync (Codex / agents)

使用稳定 CLI 入口（Setup 写入 \`~/.ai-config-sync/bin\`，不依赖 Claude Plugin 缓存路径）：

- \`${skillCliHint} status\`
- \`${skillCliHint} scan\`
- \`${skillCliHint} capture --yes\`
- \`${skillCliHint} restore --yes --allow-risk medium\`
- \`${skillCliHint} doctor\`

也可在 PATH 中有全局安装时直接用 \`ai-config-sync\`。

先 plan 再 apply。不要把密钥写进 git。
`;

  let skillNeedsWrite = true;
  if (await pathExists(skillMd)) {
    try {
      const existing = await readText(skillMd);
      // Refresh if it still points at bare command without stable path while we have one
      if (
        stableCjs &&
        existing.includes(stableCjs.replace(/\\/g, "\\\\")) === false &&
        !existing.includes(stableCjs)
      ) {
        skillNeedsWrite = true;
      } else if (!stableCjs) {
        skillNeedsWrite = false;
      } else if (existing.includes(stableCjs)) {
        skillNeedsWrite = false;
      }
    } catch {
      skillNeedsWrite = true;
    }
  }

  if (skillNeedsWrite) {
    await ensureDir(skillDest);
    if (skillSrc && !(await pathExists(skillMd))) {
      await fs.cp(skillSrc, skillDest, { recursive: true });
      // Still overwrite SKILL.md with stable-path version
    }
    await writeText(skillMd, skillBody);
    actions.push(`INSTALL agents skill: config-sync → ${skillDest}`);
    changed = true;
  }

  // Codex hooks.json + features.hooks — only with explicit --enable-codex-hook
  if (!enableHook) {
    actions.push(
      "SKIP Codex SessionStart hook (pass --enable-codex-hook to install hooks.json + features.hooks)",
    );
    if (stableCjs) {
      actions.push(
        `NOTE: Codex CLI entry is stable shim ${stableCjs} (refresh via setup after plugin update).`,
      );
    }
    return { ok: true, changed, warnings, errors, actions };
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
        ? "MERGE Codex hooks.json SessionStart (event-map + stable commandWindows)"
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
  if (stableCjs) {
    actions.push(
      `NOTE: Codex CLI entry is stable shim ${stableCjs} (refresh via setup after plugin update).`,
    );
  }

  return { ok: true, changed, warnings, errors, actions };
}
