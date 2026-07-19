/**
 * Safe filesystem keys derived from logical resource ids.
 * Logical ids may contain `:` or other characters unsafe as Windows filenames.
 * Never use the raw id as a path segment.
 */
import crypto from "node:crypto";
import path from "node:path";

/** Windows reserved device names (case-insensitive). */
const WIN_RESERVED = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "COM1",
  "COM2",
  "COM3",
  "COM4",
  "COM5",
  "COM6",
  "COM7",
  "COM8",
  "COM9",
  "LPT1",
  "LPT2",
  "LPT3",
  "LPT4",
  "LPT5",
  "LPT6",
  "LPT7",
  "LPT8",
  "LPT9",
]);

/**
 * Convert a logical resource id into a filesystem-safe storage key.
 * Always appends a short content hash to avoid cross-platform collisions
 * (case folding, reserved names, Unicode normalization, trailing dots).
 *
 * Examples:
 *   hooks:SessionStart → hooks_SessionStart-a83f91
 *   my-skill → my-skill-e3b0c4
 *   CON → _CON-...
 *   ../evil → evil-...
 */
export function toStorageKey(id: string): string {
  const hash = crypto.createHash("sha256").update(id).digest("hex").slice(0, 6);

  // NFKC normalize to collapse compatibility variants
  let key = id.normalize("NFKC");

  // Replace path separators and Windows-forbidden characters
  key = key
    .replace(/[\/\\]/g, "_")
    .replace(/[<>:"|?*\x00-\x1f]/g, "_")
    .replace(/\.\./g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");

  // Strip trailing dots/spaces (Windows forbids)
  key = key.replace(/[.\s]+$/g, "");

  // Lowercase for case-insensitive FS collision safety in the stem
  // Keep readability by only lowercasing when mixed case would collide — always
  // append hash so we can keep original casing for human readability.
  if (!key) key = "resource";

  // Prefix reserved Windows device names
  const stem = key.split(/[._-]/)[0] ?? key;
  if (WIN_RESERVED.has(stem.toUpperCase()) || WIN_RESERVED.has(key.toUpperCase())) {
    key = `_${key}`;
  }

  if (key.length > 80) key = key.slice(0, 80).replace(/[.\s]+$/g, "");

  // Always append short hash for cross-platform uniqueness
  if (!key.endsWith(`-${hash}`)) {
    key = `${key}-${hash}`;
  }
  return key;
}

/** Relative recipe path under a config repo for a logical resource id. */
export function recipeRelPath(id: string): string {
  return `recipes/${toStorageKey(id)}.yaml`;
}

/** Relative vendored skill path under a config repo. */
export function vendorSkillRelPath(id: string): string {
  return `sources/skills/${toStorageKey(id)}`;
}


/** Assert a relative path under root is safe (no abs / traversal). */
export function assertSafeRelPath(rel: string): string {
  if (!rel) throw new Error("empty relative path");
  if (path.isAbsolute(rel)) {
    throw new Error(`absolute path rejected: ${rel}`);
  }
  const norm = rel.replace(/\\/g, "/");
  if (norm.split("/").some((p) => p === "..")) {
    throw new Error(`path traversal rejected: ${rel}`);
  }
  if (norm.startsWith("/") || /^[A-Za-z]:/.test(norm)) {
    throw new Error(`absolute path rejected: ${rel}`);
  }
  return norm;
}
