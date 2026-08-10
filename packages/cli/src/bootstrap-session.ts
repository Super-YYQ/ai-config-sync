import os from "node:os";
import {
  expandHome,
  loadLocalConfig,
  localConfigPath,
  pathExists,
  type LocalConfig,
  type Plan,
  type RiskLevel,
} from "@ai-config-sync/core";
import {
  inspectGitSafety,
  pullRepo,
} from "@ai-config-sync/git-sync";
import {
  applyPlan,
  buildPlan,
  runDoctor,
  type ApplyResult,
  type DoctorReport,
} from "@ai-config-sync/recipe-engine";
import { runSetup } from "./setup.js";
import type { SetupOptions, SetupResult } from "./setup-types.js";

export interface BootstrapSessionOptions {
  home?: string;
  programRoot?: string;
}

export interface BootstrapConnection {
  linked: boolean;
  home: string;
  localConfig?: LocalConfig;
  configRepoPath?: string;
}

export interface BootstrapConnectInput {
  repo?: string;
  configPath?: string;
  profile?: string;
  claude?: boolean;
  codex?: boolean;
  enableCodexHook?: boolean;
  reconfigure?: boolean;
}

export interface BootstrapPlanInput {
  profile?: string;
  offline?: boolean;
  pull?: boolean;
}

export interface BootstrapApplyInput {
  allowRisk?: RiskLevel;
  offline?: boolean;
}

/**
 * Shared Bootstrap module used by both CLI and local-Web adapters.
 *
 * The session retains the exact Plan shown to the user. apply() refuses to run
 * until plan() has been called and passes that same immutable Plan object into
 * applyPlan(), whose snapshot checks reject stale repository or recipe state.
 */
export class BootstrapSession {
  readonly home: string;
  readonly programRoot?: string;
  #latestPlan?: Plan;

  constructor(options: BootstrapSessionOptions = {}) {
    this.home = expandHome(options.home ?? os.homedir());
    this.programRoot = options.programRoot;
  }

  async connection(): Promise<BootstrapConnection> {
    const cfgPath = localConfigPath(this.home);
    if (!(await pathExists(cfgPath))) {
      return { linked: false, home: this.home };
    }
    try {
      const localConfig = await loadLocalConfig(cfgPath);
      return {
        linked: true,
        home: this.home,
        localConfig,
        configRepoPath: localConfig.configRepository.localPath,
      };
    } catch {
      return { linked: false, home: this.home };
    }
  }

  async connect(input: BootstrapConnectInput): Promise<SetupResult> {
    const setupOptions: SetupOptions = {
      home: this.home,
      repo: input.repo?.trim() || undefined,
      configPath: input.configPath?.trim() || undefined,
      profile: input.profile?.trim() || "home",
      mode: input.reconfigure ? "reconfigure" : "default",
      claude: input.claude,
      codex: input.codex,
      enableCodexHook: input.enableCodexHook,
      programRoot: this.programRoot,
      preview: true,
    };
    const result = await runSetup(setupOptions);
    this.#latestPlan = undefined;
    return result;
  }

  async plan(input: BootstrapPlanInput = {}): Promise<Plan> {
    const connection = await this.#requireConnection();
    if (input.pull !== false && !input.offline) {
      const safety = await inspectGitSafety(connection.configRepoPath);
      if (safety.canPull) {
        await pullRepo(connection.configRepoPath);
      }
    }
    const plan = await buildPlan({
      home: this.home,
      configRepoPath: connection.configRepoPath,
      localConfig: connection.localConfig,
      profileName: input.profile ?? connection.localConfig.profile,
      offline: input.offline,
    });
    this.#latestPlan = plan;
    return plan;
  }

  latestPlan(): Plan | undefined {
    return this.#latestPlan;
  }

  async apply(input: BootstrapApplyInput = {}): Promise<ApplyResult> {
    if (!this.#latestPlan) {
      throw new Error("No reviewed Bootstrap Plan. Build and review a plan before apply.");
    }
    const connection = await this.#requireConnection();
    const plan = this.#latestPlan;
    const result = await applyPlan(
      {
        home: this.home,
        configRepoPath: connection.configRepoPath,
        localConfig: connection.localConfig,
        profileName: plan.profile,
        yes: true,
        allowRisk: input.allowRisk ?? "medium",
        offline: input.offline,
      },
      plan,
    );
    this.#latestPlan = undefined;
    return result;
  }

  async doctor(): Promise<DoctorReport> {
    const connection = await this.connection();
    return runDoctor({
      home: this.home,
      localConfig: connection.localConfig,
      configRepoPath: connection.configRepoPath,
    });
  }

  async #requireConnection(): Promise<{
    localConfig: LocalConfig;
    configRepoPath: string;
  }> {
    const connection = await this.connection();
    if (!connection.linked || !connection.localConfig || !connection.configRepoPath) {
      throw new Error(
        "No private config repository is linked. Connect a repository before planning restore.",
      );
    }
    return {
      localConfig: connection.localConfig,
      configRepoPath: connection.configRepoPath,
    };
  }
}
