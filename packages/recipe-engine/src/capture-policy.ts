import path from "node:path";
import type { Recipe, Resource } from "@ai-config-sync/core";
import {
  isNeverCapturableResource,
  type ScannedResource,
} from "@ai-config-sync/scanner";
import type { CaptureItem } from "./capture-types.js";

/** Tool state files that must never be treated as installable local sources. */
const FORBIDDEN_LOCAL_SOURCE_BASENAMES = new Set([
  "settings.json",
  "installed_plugins.json",
  "known_marketplaces.json",
  "config.toml",
  "hooks.json",
]);

export function isForbiddenLocalSourcePath(p: string | undefined): boolean {
  if (!p) return false;
  const base = path.basename(p).toLowerCase();
  if (FORBIDDEN_LOCAL_SOURCE_BASENAMES.has(base)) return true;
  const norm = p.replace(/\\/g, "/").toLowerCase();
  return (
    norm.endsWith("/.claude/settings.json") ||
    norm.includes("/.claude/plugins/installed_plugins.json") ||
    norm.includes("/.claude/plugins/known_marketplaces.json") ||
    norm.endsWith("/.codex/config.toml") ||
    norm.endsWith("/.codex/hooks.json")
  );
}

function metaString(
  meta: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = meta?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function pluginIdentity(s: ScannedResource): {
  pluginName?: string;
  marketplace?: string;
  marketplaceRepository?: string;
} {
  const pluginName =
    metaString(s.metadata, "pluginName") ||
    (s.id.includes("@") ? s.id.slice(0, s.id.lastIndexOf("@")) : undefined);
  const marketplace =
    metaString(s.metadata, "marketplace") ||
    (s.id.includes("@")
      ? s.id.slice(s.id.lastIndexOf("@") + 1)
      : undefined);
  const marketplaceRepository =
    metaString(s.metadata, "marketplaceRepository") || s.sourceCandidate;
  return { pluginName, marketplace, marketplaceRepository };
}

export function logicalId(s: ScannedResource): string {
  if (s.kind === "skill") return s.id;
  if (s.kind === "plugin") {
    const { pluginName, marketplace } = pluginIdentity(s);
    if (pluginName && marketplace) return `${pluginName}@${marketplace}`;
    if (pluginName) return pluginName;
    if (s.id.includes("@")) return s.id;
  }
  if (s.sourceCandidate) {
    const repo = s.sourceCandidate.replace(/\.git$/i, "");
    const short = repo.includes("/") ? repo.split("/").pop()! : repo;
    if (s.id.includes("@")) return s.id;
    return short || s.id;
  }
  return s.id;
}

export function validateCaptureProposal(item: {
  scanned: ScannedResource;
  suggestedResource: Resource;
  suggestedRecipe?: Recipe;
}): { ok: true } | { ok: false; reason: string } {
  if (isNeverCapturableResource(item.scanned)) {
    return { ok: false, reason: "system-resource-not-capturable" };
  }
  if (item.scanned.kind === "plugin") {
    const { pluginName, marketplace, marketplaceRepository } = pluginIdentity(
      item.scanned,
    );
    const src = item.suggestedResource.source;
    if (src?.provider === "local" && isForbiddenLocalSourcePath(src.path)) {
      return { ok: false, reason: "plugin-marketplace-source-unresolved" };
    }
    if (!pluginName) return { ok: false, reason: "plugin-name-missing" };
    const claude = item.suggestedRecipe?.targets?.claude;
    if (
      claude?.driver === "claude-marketplace" &&
      !marketplace &&
      !marketplaceRepository &&
      !claude.marketplace &&
      !claude.marketplaceRepository
    ) {
      return { ok: false, reason: "plugin-marketplace-source-unresolved" };
    }
    if (
      !marketplaceRepository &&
      !marketplace &&
      metaString(item.scanned.metadata, "sourceResolutionStatus") ===
        "unresolved"
    ) {
      return { ok: false, reason: "plugin-marketplace-source-unresolved" };
    }
    if (!item.scanned.sourceCandidate && !marketplaceRepository) {
      const evidence = item.scanned.metadata?.evidence;
      const onlySettings =
        Array.isArray(evidence) &&
        evidence.length > 0 &&
        evidence.every(
          (entry) =>
            typeof entry === "object" &&
            entry !== null &&
            (entry as { from?: string }).from === "settings.json",
        );
      if (onlySettings || !item.scanned.sourceCandidate) {
        return { ok: false, reason: "plugin-marketplace-source-unresolved" };
      }
    }
  }
  if (
    item.suggestedResource.source?.provider === "local" &&
    isForbiddenLocalSourcePath(item.suggestedResource.source.path)
  ) {
    return { ok: false, reason: "forbidden-local-source" };
  }
  return { ok: true };
}

/** Canonical key to avoid merging unrelated skills from the same monorepo. */
export function groupKey(s: ScannedResource): string {
  const name = logicalId(s);
  const repo = s.sourceCandidate?.replace(/\.git$/i, "") ?? "local";
  return `${repo}::${name}::${s.kind}`;
}

/** Only strictly ready proposals can be auto-confirmed with --yes. */
export function isReadyForAutoCapture(proposal: CaptureItem): boolean {
  if (!proposal.suggestedRecipe) return false;
  if (
    proposal.status === "blocked" ||
    proposal.status === "system-excluded"
  ) {
    return false;
  }
  if (proposal.status === "ready") return true;
  return proposal.status === undefined && !proposal.needsAi;
}
