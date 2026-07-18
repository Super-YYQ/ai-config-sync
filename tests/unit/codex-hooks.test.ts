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
});
