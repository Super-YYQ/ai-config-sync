/**
 * Managed markdown block merge for CLAUDE.md / AGENTS.md.
 * Managed sections live between markers; local content outside is preserved.
 */

export const MANAGED_BEGIN = "<!-- ai-config-sync:begin -->";
export const MANAGED_END = "<!-- ai-config-sync:end -->";

export interface MergeMarkdownResult {
  content: string;
  changed: boolean;
}

/**
 * Replace or insert the managed block. Content outside markers is preserved.
 */
export function mergeManagedMarkdown(
  original: string,
  managedBody: string,
  options: { begin?: string; end?: string } = {},
): MergeMarkdownResult {
  const begin = options.begin ?? MANAGED_BEGIN;
  const end = options.end ?? MANAGED_END;
  const block = `${begin}\n${managedBody.trim()}\n${end}`;
  const text = original.replace(/\r\n/g, "\n");

  const beginIdx = text.indexOf(begin);
  const endIdx = text.indexOf(end);

  if (beginIdx >= 0 && endIdx > beginIdx) {
    const before = text.slice(0, beginIdx);
    const after = text.slice(endIdx + end.length);
    const next = `${before}${block}${after}`;
    const normalized = next.endsWith("\n") ? next : `${next}\n`;
    return {
      content: normalized,
      changed: normalized !== (text.endsWith("\n") ? text : `${text}\n`),
    };
  }

  // Insert at end
  const base = text.trimEnd();
  const next = base.length ? `${base}\n\n${block}\n` : `${block}\n`;
  return { content: next, changed: next !== text };
}

/** Extract managed body (without markers), if present. */
export function extractManagedMarkdown(
  text: string,
  options: { begin?: string; end?: string } = {},
): string | undefined {
  const begin = options.begin ?? MANAGED_BEGIN;
  const end = options.end ?? MANAGED_END;
  const beginIdx = text.indexOf(begin);
  const endIdx = text.indexOf(end);
  if (beginIdx < 0 || endIdx < beginIdx) return undefined;
  return text.slice(beginIdx + begin.length, endIdx).trim();
}
