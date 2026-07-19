/**
 * Resolve the Claude Code CLI executable for the current platform.
 * On Windows the shim is typically `claude.cmd` (not bare `claude`).
 */
export function claudeExecutable(): string {
  return process.platform === "win32" ? "claude.cmd" : "claude";
}
