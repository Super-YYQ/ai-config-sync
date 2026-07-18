/**
 * AI Recipe Assistant — analyze-only interface.
 * Never executes installs; output must pass CandidateRecipeSchema.
 */

import path from "node:path";
import {
  CandidateRecipeSchema,
  pathExists,
  readDirTree,
  readText,
  sanitizeForAi,
  type CandidateRecipe,
  type TargetTool,
} from "@ai-config-sync/core";
import { analyzeSourceTree } from "./analyzer.js";

export interface AiRecipeRequest {
  sourceRoot: string;
  targets: TargetTool[];
  homeHint?: string;
  /** Max tree depth for prompt context. */
  maxDepth?: number;
}

export interface AiRecipeResponse {
  candidates: CandidateRecipe[];
  usedAi: boolean;
  notes: string[];
  /** Sanitized context that would be sent to a model (for debugging / offline). */
  promptContext?: string;
}

export interface AiRecipeProvider {
  name: string;
  /**
   * Given sanitized repo context, return candidate recipes.
   * Implementations must not execute shell or write files.
   */
  analyze(input: {
    target: TargetTool;
    tree: string[];
    documents: Array<{ path: string; content: string }>;
  }): Promise<CandidateRecipe[]>;
}

/** Default provider: no cloud call — returns empty so rules can stand alone. */
export const noopAiProvider: AiRecipeProvider = {
  name: "noop",
  async analyze() {
    return [];
  },
};

/**
 * Heuristic offline "AI" fallback for non-standard trees:
 * pick SKILL.md paths and emit generic-skill candidates.
 * Not a real LLM — used when ai.mode=analyze-only and no provider registered.
 */
export const heuristicAiProvider: AiRecipeProvider = {
  name: "heuristic",
  async analyze({ target, tree }) {
    const skillMds = tree.filter((f) => f.endsWith("SKILL.md"));
    const out: CandidateRecipe[] = [];
    for (const md of skillMds.slice(0, 5)) {
      const dir = path.posix.dirname(md);
      out.push(
        CandidateRecipeSchema.parse({
          target,
          driver: "generic-skill",
          sourcePaths: { skill: dir === "." ? "." : dir },
          operations: [{ type: "copy-skill", from: dir === "." ? "." : dir }],
          requiredPaths: [md],
          evidence: [{ path: md, section: "heuristic" }],
          confidence: 0.55,
          risk: "low",
          requiresApproval: true,
          notes: "Heuristic fallback (no LLM provider configured)",
        }),
      );
    }
    return out;
  },
};

let registeredProvider: AiRecipeProvider = heuristicAiProvider;

export function setAiRecipeProvider(provider: AiRecipeProvider): void {
  registeredProvider = provider;
}

export function getAiRecipeProvider(): AiRecipeProvider {
  return registeredProvider;
}

/**
 * Full analyze pipeline:
 * 1. Rule analyzer
 * 2. If needsAi and AI enabled → provider.analyze on sanitized docs
 * 3. Schema-validate all candidates
 */
export async function analyzeWithOptionalAi(
  request: AiRecipeRequest,
  options: { aiEnabled?: boolean; provider?: AiRecipeProvider } = {},
): Promise<AiRecipeResponse> {
  const notes: string[] = [];
  const ruleResults = await analyzeSourceTree(request.sourceRoot, request.targets);
  const candidates: CandidateRecipe[] = [];
  let needsAi = false;

  for (const r of ruleResults) {
    candidates.push(...r.candidates);
    notes.push(...r.notes);
    if (r.needsAi) needsAi = true;
  }

  if (!needsAi || options.aiEnabled === false) {
    return { candidates, usedAi: false, notes };
  }

  const provider = options.provider ?? registeredProvider;
  const tree = await readDirTree(request.sourceRoot, request.maxDepth ?? 4);
  const docNames = tree.filter(
    (f) =>
      /(^|\/)(readme|install|skill\.md|plugin\.json|marketplace\.json|package\.json|hooks\.json)/i.test(
        f,
      ),
  );

  const documents: Array<{ path: string; content: string }> = [];
  for (const rel of docNames.slice(0, 12)) {
    const full = path.join(request.sourceRoot, rel);
    if (!(await pathExists(full))) continue;
    try {
      const raw = await readText(full);
      documents.push({
        path: rel,
        content: sanitizeForAi(raw.slice(0, 8000), request.homeHint),
      });
    } catch {
      /* skip */
    }
  }

  const promptContext = sanitizeForAi(
    JSON.stringify({ tree, documents: documents.map((d) => d.path) }, null, 2),
    request.homeHint,
  );

  let usedAi = false;
  for (const target of request.targets) {
    const already = candidates.some((c) => c.target === target);
    if (already) continue;
    try {
      const more = await provider.analyze({ target, tree, documents });
      for (const c of more) {
        const parsed = CandidateRecipeSchema.safeParse(c);
        if (parsed.success) {
          candidates.push(parsed.data);
          usedAi = true;
        } else {
          notes.push(
            `AI candidate rejected by schema for ${target}: ${parsed.error.message}`,
          );
        }
      }
    } catch (e) {
      notes.push(`AI provider error: ${(e as Error).message}`);
    }
  }

  notes.push(`AI provider: ${provider.name}; usedAi=${usedAi}`);
  return { candidates, usedAi, notes, promptContext };
}
