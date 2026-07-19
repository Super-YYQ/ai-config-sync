import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ensureDir,
  writeText,
  loadResources,
  toStorageKey,
  needsWindowsCmdShell,
  resolveWindowsCommand,
  runCommand,
  quoteCmdArg,
} from "@ai-config-sync/core";
import { commitCaptureItems, type CaptureItem } from "@ai-config-sync/recipe-engine";
import type { ScannedResource } from "@ai-config-sync/scanner";

async function makeTemp(prefix = "acs-review-"): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function skillItem(id: string, skillDir: string): CaptureItem {
  const scanned: ScannedResource = {
    id,
    kind: "skill",
    target: "claude",
    path: skillDir,
    confidence: 0.9,
    classification: "source-unknown",
  };
  return {
    scanned,
    suggestedResource: {
      id,
      kind: "skill",
      source: { provider: "local", path: skillDir },
      targets: {
        claude: { enabled: true, recipeRef: `recipes/${id}.yaml#claude` },
      },
      profiles: ["home"],
      versionPolicy: "vendored",
    },
    suggestedRecipe: {
      id,
      schemaVersion: 1,
      targets: {
        claude: {
          driver: "generic-skill",
          scope: "user",
          sourcePaths: { skill: "." },
          operations: [],
          requiredPaths: ["SKILL.md"],
          requirements: [],
          verification: [],
          risk: "low",
          evidence: [],
          requiresApproval: true,
        },
      },
      versionPolicy: "vendored",
      risk: "low",
    },
    needsAi: false,
    status: "ready",
  };
}

describe("P0 capture lock before read (concurrent)", () => {
  let home: string;
  let configRepo: string;

  beforeEach(async () => {
    home = await makeTemp();
    configRepo = path.join(home, "cfg");
    await ensureDir(path.join(configRepo, "recipes"));
    await writeText(
      path.join(configRepo, "resources.yaml"),
      "schemaVersion: 1\nresources: []\n",
    );
  });

  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  it("concurrent Skill A + Skill B both end up in resources.yaml", async () => {
    const dirA = path.join(home, "skill-a");
    const dirB = path.join(home, "skill-b");
    await ensureDir(dirA);
    await ensureDir(dirB);
    await writeText(path.join(dirA, "SKILL.md"), "# a\n");
    await writeText(path.join(dirB, "SKILL.md"), "# b\n");

    // Start A first with a delay after lock so B waits on the lock,
    // then both commit; final resources must contain A and B.
    const pA = commitCaptureItems(
      [skillItem("skill-a", dirA)],
      configRepo,
      "session-a",
      { home, injectDelayMs: 120 },
    );
    // Give A a head start to acquire the lock
    await new Promise((r) => setTimeout(r, 30));
    const pB = commitCaptureItems(
      [skillItem("skill-b", dirB)],
      configRepo,
      "session-b",
      { home },
    );

    await Promise.all([pA, pB]);

    const res = await loadResources(path.join(configRepo, "resources.yaml"));
    const ids = res.resources.map((r) => r.id).sort();
    expect(ids).toEqual(["skill-a", "skill-b"]);

    // Both vendor dirs exist under storage keys
    expect(
      await fs
        .access(
          path.join(
            configRepo,
            "sources",
            "skills",
            toStorageKey("skill-a"),
            "SKILL.md",
          ),
        )
        .then(() => true)
        .catch(() => false),
    ).toBe(true);
    expect(
      await fs
        .access(
          path.join(
            configRepo,
            "sources",
            "skills",
            toStorageKey("skill-b"),
            "SKILL.md",
          ),
        )
        .then(() => true)
        .catch(() => false),
    ).toBe(true);
  });
});

describe("P1 Windows npx shim detection", () => {
  it("treats bare npx as a Windows cmd shim", () => {
    if (process.platform === "win32") {
      expect(needsWindowsCmdShell("npx")).toBe(true);
      expect(needsWindowsCmdShell("npx.cmd")).toBe(true);
      expect(resolveWindowsCommand("npx")).toBe("npx.cmd");
      expect(needsWindowsCmdShell("claude")).toBe(true);
    } else {
      expect(needsWindowsCmdShell("npx")).toBe(false);
      expect(resolveWindowsCommand("npx")).toBe("npx");
    }
    expect(quoteCmdArg("a b")).toBe('"a b"');
  });

  it("actually executes a fake npx.cmd via runCommand on Windows", async () => {
    if (process.platform !== "win32") return;
    const tmp = await makeTemp("acs-npx-");
    try {
      const logFile = path.join(tmp, "npx-args.log");
      const fakeJs = path.join(tmp, "fake-npx.js");
      await writeText(
        fakeJs,
        [
          "const fs=require('fs');",
          `fs.appendFileSync(${JSON.stringify(logFile)}, process.argv.slice(2).join(' ')+'\\n');`,
          "process.exit(0);",
          "",
        ].join("\n"),
      );
      const fakeCmd = path.join(tmp, "npx.cmd");
      await writeText(
        fakeCmd,
        [
          "@echo off",
          `"${process.execPath}" "%~dp0fake-npx.js" %*`,
          "exit /b %ERRORLEVEL%",
          "",
        ].join("\r\n"),
      );

      const r = await runCommand(fakeCmd, ["--yes", "skills", "add", "demo"], {
        timeout: 15000,
      });
      expect(r.code).toBe(0);
      const log = await fs.readFile(logFile, "utf8");
      expect(log).toContain("--yes");
      expect(log).toContain("skills");
      expect(log).toContain("demo");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
