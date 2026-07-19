/**
 * Safe filesystem keys derived from logical resource ids.
 * Logical ids may contain `:` or other characters unsafe as Windows filenames.
 * Never use the raw id as a path segment.
 */
import crypto from "node:crypto";

/**
 * Convert a logical resource id into a filesystem-safe storage key.
 * Examples:
 *   hooks:SessionStart → hooks_SessionStart-<hash6>
 *   my-skill → my-skill
 *   ../evil → evil-<hash6>  (path separators stripped)
 */
export function toStorageKey(id: string): string {
  const hash = crypto.createHash("sha256").update(id).digest("hex").slice(0, 6);
  // Replace path separators and Windows-forbidden characters
  let key = id
    .replace(/[\/\\]/g, "_")
    .replace(/[<>:"|?*\x00-\x1f]/g, "_")
    .replace(/\.\./g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!key) key = "resource";
  // Truncate long keys; always append short hash when sanitization changed the id
  // or when original contains characters that are unsafe as filenames
  const needsHash =
    key !== id ||
    /[:<>"|?*\/\\]/.test(id) ||
    id.includes("..") ||
    id.length > 80;
  if (key.length > 80) key = key.slice(0, 80);
  if (needsHash) {
    // Avoid double-hashing if already ends with our pattern
    if (!key.endsWith(`-${hash}`)) {
      key = `${key}-${hash}`;
    }
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
