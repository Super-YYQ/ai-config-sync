import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Expand ~ and normalize separators. */
export function expandHome(input: string, home = os.homedir()): string {
  if (!input) return input;
  if (input === "~") return home;
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(home, input.slice(2));
  }
  return input;
}

/** Normalize a path for comparison (absolute, resolved, forward slashes lowercased on win). */
export function normalizePath(input: string, home = os.homedir()): string {
  const expanded = expandHome(input, home);
  const resolved = path.resolve(expanded);
  // Keep platform separators for FS ops; for compare use posix-ish lower form on win
  if (process.platform === "win32") {
    return resolved.replace(/\\/g, "/").toLowerCase();
  }
  return resolved;
}

export function pathsEqual(a: string, b: string, home = os.homedir()): boolean {
  return normalizePath(a, home) === normalizePath(b, home);
}

/** Default local state root: ~/.ai-config-sync */
export function defaultStateRoot(home = os.homedir()): string {
  return path.join(home, ".ai-config-sync");
}

export function localConfigPath(home = os.homedir()): string {
  return path.join(defaultStateRoot(home), "config.yaml");
}

export function localStatePath(home = os.homedir()): string {
  return path.join(defaultStateRoot(home), "state.json");
}

export function localOverridesPath(home = os.homedir()): string {
  return path.join(defaultStateRoot(home), "local.yaml");
}

export function pendingEventsPath(home = os.homedir()): string {
  return path.join(defaultStateRoot(home), "pending-events.json");
}

export function backupsDir(home = os.homedir()): string {
  return path.join(defaultStateRoot(home), "backups");
}

export function cacheDir(home = os.homedir()): string {
  return path.join(defaultStateRoot(home), "cache");
}

export function logsDir(home = os.homedir()): string {
  return path.join(defaultStateRoot(home), "logs");
}

/** Claude Code user dirs (best-effort defaults). */
export function claudeHome(home = os.homedir()): string {
  return path.join(home, ".claude");
}

export function claudeSkillsDir(home = os.homedir()): string {
  return path.join(claudeHome(home), "skills");
}

export function claudePluginsDir(home = os.homedir()): string {
  return path.join(claudeHome(home), "plugins");
}

export function claudeSettingsPath(home = os.homedir()): string {
  return path.join(claudeHome(home), "settings.json");
}

/** Codex user dirs (best-effort defaults). */
export function codexHome(home = os.homedir()): string {
  return process.env.CODEX_HOME
    ? expandHome(process.env.CODEX_HOME, home)
    : path.join(home, ".codex");
}

/**
 * Preferred user-level skill directories for Codex / agents ecosystem.
 * Write default: ~/.agents/skills
 * Also scan legacy ~/.codex/skills
 */
export function agentsSkillsDir(home = os.homedir()): string {
  return path.join(home, ".agents", "skills");
}

export function codexSkillsDir(home = os.homedir()): string {
  // Prefer modern agents location for *writes*; callers that need all scan roots use listCodexSkillRoots
  return agentsSkillsDir(home);
}

/** All directories that may contain Codex/agent skills (dedupe by caller). */
export function listCodexSkillRoots(home = os.homedir()): Array<{
  path: string;
  legacy: boolean;
  label: string;
}> {
  const roots: Array<{ path: string; legacy: boolean; label: string }> = [
    { path: agentsSkillsDir(home), legacy: false, label: "agents" },
  ];
  const legacy = path.join(codexHome(home), "skills");
  if (normalizePath(legacy, home) !== normalizePath(agentsSkillsDir(home), home)) {
    roots.push({ path: legacy, legacy: true, label: "codex-legacy" });
  }
  return roots;
}

export function codexHooksDir(home = os.homedir()): string {
  return path.join(codexHome(home), "hooks");
}

export function codexHooksManifestPath(home = os.homedir()): string {
  return path.join(codexHome(home), "hooks.json");
}

export function codexConfigPath(home = os.homedir()): string {
  return path.join(codexHome(home), "config.toml");
}

/** Safe relative path under a root; throws on traversal. */
export function safeJoin(root: string, ...segments: string[]): string {
  const joined = path.resolve(root, ...segments);
  const normalizedRoot = path.resolve(root);
  const rel = path.relative(normalizedRoot, joined);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path traversal blocked: ${segments.join("/")}`);
  }
  return joined;
}

export function isUnder(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** module dirname helper for ESM. */
export function dirnameFromImportMeta(metaUrl: string): string {
  return path.dirname(fileURLToPath(metaUrl));
}
