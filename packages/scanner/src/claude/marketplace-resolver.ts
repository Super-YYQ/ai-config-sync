/**
 * Resolve Claude marketplace plugin inventory from multiple state files.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { claudePluginsDir, claudeSettingsPath, pathExists } from "@ai-config-sync/core";
import {
  formatClaudePluginKey,
  normalizeGitRepositoryUrl,
  parseClaudePluginKey,
} from "./plugin-key.js";

export type PluginResolutionStatus =
  | "resolved"
  | "partially-resolved"
  | "unresolved";

export interface PluginEvidence {
  from: string;
  detail?: string;
}

export interface ClaudePluginInventoryItem {
  canonicalId: string;
  pluginName: string;
  marketplaceName?: string;
  marketplaceRepository?: string;
  version?: string;
  enabled?: boolean;
  installPath?: string;
  evidence: PluginEvidence[];
  confidence: number;
  resolutionStatus: PluginResolutionStatus;
}

export interface NormalizedInstalledPlugin {
  id: string;
  pluginName: string;
  marketplaceName?: string;
  version?: string;
  enabled?: boolean;
  installPath?: string;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Parse installed_plugins.json in several known shapes. */
export function parseInstalledPlugins(raw: unknown): {
  items: NormalizedInstalledPlugin[];
  warning?: string;
} {
  const items: NormalizedInstalledPlugin[] = [];
  if (raw == null) return { items };

  const push = (idRaw: string, extra: Partial<NormalizedInstalledPlugin> = {}) => {
    const parsed = parseClaudePluginKey(idRaw);
    const id = formatClaudePluginKey(parsed.pluginName, parsed.marketplaceName);
    items.push({
      id,
      pluginName: parsed.pluginName,
      marketplaceName: parsed.marketplaceName ?? extra.marketplaceName,
      version: extra.version,
      enabled: extra.enabled,
      installPath: extra.installPath,
    });
  };

  try {
    if (Array.isArray(raw)) {
      for (const entry of raw) {
        if (!isPlainObject(entry)) continue;
        const id = String(entry.id ?? entry.name ?? "");
        if (!id) continue;
        push(id, {
          marketplaceName:
            typeof entry.marketplace === "string" ? entry.marketplace : undefined,
          version: typeof entry.version === "string" ? entry.version : undefined,
          enabled: typeof entry.enabled === "boolean" ? entry.enabled : undefined,
          installPath:
            typeof entry.path === "string"
              ? entry.path
              : typeof entry.installPath === "string"
                ? entry.installPath
                : undefined,
        });
      }
      return { items };
    }

    if (isPlainObject(raw) && Array.isArray(raw.plugins)) {
      return parseInstalledPlugins(raw.plugins);
    }

    if (isPlainObject(raw)) {
      for (const [key, val] of Object.entries(raw)) {
        if (key === "version" || key === "plugins") continue;
        if (typeof val === "boolean") {
          push(key, { enabled: val });
          continue;
        }
        if (isPlainObject(val)) {
          push(key, {
            marketplaceName:
              typeof val.marketplace === "string" ? val.marketplace : undefined,
            version: typeof val.version === "string" ? val.version : undefined,
            enabled: typeof val.enabled === "boolean" ? val.enabled : undefined,
            installPath:
              typeof val.installPath === "string"
                ? val.installPath
                : typeof val.path === "string"
                  ? val.path
                  : undefined,
          });
        }
      }
      return { items };
    }

    return { items, warning: "installed_plugins.json: unrecognized shape" };
  } catch (e) {
    return {
      items: [],
      warning: `installed_plugins.json parse error: ${(e as Error).message}`,
    };
  }
}

async function readGitHubRemote(repoDir: string): Promise<string | undefined> {
  const gitCfg = path.join(repoDir, ".git", "config");
  if (!(await pathExists(gitCfg))) return undefined;
  try {
    const text = await fs.readFile(gitCfg, "utf8");
    const m = text.match(
      /url\s*=\s*(.+)/i,
    );
    if (!m?.[1]) return undefined;
    const n = normalizeGitRepositoryUrl(m[1].trim());
    return n.repository;
  } catch {
    return undefined;
  }
}

async function loadKnownMarketplaces(
  home: string,
): Promise<
  Map<
    string,
    { installLocation?: string; repository?: string; sourceType?: string }
  >
> {
  const map = new Map<
    string,
    { installLocation?: string; repository?: string; sourceType?: string }
  >();
  const knownPath = path.join(
    claudePluginsDir(home),
    "known_marketplaces.json",
  );
  if (!(await pathExists(knownPath))) return map;
  try {
    const raw = JSON.parse(await fs.readFile(knownPath, "utf8")) as Record<
      string,
      unknown
    >;
    for (const [name, val] of Object.entries(raw)) {
      if (!isPlainObject(val)) continue;
      const installLocation =
        typeof val.installLocation === "string"
          ? val.installLocation
          : typeof val.path === "string"
            ? val.path
            : undefined;
      let repository: string | undefined;
      const source = val.source;
      if (isPlainObject(source)) {
        if (typeof source.repo === "string") repository = source.repo;
        else if (typeof source.url === "string") {
          repository = normalizeGitRepositoryUrl(source.url).repository;
        } else if (typeof source.path === "string" && installLocation) {
          // local directory marketplace
        }
      }
      if (!repository && installLocation) {
        repository = await readGitHubRemote(installLocation);
      }
      map.set(name, {
        installLocation,
        repository,
        sourceType: isPlainObject(source)
          ? String(source.source ?? source.type ?? "")
          : undefined,
      });
    }
  } catch {
    /* ignore */
  }
  return map;
}

/**
 * Build unified Claude plugin inventory from settings + installed + marketplaces.
 */
export async function resolveClaudePluginInventory(
  home: string,
): Promise<{ items: ClaudePluginInventoryItem[]; warnings: string[] }> {
  const warnings: string[] = [];
  const byId = new Map<string, ClaudePluginInventoryItem>();

  const ensure = (
    pluginName: string,
    marketplaceName: string | undefined,
  ): ClaudePluginInventoryItem => {
    const canonicalId = formatClaudePluginKey(pluginName, marketplaceName);
    let item = byId.get(canonicalId);
    if (!item) {
      item = {
        canonicalId,
        pluginName,
        marketplaceName,
        evidence: [],
        confidence: 0.4,
        resolutionStatus: "unresolved",
      };
      byId.set(canonicalId, item);
    }
    return item;
  };

  // 1) settings enabledPlugins
  const settingsPath = claudeSettingsPath(home);
  if (await pathExists(settingsPath)) {
    try {
      const settings = JSON.parse(await fs.readFile(settingsPath, "utf8")) as {
        enabledPlugins?: Record<string, boolean>;
      };
      for (const [key, enabled] of Object.entries(settings.enabledPlugins ?? {})) {
        const parsed = parseClaudePluginKey(key);
        const item = ensure(parsed.pluginName, parsed.marketplaceName);
        item.enabled = enabled;
        item.evidence.push({ from: "settings.json", detail: key });
      }
    } catch {
      warnings.push("settings.json: failed to parse enabledPlugins");
    }
  }

  // 2) installed_plugins.json
  const installedPath = path.join(
    claudePluginsDir(home),
    "installed_plugins.json",
  );
  if (await pathExists(installedPath)) {
    try {
      const raw = JSON.parse(await fs.readFile(installedPath, "utf8"));
      const { items, warning } = parseInstalledPlugins(raw);
      if (warning) warnings.push(warning);
      for (const p of items) {
        const item = ensure(p.pluginName, p.marketplaceName);
        if (p.version) item.version = p.version;
        if (p.installPath) item.installPath = p.installPath;
        if (typeof p.enabled === "boolean") item.enabled = p.enabled;
        item.evidence.push({ from: "installed_plugins.json", detail: p.id });
        item.confidence = Math.max(item.confidence, 0.7);
      }
    } catch {
      warnings.push("installed_plugins.json: unreadable");
    }
  }

  // 3) known marketplaces + git remotes
  const known = await loadKnownMarketplaces(home);
  for (const item of byId.values()) {
    if (!item.marketplaceName) continue;
    const m = known.get(item.marketplaceName);
    if (!m) continue;
    if (m.repository) {
      item.marketplaceRepository = m.repository;
      item.confidence = Math.max(item.confidence, 0.95);
    }
    if (m.installLocation && !item.installPath) {
      item.installPath = m.installLocation;
    }
    item.evidence.push({
      from: "known_marketplaces.json",
      detail: item.marketplaceName,
    });
  }

  // 4) Also scan marketplace dirs for remotes not in known (fill gaps)
  const marketplacesDir = path.join(claudePluginsDir(home), "marketplaces");
  if (await pathExists(marketplacesDir)) {
    try {
      const names = await fs.readdir(marketplacesDir);
      for (const name of names) {
        const mPath = path.join(marketplacesDir, name);
        const st = await fs.stat(mPath).catch(() => null);
        if (!st?.isDirectory()) continue;
        const repo = await readGitHubRemote(mPath);
        if (!repo) continue;
        for (const item of byId.values()) {
          if (item.marketplaceName === name && !item.marketplaceRepository) {
            item.marketplaceRepository = repo;
            item.installPath = item.installPath ?? mPath;
            item.confidence = Math.max(item.confidence, 0.92);
            item.evidence.push({ from: "marketplace-git-remote", detail: repo });
          }
        }
      }
    } catch {
      /* ignore */
    }
  }

  // Finalize resolution status
  for (const item of byId.values()) {
    if (item.marketplaceRepository && item.marketplaceName) {
      item.resolutionStatus = "resolved";
      item.confidence = Math.max(item.confidence, 0.95);
    } else if (item.marketplaceName) {
      item.resolutionStatus = "partially-resolved";
      item.confidence = Math.max(item.confidence, 0.6);
    } else {
      item.resolutionStatus = "unresolved";
    }
  }

  return { items: [...byId.values()], warnings };
}
