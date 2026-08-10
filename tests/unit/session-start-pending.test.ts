import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadPending } from "../../packages/state-manager/src/index.js";
import { removeTempDir } from "../helpers/temp-dir.js";

describe("Claude SessionStart pending review", () => {
  let root: string | undefined;

  afterEach(async () => removeTempDir(root));

  it("records unmanaged skills without capture, commit, or push", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "acs-session-start-"));
    const skillDir = path.join(root, ".claude", "skills", "personal-skill");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      "---\nname: personal-skill\ndescription: test\n---\n",
      "utf8",
    );

    const pluginRoot = path.resolve("integrations", "claude-plugin");
    const result = spawnSync(
      process.execPath,
      [path.join(pluginRoot, "scripts", "session-start.cjs")],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: root,
          USERPROFILE: root,
          CLAUDE_PLUGIN_ROOT: pluginRoot,
        },
        timeout: 20_000,
        windowsHide: true,
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("personal-skill");
    const pending = await loadPending(root);
    expect(
      pending.some(
        (batch) =>
          batch.status === "pending-review" &&
          batch.events.some((event) => event.resourceId?.includes("personal-skill")),
      ),
    ).toBe(true);
  });
});
