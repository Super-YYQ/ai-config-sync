import type {
  LocalConfig,
  Plan,
  RiskLevel,
  TargetTool,
} from "@ai-config-sync/core";

export interface EngineContext {
  home: string;
  configRepoPath: string;
  localConfig: LocalConfig;
  profileName: string;
  dryRun?: boolean;
  yes?: boolean;
  allowRisk?: RiskLevel;
  sourceRoots?: Record<string, string>;
  /** Fetch/update cached sources (for update command). */
  updateSources?: boolean;
  offline?: boolean;
}

/** Group key for apply — never join with characters that appear in resource ids. */
export interface ResourceTargetKey {
  resourceId: string;
  target: TargetTool | "_";
}

export interface ApplyResult {
  plan: Plan;
  applied: string[];
  failed: Array<{ actionId: string; error: string }>;
  manual: string[];
  backupId?: string;
  noChanges: boolean;
  /** True if a failure triggered automatic rollback of this apply. */
  autoRolledBack?: boolean;
}
