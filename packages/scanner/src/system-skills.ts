/**
 * System-managed skill directories that must never enter capture/restore lifecycle.
 */
import type { TargetTool } from "@ai-config-sync/core";

const SYSTEM_SKILL_DIRECTORIES: Partial<
  Record<TargetTool, ReadonlySet<string>>
> = {
  codex: new Set([".system"]),
};

export function isSystemSkillDirectory(
  target: TargetTool,
  name: string,
): boolean {
  return SYSTEM_SKILL_DIRECTORIES[target]?.has(name) ?? false;
}

export function isNeverCapturableResource(resource: {
  classification?: string;
  target?: string;
  id?: string;
}): boolean {
  if (resource.classification === "system-cache") return true;
  if (resource.target === "codex" && resource.id === ".system") return true;
  return false;
}
