export type {
  IntegrationInstallResult,
  SetupMode,
  SetupOptions,
  SetupResult,
  SetupStatus,
} from "./setup-types.js";
export {
  detectPackageRoot,
  detectPluginRoot,
  isRunningInsideSelfPlugin,
} from "./setup-discovery.js";
export { installStableCliShim } from "./setup-integrations.js";
export { runSetup } from "./setup-orchestrator.js";
