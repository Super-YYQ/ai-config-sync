/**
 * Managed Config Field Policy (Ticket 5).
 *
 * Recipes may only write a fixed set of managed fields into tool config files.
 * This blocks generic recipes from flipping model/auth/sandbox or planting
 * arbitrary hooks while still allowing the managed toggles this tool owns
 * (features.hooks for Codex config.toml, managed SessionStart hook entries).
 */
import path from "node:path";

/**
 * Allowed `merge-toml` paths for Codex config.toml, expressed as
 * dotted "section.key" or just "section" (whole managed section).
 * Anything not in this set is rejected before any write.
 */
const MANAGED_TOML_FIELDS: ReadonlySet<string> = new Set([
  // Codex config.toml: this tool manages the hooks feature flag only.
  "features.hooks",
  // Allow enabling/disabling the managed tooling - nothing sensitive.
  "features.skills",
]);

/**
 * Forbidden TOML sections/keys regardless of recipe. These cover auth,
 * model selection, sandbox/security policy - never writable by a recipe.
 */
const FORBIDDEN_TOML_FIELDS: ReadonlySet<string> = new Set([
  "model",
  "auth",
  "sandbox",
  "security",
  "approval",
  "credentials",
  "api_key",
  "api_keys",
  "tools.web_search",
  "network",
]);

export interface FieldPolicyResult {
  allowed: boolean;
  reason?: string;
}

/** Normalize a dotted toml path: trim, lowercase, strip surrounding brackets. */
function normalizeField(p: string): string {
  return p
    .trim()
    .replace(/^\[|\]$/g, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

/**
 * Decide whether a `merge-toml` op.path (e.g. "features.hooks") is permitted.
 * The driver calls this before formatting/writing config.toml.
 */
export function checkTomlFieldPolicy(dottedPath: string): FieldPolicyResult {
  const norm = normalizeField(dottedPath);
  if (!norm) {
    return { allowed: false, reason: "empty config field path" };
  }
  // Exact forbidden (e.g. "model", "auth", "sandbox")
  if (FORBIDDEN_TOML_FIELDS.has(norm)) {
    return {
      allowed: false,
      reason: `config field "${dottedPath}" is forbidden (auth/model/sandbox)`,
    };
  }
  // Forbidden section prefix: "model.x", "auth.x", "sandbox.x"
  for (const f of FORBIDDEN_TOML_FIELDS) {
    if (norm.startsWith(`${f}.`)) {
      return {
        allowed: false,
        reason: `config field "${dottedPath}" is under forbidden section ${f}`,
      };
    }
  }
  if (MANAGED_TOML_FIELDS.has(norm)) {
    return { allowed: true };
  }
  // Section-level managed allow: if the whole section is managed, allow its
  // registered keys. Here we only allow exact managed entries.
  return {
    allowed: false,
    reason: `config field "${dottedPath}" is not in the managed allowlist`,
  };
}

/**
 * Allowed `merge-json` destination files + owned paths.
 *
 * hooks.json writes are routed through the dedicated Managed Entry merge
 * (mergeHookManifest), not generic merge-json. A generic merge-json op may
 * only target files this tool manages, and only the owned paths listed.
 */
const MANAGED_JSON_DESTINATIONS: ReadonlySet<string> = new Set([]);

/** Dot-paths a generic merge-json may write, keyed by destination basename. */
const MANAGED_JSON_OWNED: Record<string, ReadonlySet<string>> = {
  // Reserved for future managed json files; hooks.json handled separately.
};

export interface JsonFieldPolicyResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Decide whether a `merge-json` op targeting `dest` (absolute path) with a
 * given managed object is permitted. Generic merge-json must be denied for
 * arbitrary tool files; managed hook manifests go through the dedicated path.
 */
export function checkJsonFieldPolicy(dest: string): JsonFieldPolicyResult {
  const base = path.basename(dest).toLowerCase();
  // hooks.json is owned by merge-hook-manifest (dedicated managed merge) -
  // generic merge-json must not touch it.
  if (base === "hooks.json" || base === "config.json") {
    return {
      allowed: false,
      reason: `${base} must be updated via the managed hook-manifest merge, not merge-json`,
    };
  }
  // auth/settings/session files are forbidden (defense in depth; path security
  // already blocks these, but the policy layer rejects the recipe too).
  if (
    base === "auth.json" ||
    base === "settings.json" ||
    base === "session.json" ||
    base === "credentials.json"
  ) {
    return {
      allowed: false,
      reason: `${base} is a forbidden config file (auth/session)`,
    };
  }
  if (MANAGED_JSON_DESTINATIONS.size === 0 && !(base in MANAGED_JSON_OWNED)) {
    return {
      allowed: false,
      reason: `merge-json target ${base} is not a managed config file`,
    };
  }
  return { allowed: true };
}

/** Managed entry ids allowed in hooks.json (SessionStart managed by this tool). */
const MANAGED_HOOK_ENTRY_IDS: ReadonlySet<string> = new Set([
  "ai-config-sync-session-start",
  "config-sync-session-start",
]);

export function isManagedHookEntryId(id: string): boolean {
  return MANAGED_HOOK_ENTRY_IDS.has(id.toLowerCase());
}

export const MANAGED_TOML_FIELD_LIST = [...MANAGED_TOML_FIELDS];
export const FORBIDDEN_TOML_FIELD_LIST = [...FORBIDDEN_TOML_FIELDS];
