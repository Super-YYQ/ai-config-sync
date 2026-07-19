import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  runClaude,
  runCommand,
  quoteCmdArg,
  claudeExecutable,
  toStorageKey,
  recipeRelPath,
  vendorSkillRelPath,
  ensureDir,
  writeText,
  pathExists,
  captureTransactionsDir,
} from "@ai-config-sync/core";
import { commitCaptureItems } from "@ai-config-sync/recipe-engine";
import { installStableCliShim } from "../../packages/cli/src/setup.js";
import type { ScannedResource } from "@ai-config-sync/scanner";

async function makeTemp(prefix = "acs-b444-"): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("P0 Windows-safe runClaude / runCommand", () => {
  let tmp: string;
  let prevPath: string | undefined;

  beforeEach(async () => {
    tmp = await makeTemp();
    prevPath = process.env.PATH;
  });

  afterEach(async () => {
    process.env.PATH = prevPath;
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("quoteCmdArg wraps args with spaces and special chars", () => {
    expect(quoteCmdArg("plain")).toBe("plain");
    expect(quoteCmdArg("has space")).toBe('"has space"');
    expect(quoteCmdArg('say "hi"')).toBe('"say ""hi"""');
  });

  it("actually executes a fake claude.cmd via PATH and preserves args", async () => {
    // Node-based fake "claude" so we avoid brittle .cmd echo redirection on paths
    // with non-ASCII characters. On Windows we still wrap it as claude.cmd.
    const logFile = path.join(tmp, "args.log");
    const fakeJs = path.join(tmp, "fake-claude.js");
    await writeText(
      fakeJs,
      [
        "const fs = require('fs');",
        `fs.appendFileSync(${JSON.stringify(logFile)}, process.argv.slice(2).join(' ') + '\\n');`,
        "process.exit(0);",
        "",
      ].join("\n"),
    );

    if (process.platform === "win32") {
      const fakeCmd = path.join(tmp, "claude.cmd");
      // %~dp0 resolves to the cmd's directory; quote node + script paths
      await writeText(
        fakeCmd,
        [
          "@echo off",
          `"${process.execPath}" "%~dp0fake-claude.js" %*`,
          "exit /b %ERRORLEVEL%",
          "",
        ].join("\r\n"),
      );
      process.env.PATH = `${tmp}${path.delimiter}${prevPath ?? ""}`;

      expect(claudeExecutable()).toBe("claude.cmd");

      // Absolute .cmd path through runCommand (cmd.exe /d /s /c)
      const r1 = await runCommand(fakeCmd, ["plugin", "list", "--json"], {
        timeout: 15000,
      });
      expect(r1.code).toBe(0);

      // Via PATH + runClaude
      const r2 = await runClaude(["--version"], { timeout: 15000 });
      expect(r2.code).toBe(0);

      await runCommand(fakeCmd, [
        "plugin",
        "install",
        "ai-config-sync@ai-config-sync",
        "--scope",
        "user",
      ]);

      const log = await fs.readFile(logFile, "utf8");
      expect(log).toMatch(/plugin/);
      expect(log).toMatch(/list/);
      expect(log).toContain("ai-config-sync@ai-config-sync");
      expect(log).toContain("--scope");
      expect(log).toMatch(/--version/);
    } else {
      // POSIX: run node script directly through runCommand
      expect(claudeExecutable()).toBe("claude");
      const r1 = await runCommand(process.execPath, [fakeJs, "plugin", "list"], {
        timeout: 15000,
      });
      expect(r1.code).toBe(0);
      const log = await fs.readFile(logFile, "utf8");
      expect(log).toMatch(/plugin list/);
    }
  });
});

describe("P1 storage keys", () => {
  it("sanitizes hooks:SessionStart and path traversal", () => {
    const k = toStorageKey("hooks:SessionStart");
    expect(k).not.toContain(":");
    expect(k).toMatch(/^hooks_SessionStart-/);
    expect(recipeRelPath("hooks:SessionStart")).toBe(`recipes/${k}.yaml`);

    const evil = toStorageKey("../evil");
    expect(evil).not.toContain("..");
    expect(evil).not.toMatch(/[\/\\]/);
    expect(vendorSkillRelPath("my-skill")).toBe("sources/skills/my-skill");
  });
});

describe("P1 stable CLI shim", () => {
  let home: string;

  beforeEach(async () => {
    home = await makeTemp();
  });
  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  it("copies bundled CLI into ~/.ai-config-sync/bin", async () => {
    const monorepo = path.resolve(__dirname, "../..");
    const result = await installStableCliShim(home, { programRoot: monorepo });
    expect(result.cjs).toBeTruthy();
    expect(await pathExists(result.cjs!)).toBe(true);
    expect(await pathExists(result.cmd!)).toBe(true);
    // Second call should be no-op when content matches
    const second = await installStableCliShim(home, { programRoot: monorepo });
    expect(second.changed).toBe(false);
  });
});

describe("P1 capture --home + lock", () => {
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

  it("writes transactions under the provided home, not real homedir", async () => {
    const skillDir = path.join(home, "skill-a");
    await ensureDir(skillDir);
    await writeText(path.join(skillDir, "SKILL.md"), "# a\n");

    const scanned: ScannedResource = {
      id: "skill-a",
      kind: "skill",
      target: "claude",
      path: skillDir,
      confidence: 0.9,
      classification: "source-unknown",
    };

    await commitCaptureItems(
      [
        {
          scanned,
          suggestedResource: {
            id: "skill-a",
            kind: "skill",
            source: { provider: "local", path: skillDir },
            targets: {
              claude: {
                enabled: true,
                recipeRef: "recipes/skill-a.yaml#claude",
              },
            },
            profiles: ["home"],
            versionPolicy: "vendored",
          },
          suggestedRecipe: {
            id: "skill-a",
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
        },
      ],
      configRepo,
      "test",
      { home },
    );

    // Transaction dir under test home exists (even if empty after success cleanup)
    expect(await pathExists(captureTransactionsDir(home))).toBe(true);
    // Success should leave no leftover staging in config repo
    const leftovers = (await fs.readdir(configRepo)).filter(
      (n) =>
        n.startsWith(".ai-config-sync-staging") ||
        n.startsWith(".ai-config-sync-backup"),
    );
    expect(leftovers).toEqual([]);
  });
});
