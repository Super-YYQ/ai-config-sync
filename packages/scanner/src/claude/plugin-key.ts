/**
 * Claude plugin key helpers: parse "plugin@marketplace" ids.
 */

export interface ParsedPluginKey {
  pluginName: string;
  marketplaceName?: string;
}

/** Split on the last `@` so names with special chars stay intact. */
export function parseClaudePluginKey(value: string): ParsedPluginKey {
  const v = value.trim();
  if (!v || v === "@") return { pluginName: v };
  if (v.startsWith("@") && !v.slice(1).includes("@")) {
    return { pluginName: v };
  }
  const index = v.lastIndexOf("@");
  if (index <= 0 || index === v.length - 1) {
    return { pluginName: v };
  }
  return {
    pluginName: v.slice(0, index),
    marketplaceName: v.slice(index + 1),
  };
}

export function formatClaudePluginKey(
  pluginName: string,
  marketplaceName?: string,
): string {
  return marketplaceName ? `${pluginName}@${marketplaceName}` : pluginName;
}

/** Normalize github / ssh git URLs to owner/repo. */
export function normalizeGitRepositoryUrl(url: string): {
  provider?: "github" | "git";
  repository?: string;
  url?: string;
} {
  const raw = url.trim().replace(/\.git$/i, "");
  let m =
    raw.match(/github\.com[:/]([^/\s]+\/[^/\s]+)/i) ||
    raw.match(/ssh:\/\/git@github\.com\/([^/\s]+\/[^/\s]+)/i);
  if (m) {
    return {
      provider: "github",
      repository: m[1]!.replace(/\.git$/i, ""),
      url: raw,
    };
  }
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(raw)) {
    return { provider: "github", repository: raw, url: raw };
  }
  return { provider: "git", url: raw };
}
