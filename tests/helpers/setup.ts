import {
  runSetup,
  type SetupOptions,
  type SetupResult,
} from "../../packages/cli/src/setup.js";

/**
 * Preserve Claude as a target while preventing tests from discovering and
 * invoking the operator's real Claude CLI or plugin installation.
 */
export function runIsolatedSetup(
  options: SetupOptions,
): Promise<SetupResult> {
  return runSetup({
    ...options,
    claude: options.claude ?? true,
    codex: options.codex ?? true,
    skipSelfPluginInstall: true,
  });
}
