#!/usr/bin/env node
import { Command } from "commander";
import os from "node:os";
import {
  expandHome,
  loadLocalConfig,
  localConfigPath,
  pathExists,
  checkSecrets,
  collectSecretRefs,
  loadResources,
  type LocalConfig,
  type RiskLevel,
} from "@ai-config-sync/core";
import { scanLocal, inventryDiff } from "@ai-config-sync/scanner";
import {
  appendPendingEvents,
  getState,
  listBackups,
  loadPending,
  rollbackBackup,
  ensureStateDirs,
} from "@ai-config-sync/state-manager";
import {
  commitAll,
  inspectGitSafety,
  listCachedSources,
  pullRepo,
  pushRepo,
} from "@ai-config-sync/git-sync";
import {
  applyPlan,
  buildCaptureProposals,
  buildDriftReport,
  buildPlan,
  checkVersionPolicy,
  commitCaptureItems,
  formatDoctor,
  formatPlan,
  runDoctor,
} from "@ai-config-sync/recipe-engine";
import { runSetup } from "./setup.js";
import path from "node:path";
import { loadLock } from "@ai-config-sync/core";

/** Injected by esbuild define when bundling; falls back for tsx/dev. */
declare const __APP_VERSION__: string | undefined;

const program = new Command();

program
  .name("ai-config-sync")
  .description(
    "AI Agent config sync — private config repo + Claude Code / Codex integrations",
  )
  .version(
    typeof __APP_VERSION__ !== "undefined"
      ? __APP_VERSION__
      : process.env.npm_package_version || "0.4.1",
  );

function homeOpt(cmd: { opts: () => { home?: string } }): string {
  return expandHome(cmd.opts().home ?? os.homedir());
}

async function loadCtx(home: string): Promise<{
  localConfig?: LocalConfig;
  configRepoPath?: string;
  linked: boolean;
}> {
  const cfgPath = localConfigPath(home);
  if (!(await pathExists(cfgPath))) return { linked: false };
  try {
    const localConfig = await loadLocalConfig(cfgPath);
    return {
      localConfig,
      configRepoPath: localConfig.configRepository.localPath,
      linked: true,
    };
  } catch (e) {
    return { linked: false };
  }
}

/** Friendly guidance when private config repo is not linked yet. */
function printNotLinkedHelp(command: string): void {
  console.log(`还没有关联「私有配置仓库」，所以暂时不能执行：${command}`);
  console.log("");
  console.log("私有配置仓库 = 只属于你的 Git 仓库，用来保存「装了哪些 Skill/Plugin」。");
  console.log("它和本程序仓库（ai-config-sync）是分开的。");
  console.log("");
  console.log("在 Claude 对话里可以直接说：");
  console.log('  「帮我初始化配置同步」');
  console.log('  「用模板创建私有配置仓库」');
  console.log("");
  console.log("或让助手执行下面其中一种（路径请改成你的）：");
  console.log("");
  console.log("  # A) 本机已有空目录 / 想用内置模板：");
  console.log("  ai-config-sync setup --config-path ~/ai-config/my-ai-config --profile home");
  console.log("");
  console.log("  # B) 已有远程私有仓库：");
  console.log("  ai-config-sync setup --repo git@github.com:你/my-ai-config.git --profile home");
  console.log("");
  console.log("说明：scan（只读扫描本机）不强制需要私有仓库；");
  console.log("      capture / restore / plan 才需要先 setup 关联。");
}

function requireLinked(
  ctx: { linked: boolean; localConfig?: LocalConfig; configRepoPath?: string },
  command: string,
): ctx is {
  linked: true;
  localConfig: LocalConfig;
  configRepoPath: string;
} {
  if (!ctx.linked || !ctx.localConfig || !ctx.configRepoPath) {
    printNotLinkedHelp(command);
    process.exitCode = 1;
    return false;
  }
  return true;
}


program
  .command("setup")
  .description("Initialize, link, repair, or reconfigure")
  .option("--config-path <path>", "Local private config repository path")
  .option("--repo <url>", "Git remote for private config repository")
  .option("--profile <name>", "Profile name", "home")
  .option("--plan", "Show planned setup actions only")
  .option("--repair", "Repair missing integrations only")
  .option("--reconfigure", "Rewrite local link and profile")
  .option("--home <path>", "Override home directory (testing)")
  .option("--no-claude", "Skip Claude integration")
  .option("--no-codex", "Skip Codex integration")
  .option("--program-root <path>", "Path to ai-config-sync program repo")
  .option(
    "--allow-local-plugin-install",
    "Offline/dev: allow `claude plugin marketplace add <local dir>` (never rewrites Claude state files by hand)",
  )
  .option(
    "--skip-self-plugin-install",
    "Skip Claude plugin install/enable (already running inside the plugin)",
  )
  .action(async (opts) => {
    const mode = opts.plan
      ? "plan"
      : opts.reconfigure
        ? "reconfigure"
        : opts.repair
          ? "repair"
          : "default";
    const result = await runSetup({
      home: opts.home,
      configPath: opts.configPath,
      repo: opts.repo,
      profile: opts.profile,
      mode,
      claude: opts.claude,
      codex: opts.codex,
      programRoot: opts.programRoot,
      allowLocalPluginInstall: !!opts.allowLocalPluginInstall,
      skipSelfPluginInstall: !!opts.skipSelfPluginInstall,
    });
    for (const m of result.messages) console.log(m);
    if (result.actions.length) {
      console.log("\nActions:");
      for (const a of result.actions) console.log(`  - ${a}`);
    } else {
      console.log("No changes");
    }
    console.log(`\nStatus: ${result.status}`);
  });

program
  .command("status")
  .description("Show repository, profile, integrations, pending")
  .option("--home <path>", "Override home directory")
  .option("--json", "JSON output")
  .action(async (opts) => {
    const home = homeOpt({ opts: () => opts });
    await ensureStateDirs(home);
    const ctx = await loadCtx(home);
    const state = await getState(home);
    const pending = await loadPending(home);
    const payload = {
      linked: ctx.linked,
      localConfig: ctx.localConfig,
      configRepoPath: ctx.configRepoPath,
      stateSummary: {
        profile: state.profile,
        lastAppliedCommit: state.lastAppliedCommit,
        installedCount: Object.keys(state.installed).length,
        lastSuccessfulApply: state.lastSuccessfulApply,
      },
      pendingBatches: pending.filter((b) => b.status === "pending-review")
        .length,
    };
    if (opts.json) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }
    if (!ctx.linked || !ctx.localConfig) {
      printNotLinkedHelp("status");
      return;
    }
    console.log(`Profile: ${ctx.localConfig.profile}`);
    console.log(`Config repository: ${ctx.localConfig.configRepository.localPath}`);
    if (ctx.localConfig.configRepository.remote) {
      console.log(`Remote: ${ctx.localConfig.configRepository.remote}`);
    }
    console.log(
      `Targets: claude=${ctx.localConfig.targets.claude} codex=${ctx.localConfig.targets.codex}`,
    );
    console.log(`Installed resources: ${payload.stateSummary.installedCount}`);
    console.log(`Pending batches: ${payload.pendingBatches}`);
    if (ctx.configRepoPath) {
      const git = await inspectGitSafety(ctx.configRepoPath);
      if (git.messages.length) {
        console.log("Git:");
        for (const m of git.messages) console.log(`  - ${m}`);
      }
    }
  });

program
  .command("scan")
  .description("Read-only scan of local Claude/Codex resources")
  .option("--home <path>", "Override home directory")
  .option("--light", "Skip hashing for faster scans")
  .option("--json", "JSON output")
  .option("--write-pending", "Write unmanaged findings to pending events")
  .option("--include-system", "Show system-cache resources in text output")
  .action(async (opts) => {
    const home = homeOpt({ opts: () => opts });
    const ctx = await loadCtx(home);
    const state = await getState(home);
    const managedIds = new Set(Object.keys(state.installed));
    const result = await scanLocal({
      home,
      light: !!opts.light,
      managedIds,
      targets: ctx.localConfig?.targets,
    });
    if (opts.writePending) {
      const unmanaged = inventryDiff(result, managedIds);
      if (unmanaged.length) {
        await appendPendingEvents(
          unmanaged.map((u) => ({
            type: "resource-added" as const,
            target: u.target,
            path: u.path,
            resourceId: u.id,
            sourceCandidate: u.sourceCandidate,
            confidence: u.confidence,
          })),
          home,
        );
      }
    }
    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            ...result,
            linked: ctx.linked,
            configRepoPath: ctx.configRepoPath ?? null,
            hint: ctx.linked
              ? null
              : "Private config repo not linked. scan still works (read-only). Run setup before capture/restore.",
          },
          null,
          2,
        ),
      );
      return;
    }
    if (!ctx.linked) {
      console.log(
        "提示：尚未关联私有配置仓库。本次只是只读扫描本机，不会写入任何仓库。",
      );
      console.log(
        "若要把结果备份起来，请先 setup（对话里说「初始化配置同步」）。",
      );
      console.log("");
    }
    console.log(`Scanned at ${result.scannedAt}`);
    const visible = result.resources.filter(
      (r) =>
        r.kind !== "config" &&
        (opts.includeSystem || r.classification !== "system-cache"),
    );
    console.log(`Resources: ${visible.length}`);
    for (const r of visible) {
      console.log(
        `  [${r.classification}] ${r.target}/${r.kind} ${r.id}${r.sourceCandidate ? ` <- ${r.sourceCandidate}` : ""}`,
      );
    }
    for (const w of result.warnings) console.log(`WARN: ${w}`);
    if (!ctx.linked) {
      console.log("");
      console.log("下一步：关联私有配置仓库后，可用 capture 把未纳管资源写入清单。");
    }
  });

program
  .command("capture")
  .description("Propose managing local resources into the private config repo")
  .option("--home <path>", "Override home directory")
  .option("--yes", "Confirm and write proposals without prompt")
  .option("--json", "JSON output of proposals")
  .option("--commit", "Git commit after writing (secret-scanned)")
  .option("--push", "Push after commit")
  .option(
      "--analyze",
      "Enable heuristic recipe analysis for non-standard sources (no LLM required)",
    )
  .option(
      "--ai",
      "Alias of --analyze; real LLM only when localConfig.ai has a provider configured",
    )
  .action(async (opts) => {
    const home = homeOpt({ opts: () => opts });
    const ctx = await loadCtx(home);
    if (!requireLinked(ctx, "capture")) return;
    const { localConfig, configRepoPath } = ctx;
    const state = await getState(home);
    const managedIds = new Set(Object.keys(state.installed));
    const scan = await scanLocal({
      home,
      managedIds,
      targets: localConfig.targets,
    });
    const aiEnabled =
      !!opts.analyze ||
      !!opts.ai ||
      (localConfig.ai?.enabled && localConfig.ai.mode === "analyze-only");
    const proposals = await buildCaptureProposals(
      inventryDiff(scan, managedIds),
      configRepoPath,
      {
        aiEnabled,
        homeHint: home,
        home,
        offline: false,
      },
    );
    if (opts.json) {
      console.log(JSON.stringify(proposals, null, 2));
      return;
    }
    if (proposals.length === 0) {
      console.log("No unmanaged resources to capture.");
      return;
    }
    const ready = proposals.filter((p) => p.status === "ready" || (!p.status && p.suggestedRecipe && !p.needsAi));
    const blocked = proposals.filter((p) => p.status === "blocked");
    const needsReview = proposals.filter(
      (p) => p.status === "needs-review" || (!p.status && (p.needsAi || !p.suggestedRecipe)),
    );
    console.log(`Capture proposals (${proposals.length}):`);
    console.log(
      `Ready: ${ready.length}  Blocked: ${blocked.length}  Needs-review: ${needsReview.length}`,
    );
    for (const p of proposals) {
      const label = (p.status ?? (p.needsAi ? "needs-review" : p.suggestedRecipe ? "ready" : "needs-review")).toUpperCase();
      const driver =
        p.suggestedRecipe?.targets?.claude?.driver ??
        p.suggestedRecipe?.targets?.codex?.driver ??
        p.candidate?.driver;
      console.log(
        `  [${label}] ${p.scanned.target}/${p.scanned.kind} ${p.suggestedResource.id}` +
          (p.scanned.sourceCandidate
            ? ` source=${p.scanned.sourceCandidate}`
            : "") +
          (driver ? ` driver=${driver}` : "") +
          (p.blockReason ? ` reason=${p.blockReason}` : "") +
          (p.needsAi ? " [needs AI analysis]" : "") +
          (p.usedAi ? " [heuristic/ai]" : ""),
      );
    }
    if (!opts.yes) {
      console.log("\nRe-run with --yes to write resources.yaml and recipes.");
      console.log(
        "Use --analyze for heuristic analysis of unknown layouts (no LLM). --ai is an alias.",
      );
      console.log("Note: --yes only writes READY proposals (blocked/system excluded).");
      return;
    }
    // Auto-confirm only READY proposals (never blocked / needs-review via usedAi)
    const confirmed = proposals.filter(
      (p) =>
        p.suggestedRecipe &&
        (p.status === "ready" ||
          (p.status === undefined && !p.needsAi)),
    );
    const skipped = proposals.filter((p) => !confirmed.includes(p));
    if (confirmed.length === 0) {
      console.log(
        "No rule-based recipes ready. Enable AI assistant or author recipes manually.",
      );
      for (const s of skipped) {
        console.log(`  skipped: ${s.suggestedResource.id} (needs review)`);
      }
      return;
    }
    const written = await commitCaptureItems(
      confirmed,
      configRepoPath,
      os.userInfo().username,
      { home },
    );
    console.log(`Updated ${written.resourcesPath}`);
    for (const r of written.recipePaths) console.log(`  recipe: ${r}`);
    for (const s of skipped) {
      console.log(`  skipped: ${s.suggestedResource.id} (needs review)`);
    }
    if (opts.commit) {
      const result = await commitAll(
        configRepoPath,
        `capture: add ${confirmed.map((c) => c.suggestedResource.id).join(", ")}`,
      );
      console.log(result ? "Committed." : "Nothing to commit.");
      if (opts.push && result) {
        await pushRepo(configRepoPath);
        console.log("Pushed.");
      }
    }
  });

program
  .command("plan")
  .description("Show planned install/update/delete actions")
  .option("--home <path>", "Override home directory")
  .option("--profile <name>", "Profile override")
  .option("--json", "JSON output")
  .action(async (opts) => {
    const home = homeOpt({ opts: () => opts });
    const ctx = await loadCtx(home);
    if (!requireLinked(ctx, "plan")) return;
    const { localConfig, configRepoPath } = ctx;
    const plan = await buildPlan({
      home,
      configRepoPath,
      localConfig,
      profileName: opts.profile ?? localConfig.profile,
    });
    if (opts.json) {
      console.log(JSON.stringify(plan, null, 2));
      return;
    }
    console.log(formatPlan(plan));
  });

async function runApplyLike(
  opts: {
    home?: string;
    profile?: string;
    yes?: boolean;
    allowRisk?: string;
    dryRun?: boolean;
    json?: boolean;
    updateSources?: boolean;
    offline?: boolean;
  },
  label: string,
) {
  const home = homeOpt({ opts: () => opts });
  const ctx = await loadCtx(home);
  if (!requireLinked(ctx, label.toLowerCase())) return;
  const { localConfig, configRepoPath } = ctx;
  // Safety: pull only when clean
  const git = await inspectGitSafety(configRepoPath);
  if (git.canPull) {
    try {
      await pullRepo(configRepoPath);
      console.log("Pulled latest config repository.");
    } catch (e) {
      console.log(`Pull skipped/failed: ${(e as Error).message}`);
    }
  } else if (git.messages.length) {
    for (const m of git.messages) console.log(`Git: ${m}`);
  }

  const result = await applyPlan({
    home,
    configRepoPath,
    localConfig,
    profileName: opts.profile ?? localConfig.profile,
    yes: !!opts.yes,
    allowRisk: (opts.allowRisk as RiskLevel | undefined) ?? "low",
    dryRun: !!opts.dryRun,
    updateSources: !!opts.updateSources,
    offline: !!opts.offline,
  });

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(formatPlan(result.plan));
  console.log("");
  if (result.noChanges) {
    console.log(`${label}: No changes`);
    return;
  }
  if (result.autoRolledBack) {
    console.log(`AUTO-ROLLBACK: ${result.backupId} (apply failed; changes undone)`);
  }
  if (result.backupId && !result.autoRolledBack) console.log(`Backup: ${result.backupId}`);
  for (const a of result.applied) console.log(`APPLIED: ${a}`);
  for (const m of result.manual) console.log(`MANUAL: ${m}`);
  for (const f of result.failed) {
    console.log(`FAILED: ${f.actionId} ${f.error}`);
    process.exitCode = 1;
  }
}

program
  .command("apply")
  .description("Apply a plan (requires --yes)")
  .option("--home <path>", "Override home directory")
  .option("--profile <name>", "Profile override")
  .option("--yes", "Confirm apply")
  .option("--allow-risk <level>", "Max risk: low|medium|high", "low")
  .option("--dry-run", "Do not write")
  .option("--offline", "Do not clone/fetch sources")
  .option("--json", "JSON output")
  .action(async (opts) => runApplyLike(opts, "Apply"));

program
  .command("restore")
  .description("Restore environment from private config (alias of apply)")
  .option("--home <path>", "Override home directory")
  .option("--profile <name>", "Profile override")
  .option("--yes", "Confirm apply")
  .option("--allow-risk <level>", "Max risk: low|medium|high", "medium")
  .option("--dry-run", "Do not write")
  .option("--offline", "Do not clone/fetch sources")
  .option("--json", "JSON output")
  .action(async (opts) => runApplyLike(opts, "Restore"));

program
  .command("update")
  .description("Fetch sources per versionPolicy and re-apply")
  .option("--home <path>", "Override home directory")
  .option("--profile <name>", "Profile override")
  .option("--yes", "Confirm apply")
  .option("--allow-risk <level>", "Max risk", "medium")
  .option("--offline", "Do not fetch remote sources")
  .option("--json", "JSON output")
  .action(async (opts) => {
    const home = homeOpt({ opts: () => opts });
    const ctx = await loadCtx(home);
    if (!requireLinked(ctx, "update")) return;
    const { localConfig, configRepoPath } = ctx;
    // Report version policies before apply
    const resources = await loadResources(
      path.join(configRepoPath, "resources.yaml"),
    );
    const lock = await loadLock(path.join(configRepoPath, "lock.yaml"));
    for (const r of resources.resources) {
      const locked = lock.entries.find((e) => e.resourceId === r.id);
      const check = await checkVersionPolicy({
        resource: r,
        lockedCommit: locked?.commit,
      });
      console.log(
        `[${check.policy}] ${check.resourceId}: ${check.action} — ${check.message}`,
      );
    }
    await runApplyLike({ ...opts, updateSources: !opts.offline }, "Update");
  });

program
  .command("doctor")
  .description("Verify dependencies, config, hooks, plugins, secrets")
  .option("--home <path>", "Override home directory")
  .option("--json", "JSON output")
  .action(async (opts) => {
    const home = homeOpt({ opts: () => opts });
    const ctx = await loadCtx(home);
    const report = await runDoctor({
      home,
      localConfig: ctx.localConfig,
      configRepoPath: ctx.configRepoPath,
    });
    if (opts.json) {
      console.log(JSON.stringify({ ...report, linked: ctx.linked }, null, 2));
      return;
    }
    if (!ctx.linked) {
      console.log("提示：尚未关联私有配置仓库。Doctor 仍可检查本机依赖。");
      console.log("");
    }
    console.log(formatDoctor(report));
    if (!report.ok) process.exitCode = 1;
  });

program
  .command("drift")
  .description("Detect differences between desired and local state")
  .option("--home <path>", "Override home directory")
  .option("--json", "JSON output")
  .action(async (opts) => {
    const home = homeOpt({ opts: () => opts });
    const ctx = await loadCtx(home);
    if (!requireLinked(ctx, "drift")) return;
    const { localConfig, configRepoPath } = ctx;
    const report = await buildDriftReport({
      home,
      configRepoPath,
      localConfig,
      profileName: localConfig.profile,
    });
    const plan = await buildPlan({
      home,
      configRepoPath,
      localConfig,
      profileName: localConfig.profile,
    });
    const scan = await scanLocal({ home, targets: localConfig.targets, light: true });
    const payload = {
      summary: report.summary,
      items: report.items,
      planActions: plan.actions.length,
      plan,
      localResourceCount: scan.resources.length,
    };
    if (opts.json) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }
    console.log(report.summary);
    for (const item of report.items) {
      const tag = item.kind === "in-sync" ? "OK" : item.kind.toUpperCase();
      console.log(
        `  [${tag}] ${item.target}/${item.resourceId}: ${item.message}`,
      );
    }
    console.log("");
    console.log(formatPlan(plan));
    console.log(`\nLocal resources scanned: ${scan.resources.length}`);
    if (report.items.some((i) => i.kind !== "in-sync")) process.exitCode = 1;
  });

program
  .command("repair")
  .description("Repair missing integrations / managed fields")
  .option("--home <path>", "Override home directory")
  .action(async (opts) => {
    const result = await runSetup({
      home: opts.home,
      mode: "repair",
    });
    for (const m of result.messages) console.log(m);
    for (const a of result.actions) console.log(`  - ${a}`);
    if (result.actions.length === 0) console.log("No changes");
  });

program
  .command("rollback")
  .description("Restore files from a backup")
  .option("--last", "Rollback the most recent backup")
  .option("--id <id>", "Backup id")
  .option("--home <path>", "Override home directory")
  .action(async (opts) => {
    const home = homeOpt({ opts: () => opts });
    if (!opts.last && !opts.id) {
      const list = await listBackups(home);
      if (!list.length) {
        console.log("No backups.");
        return;
      }
      console.log("Backups:");
      for (const b of list) {
        console.log(`  ${b.id}  ${b.createdAt}  ${b.reason}`);
      }
      console.log("\nUse --last or --id <id>");
      return;
    }
    const record = await rollbackBackup(opts.last ? "last" : opts.id, home);
    console.log(`Rolled back backup ${record.id} (${record.files.length} path(s))`);
  });

program
  .command("secret")
  .description("Check or document secretRef resolution (env provider)")
  .argument("[action]", "check | set | scan", "check")
  .argument("[ref]", "secretRef name")
  .option("--home <path>", "Override home")
  .action(async (action, ref, opts) => {
    const home = homeOpt({ opts: () => opts });
    if (action === "set") {
      console.log("MVP stores secrets only via OS env / Credential Manager.");
      console.log(
        `Set environment variable for ref "${ref ?? "name"}" (e.g. SECRET_${(ref ?? "NAME").replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}).`,
      );
      console.log(
        "Config files must use secretRef keys only — never paste real secrets into the private repo.",
      );
      return;
    }
    if (action === "scan" || (!ref && action === "check")) {
      const ctx = await loadCtx(home);
      if (!ctx.configRepoPath) {
        console.log("尚未关联私有配置仓库；可先检查单个 ref，或先 setup。");
        if (ref) {
          /* fallthrough */
        } else {
          return;
        }
      }
      if (ctx.configRepoPath && (action === "scan" || !ref)) {
        const resources = await loadResources(
          path.join(ctx.configRepoPath, "resources.yaml"),
        );
        const refs = collectSecretRefs(resources);
        if (refs.length === 0) {
          console.log("No secretRef entries found in resources.yaml");
        } else {
          const results = await checkSecrets(refs, "env");
          for (const r of results) {
            console.log(`${r.ok ? "OK" : "MISSING"} ${r.ref}: ${r.message}`);
            if (!r.ok) process.exitCode = 1;
          }
        }
        const cached = await listCachedSources(home);
        if (cached.length) {
          console.log(`Source cache entries: ${cached.length}`);
        }
        if (!ref) return;
      }
    }
    if (ref) {
      const results = await checkSecrets([ref], "env");
      const r = results[0]!;
      console.log(`${r.ok ? "OK" : "MISSING"} ${r.ref}: ${r.message}`);
      if (!r.ok) process.exitCode = 1;
      return;
    }
    console.log(
      "Usage: ai-config-sync secret check [ref] | secret set <ref> | secret scan",
    );
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
