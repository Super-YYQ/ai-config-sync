import fs from "node:fs/promises";
import path from "node:path";
import {
  CandidateRecipeSchema,
  loadRecipe,
  pathExists,
  readDirTree,
  readText,
  type CandidateRecipe,
  type TargetTool,
} from "@ai-config-sync/core";

export interface AnalyzeResult {
  target: TargetTool;
  candidates: CandidateRecipe[];
  standardMatch?: {
    kind: "marketplace-plugin" | "codex-layout" | "generic-skill" | "npx-meta";
    confidence: number;
    details: Record<string, unknown>;
  };
  needsAi: boolean;
  notes: string[];
}

/**
 * Rule-based analyzer for standard repository layouts.
 * Does NOT call AI — only detects known structures.
 */
export async function analyzeSourceTree(
  sourceRoot: string,
  targets: TargetTool[] = ["claude", "codex"],
): Promise<AnalyzeResult[]> {
  const notes: string[] = [];
  const tree = await readDirTree(sourceRoot, 4);
  const results: AnalyzeResult[] = [];

  for (const target of targets) {
    const candidates: CandidateRecipe[] = [];
    let standardMatch: AnalyzeResult["standardMatch"];

    if (target === "claude") {
      const marketplace = tree.find((f) =>
        f.endsWith(".claude-plugin/marketplace.json"),
      );
      const pluginJson = tree.find((f) =>
        f.endsWith(".claude-plugin/plugin.json"),
      );
      if (marketplace || pluginJson) {
        let marketplaceName: string | undefined;
        let pluginName: string | undefined;
        try {
          if (marketplace) {
            const raw = JSON.parse(
              await readText(path.join(sourceRoot, marketplace)),
            ) as { name?: string; plugins?: Array<{ name?: string }> };
            marketplaceName = raw.name;
            pluginName = raw.plugins?.[0]?.name;
          }
          if (pluginJson) {
            const raw = JSON.parse(
              await readText(path.join(sourceRoot, pluginJson)),
            ) as { name?: string };
            pluginName = pluginName ?? raw.name;
          }
        } catch {
          notes.push("Failed to parse plugin manifest");
        }
        standardMatch = {
          kind: "marketplace-plugin",
          confidence: 0.95,
          details: { marketplaceName, pluginName, marketplace, pluginJson },
        };
        candidates.push(
          CandidateRecipeSchema.parse({
            target: "claude",
            driver: "claude-marketplace",
            operations: [
              { type: "register-marketplace" },
              { type: "install-plugin" },
              { type: "enable-plugin" },
            ],
            requiredPaths: [
              marketplace ?? ".claude-plugin/marketplace.json",
            ].filter(Boolean),
            evidence: [
              marketplace
                ? { path: marketplace, section: "marketplace" }
                : { path: pluginJson!, section: "plugin" },
            ],
            confidence: 0.95,
            risk: "medium",
            requiresApproval: true,
          }),
        );
      }

      // Claude skills dir
      const claudeSkill = tree.find(
        (f) =>
          f.startsWith("skills/") && f.endsWith("SKILL.md") ||
          f.startsWith(".claude/skills/") && f.endsWith("SKILL.md"),
      );
      if (claudeSkill && !standardMatch) {
        const skillDir = path.posix.dirname(claudeSkill);
        standardMatch = {
          kind: "generic-skill",
          confidence: 0.85,
          details: { skillDir },
        };
        candidates.push(
          CandidateRecipeSchema.parse({
            target: "claude",
            driver: "generic-skill",
            sourcePaths: { skill: skillDir },
            operations: [{ type: "copy-skill", from: skillDir }],
            requiredPaths: [claudeSkill],
            evidence: [{ path: claudeSkill }],
            confidence: 0.85,
            risk: "low",
            requiresApproval: true,
          }),
        );
      }
    }

    if (target === "codex") {
      const codexSkill = tree.find(
        (f) =>
          (f.startsWith(".codex/skills/") || f.startsWith("skills/")) &&
          f.endsWith("SKILL.md"),
      );
      const hookManifest = tree.find(
        (f) => f === ".codex/hooks.json" || f.endsWith("/hooks.json"),
      );
      const hasCodexDir = tree.some((f) => f.startsWith(".codex/"));

      if (hasCodexDir || codexSkill || hookManifest) {
        const skillDir = codexSkill
          ? path.posix.dirname(codexSkill)
          : undefined;
        standardMatch = {
          kind: "codex-layout",
          confidence: 0.9,
          details: { skillDir, hookManifest },
        };
        candidates.push(
          CandidateRecipeSchema.parse({
            target: "codex",
            driver: "repository-layout",
            sourcePaths: {
              skill: skillDir,
              hookManifest: hookManifest,
              hookScripts: tree.some((f) => f.startsWith(".codex/hooks/"))
                ? ".codex/hooks"
                : undefined,
            },
            operations: [
              ...(skillDir ? [{ type: "copy-skill" as const }] : []),
              ...(hookManifest
                ? [{ type: "merge-hook-manifest" as const }]
                : []),
              {
                type: "merge-toml" as const,
                path: "features.hooks",
                value: true,
              },
            ],
            requiredPaths: [skillDir, hookManifest].filter(
              Boolean,
            ) as string[],
            evidence: [
              ...(skillDir ? [{ path: skillDir }] : []),
              ...(hookManifest ? [{ path: hookManifest }] : []),
            ],
            confidence: 0.9,
            risk: "medium",
            requiresApproval: true,
          }),
        );
      }
    }

    // Root-level SKILL.md fallback
    if (candidates.length === 0 && tree.includes("SKILL.md")) {
      standardMatch = {
        kind: "generic-skill",
        confidence: 0.8,
        details: { skillDir: "." },
      };
      candidates.push(
        CandidateRecipeSchema.parse({
          target,
          driver: "generic-skill",
          sourcePaths: { skill: "." },
          operations: [{ type: "copy-skill", from: "." }],
          requiredPaths: ["SKILL.md"],
          evidence: [{ path: "SKILL.md" }],
          confidence: 0.8,
          risk: "low",
          requiresApproval: true,
        }),
      );
    }

    const needsAi = candidates.length === 0;
    if (needsAi) {
      notes.push(
        `No standard structure detected for ${target}; AI Recipe Assistant recommended`,
      );
    }

    results.push({
      target,
      candidates,
      standardMatch,
      needsAi,
      notes: [...notes],
    });
  }

  return results;
}

export async function loadRecipeRegistry(
  recipesDir: string,
): Promise<Map<string, Awaited<ReturnType<typeof loadRecipe>>>> {
  const map = new Map<string, Awaited<ReturnType<typeof loadRecipe>>>();
  if (!(await pathExists(recipesDir))) return map;
  const entries = await fs.readdir(recipesDir);
  for (const name of entries) {
    if (!name.endsWith(".yaml") && !name.endsWith(".yml")) continue;
    const full = path.join(recipesDir, name);
    try {
      const recipe = await loadRecipe(full);
      map.set(recipe.id, recipe);
      map.set(name.replace(/\.ya?ml$/, ""), recipe);
    } catch (e) {
      // skip invalid
    }
  }
  return map;
}
