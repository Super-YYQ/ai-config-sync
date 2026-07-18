import fs from "node:fs/promises";
import path from "node:path";
import {
  claudePluginsDir,
  claudeSettingsPath,
  claudeSkillsDir,
  codexConfigPath,
  codexHooksDir,
  codexHooksManifestPath,
  codexSkillsDir,
  hashDirectory,
  isSelfManagedResourceId,
  listDirNames,
  pathExists,
  shortHash,
  type TargetTool,
} from "@ai-config-sync/core";

export type InventoryClassification =
  | "managed"
  | "unmanaged"
  | "source-known"
  | "source-unknown"
  | "modified"
  | "system-cache";

export interface ScannedResource {
  id: string;
  kind: "skill" | "plugin" | "hook" | "instruction" | "config";
  target: TargetTool;
  path: string;
  hash?: string;
  sourceCandidate?: string;
  confidence: number;
  classification: InventoryClassification;
  metadata?: Record<string, unknown>;
}

export interface ScanResult {
  scannedAt: string;
  home: string;
  resources: ScannedResource[];
  warnings: string[];
}

export interface ScanOptions {
  home?: string;
  targets?: { claude?: boolean; codex?: boolean };
  /** Known managed resource ids from private config. */
  managedIds?: Set<string>;
  /** Lightweight: skip directory hashing. */
  light?: boolean;
}

async function detectSkillSource(
  skillDir: string,
): Promise<{ candidate?: string; confidence: number; meta: Record<string, unknown> }> {
  const meta: Record<string, unknown> = {};
  // SKILL.md frontmatter or body often has repository links
  const skillMd = path.join(skillDir, "SKILL.md");
  if (await pathExists(skillMd)) {
    try {
      const text = await fs.readFile(skillMd, "utf8");
      meta.hasSkillMd = true;
      const urlMatch = text.match(
        /https?:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/,
      );
      if (urlMatch) {
        return {
          candidate: urlMatch[1],
          confidence: 0.85,
          meta: { ...meta, from: "SKILL.md" },
        };
      }
      // package.json repository
    } catch {
      /* ignore */
    }
  }

  const pkg = path.join(skillDir, "package.json");
  if (await pathExists(pkg)) {
    try {
      const raw = JSON.parse(await fs.readFile(pkg, "utf8")) as {
        repository?: string | { url?: string };
        name?: string;
      };
      meta.packageName = raw.name;
      const url =
        typeof raw.repository === "string"
          ? raw.repository
          : raw.repository?.url;
      if (url) {
        const m = url.match(/github\.com[:/](.+?)(?:\.git)?$/);
        if (m) {
          return {
            candidate: m[1]!.replace(/\.git$/, ""),
            confidence: 0.9,
            meta: { ...meta, from: "package.json" },
          };
        }
      }
    } catch {
      /* ignore */
    }
  }

  // .git remote
  const gitConfig = path.join(skillDir, ".git", "config");
  if (await pathExists(gitConfig)) {
    try {
      const text = await fs.readFile(gitConfig, "utf8");
      const m = text.match(
        /url\s*=\s*(?:git@github\.com:|https:\/\/github\.com\/)([^\s]+)/,
      );
      if (m) {
        return {
          candidate: m[1]!.replace(/\.git$/, ""),
          confidence: 0.95,
          meta: { ...meta, from: "git-remote" },
        };
      }
    } catch {
      /* ignore */
    }
  }

  // symlink target
  try {
    const st = await fs.lstat(skillDir);
    if (st.isSymbolicLink()) {
      const target = await fs.readlink(skillDir);
      meta.symlinkTarget = target;
      return {
        candidate: undefined,
        confidence: 0.4,
        meta: { ...meta, from: "symlink" },
      };
    }
  } catch {
    /* ignore */
  }

  return { confidence: 0.2, meta };
}

async function scanSkills(
  dir: string,
  target: TargetTool,
  options: ScanOptions,
): Promise<ScannedResource[]> {
  const names = await listDirNames(dir);
  const out: ScannedResource[] = [];
  for (const name of names) {
    if (isSelfManagedResourceId(name)) continue;
    const full = path.join(dir, name);
    const source = await detectSkillSource(full);
    let hash: string | undefined;
    if (!options.light) {
      try {
        hash = shortHash(await hashDirectory(full));
      } catch {
        /* ignore */
      }
    }
    const managed = options.managedIds?.has(name) ?? false;
    out.push({
      id: name,
      kind: "skill",
      target,
      path: full,
      hash,
      sourceCandidate: source.candidate,
      confidence: source.confidence,
      classification: managed
        ? "managed"
        : source.candidate
          ? "source-known"
          : "source-unknown",
      metadata: source.meta,
    });
  }
  return out;
}

async function scanClaudePlugins(
  home: string,
  options: ScanOptions,
): Promise<ScannedResource[]> {
  const out: ScannedResource[] = [];
  const pluginsRoot = claudePluginsDir(home);
  // installed_plugins.json is a common Claude Code layout
  const installedPath = path.join(pluginsRoot, "installed_plugins.json");
  if (await pathExists(installedPath)) {
    try {
      const data = JSON.parse(await fs.readFile(installedPath, "utf8")) as {
        plugins?: Array<{
          name?: string;
          id?: string;
          marketplace?: string;
          version?: string;
          enabled?: boolean;
          path?: string;
        }>;
      };
      for (const p of data.plugins ?? []) {
        const id = p.id ?? p.name ?? "unknown-plugin";
        if (isSelfManagedResourceId(id)) continue;
        const managed = options.managedIds?.has(id) ?? false;
        out.push({
          id,
          kind: "plugin",
          target: "claude",
          path: p.path ?? installedPath,
          sourceCandidate: p.marketplace
            ? `${p.marketplace}/${p.name ?? id}`
            : p.name,
          confidence: p.marketplace ? 0.9 : 0.5,
          classification: managed
            ? "managed"
            : p.marketplace
              ? "source-known"
              : "source-unknown",
          metadata: {
            marketplace: p.marketplace,
            version: p.version,
            enabled: p.enabled,
            from: "installed_plugins.json",
          },
        });
      }
    } catch {
      /* ignore */
    }
  }

  // Also scan marketplaces dir
  const marketplaces = path.join(pluginsRoot, "marketplaces");
  if (await pathExists(marketplaces)) {
    for (const name of await listDirNames(marketplaces)) {
      if (isSelfManagedResourceId(name) || isSelfManagedResourceId(`marketplace:${name}`)) {
        continue;
      }
      out.push({
        id: `marketplace:${name}`,
        kind: "plugin",
        target: "claude",
        path: path.join(marketplaces, name),
        sourceCandidate: name,
        confidence: 0.7,
        classification: "system-cache",
        metadata: { role: "marketplace-cache" },
      });
    }
  }

  // settings.json enabledPlugins
  const settingsPath = claudeSettingsPath(home);
  if (await pathExists(settingsPath)) {
    try {
      const settings = JSON.parse(await fs.readFile(settingsPath, "utf8")) as {
        enabledPlugins?: Record<string, boolean>;
      };
      if (settings.enabledPlugins) {
        for (const [key, enabled] of Object.entries(settings.enabledPlugins)) {
          if (isSelfManagedResourceId(key)) continue;          const existing = out.find((r) => r.id === key || r.id.endsWith(key));
          if (existing) {
            existing.metadata = {
              ...existing.metadata,
              enabledInSettings: enabled,
            };
          } else {
            out.push({
              id: key,
              kind: "plugin",
              target: "claude",
              path: settingsPath,
              confidence: 0.6,
              classification: options.managedIds?.has(key)
                ? "managed"
                : "source-unknown",
              metadata: { enabledInSettings: enabled, from: "settings.json" },
            });
          }
        }
      }
    } catch {
      /* ignore */
    }
  }

  return out;
}

async function scanCodexHooks(
  home: string,
  options: ScanOptions,
): Promise<ScannedResource[]> {
  const out: ScannedResource[] = [];
  const manifestPath = codexHooksManifestPath(home);
  if (await pathExists(manifestPath)) {
    try {
      const raw = JSON.parse(await fs.readFile(manifestPath, "utf8")) as {
        hooks?: unknown;
        [k: string]: unknown;
      };
      // Support either {hooks: [...]} or event-keyed object
      const entries: Array<Record<string, unknown>> = Array.isArray(raw.hooks)
        ? (raw.hooks as Array<Record<string, unknown>>)
        : Array.isArray(raw)
          ? (raw as Array<Record<string, unknown>>)
          : [];

      if (entries.length > 0) {
        for (const entry of entries) {
          const id = String(entry.id ?? entry.name ?? "hook");
          if (isSelfManagedResourceId(id)) continue;
          out.push({
            id,
            kind: "hook",
            target: "codex",
            path: manifestPath,
            confidence: 0.7,
            classification: options.managedIds?.has(id)
              ? "managed"
              : "unmanaged",
            metadata: entry,
          });
        }
      } else {
        // event map style
        for (const [event, value] of Object.entries(raw)) {
          if (event === "hooks") continue;
          if (isSelfManagedResourceId(`hooks:${event}`)) continue;
          out.push({
            id: `hooks:${event}`,
            kind: "hook",
            target: "codex",
            path: manifestPath,
            confidence: 0.6,
            classification: "unmanaged",
            metadata: { event, value },
          });
        }
      }
    } catch {
      /* ignore */
    }
  }

  const hooksDir = codexHooksDir(home);
  for (const name of await listDirNames(hooksDir)) {
    if (isSelfManagedResourceId(name) || isSelfManagedResourceId(`hook-script:${name}`)) {
      continue;
    }
    out.push({
      id: `hook-script:${name}`,
      kind: "hook",
      target: "codex",
      path: path.join(hooksDir, name),
      confidence: 0.5,
      classification: options.managedIds?.has(name) ? "managed" : "unmanaged",
    });
  }

  // note config.toml presence
  const cfg = codexConfigPath(home);
  if (await pathExists(cfg)) {
    out.push({
      id: "codex-config",
      kind: "config",
      target: "codex",
      path: cfg,
      confidence: 1,
      classification: "unmanaged",
      metadata: { role: "config.toml" },
    });
  }

  return out;
}

export async function scanLocal(options: ScanOptions = {}): Promise<ScanResult> {
  const home = options.home ?? process.env.HOME ?? process.env.USERPROFILE ?? "";
  if (!home) throw new Error("Cannot determine home directory");
  const targets = {
    claude: options.targets?.claude ?? true,
    codex: options.targets?.codex ?? true,
  };
  const resources: ScannedResource[] = [];
  const warnings: string[] = [];

  if (targets.claude) {
    const skillsDir = claudeSkillsDir(home);
    if (await pathExists(skillsDir)) {
      resources.push(...(await scanSkills(skillsDir, "claude", options)));
    } else {
      warnings.push(`Claude skills dir not found: ${skillsDir}`);
    }
    resources.push(...(await scanClaudePlugins(home, options)));
  }

  if (targets.codex) {
    const skillsDir = codexSkillsDir(home);
    if (await pathExists(skillsDir)) {
      resources.push(...(await scanSkills(skillsDir, "codex", options)));
    } else {
      warnings.push(`Codex skills dir not found: ${skillsDir}`);
    }
    resources.push(...(await scanCodexHooks(home, options)));
  }

  return {
    scannedAt: new Date().toISOString(),
    home,
    resources,
    warnings,
  };
}

/** Diff scan against managed resource ids → pending-style events. */
export function inventryDiff(
  scan: ScanResult,
  managedIds: Set<string>,
): ScannedResource[] {
  return scan.resources.filter((r) => {
    if (r.kind === "config") return false;
    if (r.classification === "system-cache") return false;
    return !managedIds.has(r.id) && !r.id.startsWith("marketplace:");
  });
}
