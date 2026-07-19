/**
 * Precise Claude plugin install/enable status from `claude plugin list --json`.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { claudeExecutable } from "@ai-config-sync/core";

const execFileAsync = promisify(execFile);

export interface ClaudePluginListEntry {
  id: string;
  version?: string;
  scope?: string;
  enabled?: boolean;
  installPath?: string;
}

export interface ClaudePluginStatus {
  installed: boolean;
  enabled: boolean;
  entry?: ClaudePluginListEntry;
  /** How status was resolved */
  source: "json" | "text-fallback" | "unavailable";
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Normalize plugin@marketplace id comparisons. */
export function pluginIdsEqual(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Parse `claude plugin list --json` output into entries.
 * Accepts array root, {plugins:[]}, or {installed:[]}.
 */
export function parseClaudePluginListJson(raw: unknown): ClaudePluginListEntry[] {
  const out: ClaudePluginListEntry[] = [];
  const push = (item: unknown) => {
    if (!isPlainObject(item)) return;
    const id = String(item.id ?? item.name ?? "");
    if (!id) return;
    out.push({
      id,
      version: typeof item.version === "string" ? item.version : undefined,
      scope: typeof item.scope === "string" ? item.scope : undefined,
      enabled:
        typeof item.enabled === "boolean"
          ? item.enabled
          : typeof item.status === "string"
            ? /enabled/i.test(item.status)
            : undefined,
      installPath:
        typeof item.installPath === "string"
          ? item.installPath
          : typeof item.path === "string"
            ? item.path
            : undefined,
    });
  };

  if (Array.isArray(raw)) {
    for (const item of raw) push(item);
    return out;
  }
  if (isPlainObject(raw)) {
    if (Array.isArray(raw.plugins)) {
      for (const item of raw.plugins) push(item);
      return out;
    }
    if (Array.isArray(raw.installed)) {
      for (const item of raw.installed) push(item);
      return out;
    }
  }
  return out;
}

export function findPluginStatus(
  entries: ClaudePluginListEntry[],
  pluginId: string,
  pluginName?: string,
): ClaudePluginStatus {
  const exact = entries.find((e) => pluginIdsEqual(e.id, pluginId));
  if (exact) {
    return {
      installed: true,
      enabled: exact.enabled === true,
      entry: exact,
      source: "json",
    };
  }
  // When looking up by bare name (no @), match name@marketplace full ids only
  const bareName =
    !pluginId.includes("@")
      ? pluginId
      : pluginName && pluginName !== pluginId
        ? pluginName
        : undefined;
  if (bareName) {
    const byNameOnly = entries.find((e) =>
      e.id.toLowerCase().startsWith(bareName.toLowerCase() + "@"),
    );
    if (byNameOnly) {
      return {
        installed: true,
        enabled: byNameOnly.enabled === true,
        entry: byNameOnly,
        source: "json",
      };
    }
  }
  return { installed: false, enabled: false, source: "json" };
}

/**
 * Query local Claude CLI for plugin status. Prefers --json; falls back carefully.
 */
export async function queryClaudePluginStatus(
  pluginId: string,
  pluginName?: string,
): Promise<ClaudePluginStatus> {
  try {
    const listOut = await execFileAsync(
      claudeExecutable(),
      ["plugin", "list", "--json"],
      {
        windowsHide: true,
        maxBuffer: 5 * 1024 * 1024,
        encoding: "utf8",
      },
    );
    const text = `${listOut.stdout ?? ""}`.trim();
    if (text) {
      try {
        const parsed = JSON.parse(text) as unknown;
        const entries = parseClaudePluginListJson(parsed);
        return findPluginStatus(entries, pluginId, pluginName);
      } catch {
        /* fall through to text */
      }
    }
  } catch {
    /* try without .cmd / json */
  }

  // Retry plain `claude` on windows if .cmd path failed
  try {
    const listOut = await execFileAsync("claude", ["plugin", "list", "--json"], {
      windowsHide: true,
      maxBuffer: 5 * 1024 * 1024,
      encoding: "utf8",
      shell: process.platform === "win32",
    });
    const text = `${listOut.stdout ?? ""}`.trim();
    const parsed = JSON.parse(text) as unknown;
    const entries = parseClaudePluginListJson(parsed);
    return findPluginStatus(entries, pluginId, pluginName);
  } catch {
    /* unavailable */
  }

  // Last resort: non-json list — require full pluginId as a standalone token
  try {
    const listOut = await execFileAsync("claude", ["plugin", "list"], {
      windowsHide: true,
      maxBuffer: 5 * 1024 * 1024,
      encoding: "utf8",
      shell: process.platform === "win32",
    });
    const text = `${listOut.stdout ?? ""}${listOut.stderr ?? ""}`;
    // Line-oriented match for full id to avoid "code" matching "code-review"
    const lines = text.split(/\r?\n/);
    const idLower = pluginId.toLowerCase();
    for (const line of lines) {
      const lower = line.toLowerCase();
      if (lower.includes(idLower)) {
        // require word-ish boundaries around full id
        const re = new RegExp(
          `(^|[^A-Za-z0-9_@.-])${pluginId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z0-9_@.-]|$)`,
          "i",
        );
        if (re.test(line)) {
          return {
            installed: true,
            enabled: /enabled|✔|✓/i.test(line),
            source: "text-fallback",
          };
        }
      }
    }
    return { installed: false, enabled: false, source: "text-fallback" };
  } catch {
    return { installed: false, enabled: false, source: "unavailable" };
  }
}
