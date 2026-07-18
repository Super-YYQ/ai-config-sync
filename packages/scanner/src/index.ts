import fs from "node:fs/promises";
import path from "node:path";
import {
  claudePluginsDir,
  claudeSettingsPath,
  claudeSkillsDir,
  codexConfigPath,
  codexHooksDir,
  codexHooksManifestPath,
  listCodexSkillRoots,
  hashDirectory,
  isSelfManagedResourceId,
  listDirNames,
  pathExists,
  shortHash,
  type TargetTool,
} from "@ai-config-sync/core";
import { resolveClaudePluginInventory } from "./claude/marketplace-resolver.js";
import { isSystemSkillDirectory } from "./system-skills.js";
export { parseClaudePluginKey, formatClaudePluginKey, normalizeGitRepositoryUrl } from "./claude/plugin-key.js";
export { isSystemSkillDirectory, isNeverCapturableResource } from "./system-skills.js";
export { resolveClaudePluginInventory, parseInstalledPlugins } from "./claude/marketplace-resolver.js";

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
  home: string,
): Promise<{ candidate?: string; confidence: number; meta: Record<string, unknown> }> {
  const meta: Record<string, unknown> = {};
  // skills-lock / agents lock (npx skills)
  for (const lockRel of [
    path.join(home, ".agents", ".skill-lock.json"),
    path.join(home, ".agents", "skills-lock.json"),
    path.join(skillDir, "skills-lock.json"),
    path.join(skillDir, "..", "skills-lock.json"),
  ]) {
    if (!(await pathExists(lockRel))) continue;
    try {
      const raw = JSON.parse(await fs.readFile(lockRel, "utf8")) as Record<
        string,
        unknown
      >;
      const name = path.basename(skillDir);
      const skills = raw.skills as
        | Record<string, Record<string, unknown>>
        | undefined;
      const entry =
        (skills && skills[name]) ||
        (raw[name] as Record<string, unknown> | undefined);
      if (entry) {
        const repo =
          (entry.repository as string | undefined) ||
          (entry.repo as string | undefined) ||
          (typeof entry.source === "string" ? entry.source : undefined);
        if (repo) {
          return {
            candidate: String(repo)
              .replace(/^https?:\/\/github\.com\//, "")
              .replace(/\.git$/, ""),
            confidence: 0.93,
            meta: { ...meta, from: "skills-lock", lock: lockRel },
          };
        }
      }
    } catch {
      /* ignore */
    }
  }

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
  const home = options.home ?? process.env.HOME ?? process.env.USERPROFILE ?? "";
  for (const name of names) {
    if (isSelfManagedResourceId(name)) continue;
    const full = path.join(dir, name);

    // Codex .system and other tool-managed directories — never user-capturable
    if (isSystemSkillDirectory(target, name)) {
      out.push({
        id: name,
        kind: "skill",
        target,
        path: full,
        confidence: 1,
        classification: "system-cache",
        metadata: {
          managedBy: target,
          role: "system-skills",
        },
      });
      continue;
    }

    const source = await detectSkillSource(full, home);
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
  const settingsPath = claudeSettingsPath(home);

  // Unified inventory: settings + installed_plugins + known_marketplaces + git remotes
  const { items, warnings } = await resolveClaudePluginInventory(home);
  for (const w of warnings) {
    // surfaced via scanLocal warnings by caller if needed — stash on synthetic
    void w;
  }

  for (const item of items) {
    if (isSelfManagedResourceId(item.canonicalId)) continue;
    if (isSelfManagedResourceId(item.pluginName)) continue;

    const managed =
      (options.managedIds?.has(item.canonicalId) ||
        options.managedIds?.has(item.pluginName)) ??
      false;

    const resolved = item.resolutionStatus === "resolved";
    const partial = item.resolutionStatus === "partially-resolved";

    // Never use settings.json as install source path
    const pathForResource =
      item.installPath ??
      (item.marketplaceName
        ? path.join(pluginsRoot, "marketplaces", item.marketplaceName)
        : pluginsRoot);

    out.push({
      id: item.canonicalId,
      kind: "plugin",
      target: "claude",
      path: pathForResource,
      sourceCandidate: item.marketplaceRepository,
      confidence: item.confidence,
      classification: managed
        ? "managed"
        : resolved
          ? "source-known"
          : "source-unknown",
      metadata: {
        pluginName: item.pluginName,
        marketplace: item.marketplaceName,
        marketplaceRepository: item.marketplaceRepository,
        version: item.version,
        enabled: item.enabled,
        installVia: "claude-marketplace",
        sourceResolutionStatus: item.resolutionStatus,
        evidence: item.evidence,
        // explicit: settings is evidence only, never a source path
        settingsPath: settingsPath,
      },
    });
  }

  // Marketplace cache dirs (for diagnostics) — system-cache, not capture
  const marketplaces = path.join(pluginsRoot, "marketplaces");
  if (await pathExists(marketplaces)) {
    for (const name of await listDirNames(marketplaces)) {
      if (
        isSelfManagedResourceId(name) ||
        isSelfManagedResourceId(`marketplace:${name}`)
      ) {
        continue;
      }
      const mPath = path.join(marketplaces, name);
      let sourceCandidate: string | undefined;
      try {
        const gitCfg = path.join(mPath, ".git", "config");
        if (await pathExists(gitCfg)) {
          const text = await fs.readFile(gitCfg, "utf8");
          const m = text.match(
            /url\s*=\s*(?:git@github\.com:|https:\/\/github\.com\/)([^\s]+)/,
          );
          if (m) sourceCandidate = m[1]!.replace(/\.git$/, "");
        }
      } catch {
        /* ignore */
      }
      out.push({
        id: `marketplace:${name}`,
        kind: "plugin",
        target: "claude",
        path: mPath,
        sourceCandidate,
        confidence: sourceCandidate ? 0.9 : 0.5,
        classification: "system-cache",
        metadata: {
          role: "marketplace-cache",
          marketplace: name,
          marketplaceRepository: sourceCandidate,
          installVia: "claude-marketplace",
        },
      });
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
    const seenSkillIds = new Set<string>();
    for (const root of listCodexSkillRoots(home)) {
      if (!(await pathExists(root.path))) {
        if (!root.legacy) {
          warnings.push(`Codex/agents skills dir not found: ${root.path}`);
        }
        continue;
      }
      const skills = await scanSkills(root.path, "codex", options);
      for (const s of skills) {
        if (seenSkillIds.has(s.id)) continue;
        seenSkillIds.add(s.id);
        s.metadata = {
          ...s.metadata,
          skillRoot: root.path,
          legacy: root.legacy,
          rootLabel: root.label,
        };
        resources.push(s);
      }
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
    if (r.target === "codex" && r.id === ".system") return false;
    return !managedIds.has(r.id) && !r.id.startsWith("marketplace:");
  });
}
