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

const program = new Command();

program
  .name("ai-config-sync")
  .description(
    "AI Agent config sync — private config repo + Claude Code / Codex integrations",
  )
  .version("0.2.0");

function homeOpt(cmd: { opts: () => { home?: string } }): string {
  return expandHome(cmd.opts().home ?? os.homedir());
}

async function loadCtx(home: string): Promise<{
  localConfig?: LocalConfig;
  configRepoPath?: string;
}> {
  const cfgPath = localConfigPath(home);
  if (!(await pathExists(cfgPath))) return {};
  const localConfig = await loadLocalConfig(cfgPath);
  return {
    localConfig,
    configRepoPath: localConfig.configRepository.localPath,
  };
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
    const { localConfig, configRepoPath } = await loadCtx(home);
    const state = await getState(home);
    const pending = await loadPending(home);
    const payload = {
      linked: !!localConfig,
      localConfig,
      configRepoPath,
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
    if (!localConfig) {
      console.log("Not initialized. Run: ai-config-sync setup");
      return;
    }
    console.log(`Profile: ${localConfig.profile}`);
    console.log(`Config repository: ${localConfig.configRepository.localPath}`);
    if (localConfig.configRepository.remote) {
      console.log(`Remote: ${localConfig.configRepository.remote}`);
    }
    console.log(
      `Targets: claude=${localConfig.targets.claude} codex=${localConfig.targets.codex}`,
    );
    console.log(`Installed resources: ${payload.stateSummary.installedCount}`);
    console.log(`Pending batches: ${payload.pendingBatches}`);
    if (configRepoPath) {
      const git = await inspectGitSafety(configRepoPath);
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
  .action(async (opts) => {
    const home = homeOpt({ opts: () => opts });
    const { localConfig } = await loadCtx(home);
    const state = await getState(home);
    const managedIds = new Set(Object.keys(state.installed));
    const result = await scanLocal({
      home,
      light: !!opts.light,
      managedIds,
      targets: localConfig?.targets,
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
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(`Scanned at ${result.scannedAt}`);
    console.log(`Resources: ${result.resources.length}`);
    for (const r of result.resources) {
      if (r.kind === "config") continue;
      console.log(
        `  [${r.classification}] ${r.target}/${r.kind} ${r.id}${r.sourceCandidate ? ` <- ${r.sourceCandidate}` : ""}`,
      );
    }
    for (const w of result.warnings) console.log(`WARN: ${w}`);
  });

program
  .command("capture")
  .description("Propose managing local resources into the private config repo")
  .option("--home <path>", "Override home directory")
  .option("--yes", "Confirm and write proposals without prompt")
  .option("--json", "JSON output of proposals")
  .option("--commit", "Git commit after writing (secret-scanned)")
  .option("--push", "Push after commit")
  .option("--ai", "Enable analyze-only AI/heuristic recipe assistant for non-standard sources")
  .action(async (opts) => {
    const home = homeOpt({ opts: () => opts });
    const { localConfig, configRepoPath } = await loadCtx(home);
    if (!localConfig || !configRepoPath) {
      console.error("Not initialized. Run setup first.");
      process.exitCode = 1;
      return;
    }
    const state = await getState(home);
    const managedIds = new Set(Object.keys(state.installed));
    const scan = await scanLocal({
      home,
      managedIds,
      targets: localConfig.targets,
    });
    const aiEnabled =
      !!opts.ai ||
      (localConfig.ai?.enabled && localConfig.ai.mode === "analyze-only");
    const proposals = await buildCaptureProposals(
      inventryDiff(scan, managedIds),
      configRepoPath,
      { aiEnabled, homeHint: home },
    );
    if (opts.json) {
      console.log(JSON.stringify(proposals, null, 2));
      return;
    }
    if (proposals.length === 0) {
      console.log("No unmanaged resources to capture.");
      return;
    }
    console.log(`Capture proposals (${proposals.length}):`);
    for (const p of proposals) {
      console.log(
        `  - ${p.scanned.target}/${p.scanned.kind} ${p.suggestedResource.id}` +
          (p.scanned.sourceCandidate
            ? ` source=${p.scanned.sourceCandidate}`
            : "") +
          (p.needsAi ? " [needs AI analysis]" : "") +
          (p.usedAi ? " [heuristic/ai]" : "") +
          (p.candidate
            ? ` driver=${p.candidate.driver} conf=${p.candidate.confidence}`
            : ""),
      );
    }
    if (!opts.yes) {
      console.log("\nRe-run with --yes to write resources.yaml and recipes.");
      console.log("Use --ai to enable heuristic/AI analyze-only for unknown layouts.");
      return;
    }
    // Auto-confirm rule-based or AI-assisted recipes that produced a candidate
    const confirmed = proposals.filter((p) => p.suggestedRecipe && (!p.needsAi || p.usedAi));
    const skipped = proposals.filter((p) => !p.suggestedRecipe || (p.needsAi && !p.usedAi));
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
    const { localConfig, configRepoPath } = await loadCtx(home);
    if (!localConfig || !configRepoPath) {
      console.error("Not initialized. Run setup first.");
      process.exitCode = 1;
      return;
    }
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
  const { localConfig, configRepoPath } = await loadCtx(home);
  if (!localConfig || !configRepoPath) {
    console.error("Not initialized. Run setup first.");
    process.exitCode = 1;
    return;
  }
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
  if (result.backupId) console.log(`Backup: ${result.backupId}`);
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
    const { localConfig, configRepoPath } = await loadCtx(home);
    if (!localConfig || !configRepoPath) {
      console.error("Not initialized. Run setup first.");
      process.exitCode = 1;
      return;
    }
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
    const { localConfig, configRepoPath } = await loadCtx(home);
    const report = await runDoctor({ home, localConfig, configRepoPath });
    if (opts.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
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
    const { localConfig, configRepoPath } = await loadCtx(home);
    if (!localConfig || !configRepoPath) {
      console.error("Not initialized. Run setup first.");
      process.exitCode = 1;
      return;
    }
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
      const { configRepoPath } = await loadCtx(home);
      if (!configRepoPath) {
        console.log("Not initialized; provide a ref or run setup.");
        if (ref) {
          /* fallthrough */
        } else {
          return;
        }
      }
      if (configRepoPath && (action === "scan" || !ref)) {
        const resources = await loadResources(
          path.join(configRepoPath, "resources.yaml"),
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
