import { describe, it, expect } from "vitest";
import {
  hasManagedCodexSessionStart,
  mergeManagedCodexSessionStart,
} from "@ai-config-sync/core";

describe("codex hooks merge", () => {
  it("adds SessionStart in event-map format", () => {
    const { next, changed } = mergeManagedCodexSessionStart({});
    expect(changed).toBe(true);
    expect(hasManagedCodexSessionStart(next)).toBe(true);
    const hooks = (next as { hooks: { SessionStart: unknown[] } }).hooks;
    expect(Array.isArray(hooks.SessionStart)).toBe(true);
    expect(Array.isArray(hooks.SessionStart)).toBe(true);
  });

  it("is idempotent", () => {
    const { next } = mergeManagedCodexSessionStart({});
    const second = mergeManagedCodexSessionStart(next);
    expect(second.changed).toBe(false);
  });

  it("preserves other hooks when migrating legacy array", () => {
    const legacy = {
      hooks: [
        {
          id: "user-hook",
          event: "SessionStart",
          command: "echo hi",
          timeout_ms: 5000,
        },
      ],
    };
    const { next, changed } = mergeManagedCodexSessionStart(legacy);
    expect(changed).toBe(true);
    expect(hasManagedCodexSessionStart(next)).toBe(true);
    const session = (next as { hooks: { SessionStart: Array<{ hooks: Array<{ command: string }> }> } })
      .hooks.SessionStart;
    const cmds = session.flatMap((b) => b.hooks.map((h) => h.command));
    expect(cmds.some((c) => c.includes("echo hi"))).toBe(true);
    expect(cmds.some((c) => c.includes("ai-config-sync"))).toBe(true);
  });

  it("writes commandWindows when absolute CLI path is provided", () => {
    const abs = '"C:\\\\Node\\\\node.exe" "C:\\\\acs\\\\ai-config-sync.cjs"';
    const { next, changed } = mergeManagedCodexSessionStart(
      {},
      { cliAbsoluteCommand: abs },
    );
    expect(changed).toBe(true);
    const session = (
      next as {
        hooks: {
          SessionStart: Array<{
            hooks: Array<{ command: string; commandWindows?: string }>;
          }>;
        };
      }
    ).hooks.SessionStart;
    const managed = session
      .flatMap((b) => b.hooks)
      .find((h) => h.command.includes("ai-config-sync"));
    expect(managed?.commandWindows).toBeTruthy();
    expect(managed!.commandWindows).toContain("ai-config-sync");
  });

  it("refreshes missing commandWindows on existing managed hook", () => {
    const existing = {
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: "command",
                id: "ai-config-sync-session-start",
                command: "ai-config-sync scan --light --write-pending",
                timeout: 20,
              },
            ],
          },
        ],
      },
    };
    const abs = '"C:\\\\Node\\\\node.exe" "D:\\\\acs\\\\dist\\\\ai-config-sync.cjs"';
    const { next, changed } = mergeManagedCodexSessionStart(existing, {
      cliAbsoluteCommand: abs,
    });
    expect(changed).toBe(true);
    const managed = (
      next as {
        hooks: {
          SessionStart: Array<{
            hooks: Array<{ commandWindows?: string }>;
          }>;
        };
      }
    ).hooks.SessionStart[0]!.hooks[0]!;
    expect(managed.commandWindows).toContain("ai-config-sync.cjs");
  });
});
