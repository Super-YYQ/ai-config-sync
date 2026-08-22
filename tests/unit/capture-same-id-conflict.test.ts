import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureDir, writeText, writeYamlFile } from "@ai-config-sync/core";
import type { ScannedResource } from "@ai-config-sync/scanner";
import { buildCaptureProposals } from "@ai-config-sync/recipe-engine";

describe("capture same-id multi-machine content conflicts", () => {
  let repo: string;
  let localSkill: string;

  beforeEach(async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "acs-sameid-"));
    repo = path.join(base, "my-ai-config");
    localSkill = path.join(base, "local-skills", "shared-skill");
    await ensureDir(path.join(repo, "sources", "skills", "shared-skill"));
    await ensureDir(localSkill);
    await writeText(
      path.join(repo, "sources", "skills", "shared-skill", "SKILL.md"),
      "# shared-skill\nMachine A version.\n",
    );
  });

  afterEach(async () => {
    await fs.rm(path.dirname(repo), { recursive: true, force: true });
  });

  function scanned(): ScannedResource {
    return {
      id: "shared-skill",
      kind: "skill",
      target: "claude",
      path: localSkill,
      confidence: 0.95,
      classification: "source-unknown",
    };
  }

  it("marks an edited copy of an already-backed-up skill as needs-review", async () => {
    await writeYamlFile(path.join(repo, "resources.yaml"), {
      schemaVersion: 1,
      resources: [
        {
          id: "shared-skill",
          kind: "skill",
          source: {
            provider: "vendored",
            path: "sources/skills/shared-skill",
          },
          targets: {
            claude: {
              enabled: true,
              recipeRef: "recipes/shared-skill.yaml#claude",
            },
          },
          profiles: ["home"],
          versionPolicy: "vendored",
        },
      ],
    });
    await writeText(
      path.join(localSkill, "SKILL.md"),
      "# shared-skill\nMachine B edited version.\n",
    );

    const proposals = await buildCaptureProposals([scanned()], repo, {});
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.status).toBe("needs-review");
    expect(proposals[0]!.blockReason).toBe("same-id-different-content");
    expect(proposals[0]!.suggestedResource.id).toBe("shared-skill");
    // needs-review items must never be auto-written by --yes
    expect(proposals[0]!.suggestedRecipe).toBeUndefined();
  });

  it("stays silent when local content matches the vendored copy", async () => {
    await writeYamlFile(path.join(repo, "resources.yaml"), {
      schemaVersion: 1,
      resources: [
        {
          id: "shared-skill",
          kind: "skill",
          source: {
            provider: "vendored",
            path: "sources/skills/shared-skill",
          },
          targets: {
            claude: {
              enabled: true,
              recipeRef: "recipes/shared-skill.yaml#claude",
            },
          },
          profiles: ["home"],
          versionPolicy: "vendored",
        },
      ],
    });
    await writeText(
      path.join(localSkill, "SKILL.md"),
      "# shared-skill\nMachine A version.\n",
    );

    const proposals = await buildCaptureProposals([scanned()], repo, {});
    expect(proposals.filter((p) => p.scanned.id === "shared-skill")).toHaveLength(0);
  });

  it("does not fabricate conflicts for non-vendored sources", async () => {
    await writeYamlFile(path.join(repo, "resources.yaml"), {
      schemaVersion: 1,
      resources: [
        {
          id: "shared-skill",
          kind: "skill",
          source: { provider: "github", repository: "you/shared-skill" },
          targets: {
            claude: {
              enabled: true,
              recipeRef: "recipes/shared-skill.yaml#claude",
            },
          },
          profiles: ["home"],
          versionPolicy: "latest-confirm",
        },
      ],
    });
    await writeText(
      path.join(localSkill, "SKILL.md"),
      "# shared-skill\nMachine B edited version.\n",
    );

    const proposals = await buildCaptureProposals([scanned()], repo, {});
    expect(proposals.filter((p) => p.scanned.id === "shared-skill")).toHaveLength(0);
  });
});
