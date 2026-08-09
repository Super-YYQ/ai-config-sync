import type { LocalConfig } from "@ai-config-sync/core";

export type SetupMode = "default" | "plan" | "repair" | "reconfigure";

export interface SetupOptions {
  home?: string;
  configPath?: string;
  repo?: string;
  profile?: string;
  mode?: SetupMode;
  claude?: boolean;
  codex?: boolean;
  /** Explicitly install Codex SessionStart hook + features.hooks. */
  enableCodexHook?: boolean;
  /** Print planned file creates/modifies before applying. */
  preview?: boolean;
  /** Absolute package root. Auto-detected when possible. */
  programRoot?: string;
  /** Opt in to a local directory marketplace for offline development. */
  allowLocalPluginInstall?: boolean;
  /** Skip installing the Claude plugin when already running inside it. */
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
