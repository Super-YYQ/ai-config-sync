/**
 * Minimal TOML section/key merger that preserves comments and unknown sections
 * via line-oriented patching for simple key = value assignments under [sections].
 *
 * Not a full TOML parser — sufficient for Codex config.toml patterns like:
 *   [features]
 *   hooks = true
 */

export interface TomlSet {
  /** Section name without brackets, e.g. "features" or "mcp_servers.github" */
  section: string;
  key: string;
  value: string | number | boolean;
}

function formatValue(v: string | number | boolean): string {
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  // quote strings unless already quoted-looking bare identifiers
  if (/^[A-Za-z0-9_./-]+$/.test(v)) return `"${v}"`;
  return JSON.stringify(v);
}

function sectionHeader(section: string): string {
  const parts = section.split(".");
  if (parts.length === 1) return `[${section}]`;
  // nested tables: [a.b]
  return `[${section}]`;
}

/**
 * Apply key assignments into TOML text without removing comments or unknown keys.
 */
export function mergeTomlText(original: string, sets: TomlSet[]): string {
  if (sets.length === 0) return original;

  let lines = original.length ? original.replace(/\r\n/g, "\n").split("\n") : [];
  // Ensure trailing structure is easy to append to
  if (lines.length === 1 && lines[0] === "") lines = [];

  for (const set of sets) {
    lines = applyOneSet(lines, set);
  }

  let out = lines.join("\n");
  if (!out.endsWith("\n")) out += "\n";
  return out;
}

function applyOneSet(lines: string[], set: TomlSet): string[] {
  const header = sectionHeader(set.section);
  const valueText = formatValue(set.value);
  const keyAssign = `${set.key} = ${valueText}`;

  // Find section range
  let sectionStart = -1;
  let sectionEnd = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (trimmed === header || trimmed === header.replace(/\s+/g, "")) {
      sectionStart = i;
      continue;
    }
    if (sectionStart >= 0 && i > sectionStart) {
      if (/^\[[^\]]+\]\s*$/.test(trimmed)) {
        sectionEnd = i;
        break;
      }
    }
  }

  if (sectionStart < 0) {
    // Append new section
    const out = [...lines];
    if (out.length > 0 && out[out.length - 1]!.trim() !== "") out.push("");
    out.push(header);
    out.push(keyAssign);
    return out;
  }

  // Search key inside section
  let keyLine = -1;
  for (let i = sectionStart + 1; i < sectionEnd; i++) {
    const trimmed = lines[i]!.trim();
    if (trimmed.startsWith("#") || trimmed === "") continue;
    const m = trimmed.match(/^([A-Za-z0-9_-]+)\s*=/);
    if (m && m[1] === set.key) {
      keyLine = i;
      break;
    }
  }

  const out = [...lines];
  if (keyLine >= 0) {
    // Preserve inline comment if any
    const existing = out[keyLine]!;
    const commentIdx = existing.indexOf("#");
    const comment =
      commentIdx >= 0 ? ` ${existing.slice(commentIdx).trim()}` : "";
    // only replace if value differs (idempotent)
    const currentVal = existing.split("#")[0]!.trim();
    if (currentVal === keyAssign) return out;
    out[keyLine] = `${keyAssign}${comment ? ` ${comment.replace(/^#/, "#")}` : ""}`;
    // simplify: always write clean assignment
    out[keyLine] = keyAssign;
    return out;
  }

  // Insert before section end
  out.splice(sectionEnd, 0, keyAssign);
  return out;
}

/**
 * Read a simple key value from TOML text (string/bool/number).
 */
export function getTomlValue(
  text: string,
  section: string,
  key: string,
): string | number | boolean | undefined {
  const header = sectionHeader(section);
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let inSection = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^\[[^\]]+\]\s*$/.test(trimmed)) {
      inSection = trimmed === header;
      continue;
    }
    if (!inSection) continue;
    if (trimmed.startsWith("#") || trimmed === "") continue;
    const m = trimmed.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
    if (!m || m[1] !== key) continue;
    const raw = m[2]!.split("#")[0]!.trim();
    if (raw === "true") return true;
    if (raw === "false") return false;
    if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
    if (
      (raw.startsWith('"') && raw.endsWith('"')) ||
      (raw.startsWith("'") && raw.endsWith("'"))
    ) {
      return raw.slice(1, -1);
    }
    return raw;
  }
  return undefined;
}
