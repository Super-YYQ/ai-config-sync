import { describe, it, expect } from "vitest";
import {
  parseClaudePluginKey,
  formatClaudePluginKey,
  normalizeGitRepositoryUrl,
} from "@ai-config-sync/scanner";

describe("parseClaudePluginKey", () => {
  it("splits plugin@marketplace on the last @", () => {
    expect(parseClaudePluginKey("code-review@claude-plugins-official")).toEqual({
      pluginName: "code-review",
      marketplaceName: "claude-plugins-official",
    });
    expect(
      parseClaudePluginKey("superpowers@claude-plugins-official"),
    ).toEqual({
      pluginName: "superpowers",
      marketplaceName: "claude-plugins-official",
    });
  });

  it("handles plain plugin name", () => {
    expect(parseClaudePluginKey("plain-plugin")).toEqual({
      pluginName: "plain-plugin",
    });
  });

  it("does not treat trailing/leading @ as marketplace", () => {
    expect(parseClaudePluginKey("plugin@")).toEqual({ pluginName: "plugin@" });
    expect(parseClaudePluginKey("@marketplace")).toEqual({
      pluginName: "@marketplace",
    });
  });
});

describe("formatClaudePluginKey", () => {
  it("joins plugin and marketplace", () => {
    expect(formatClaudePluginKey("code-review", "claude-plugins-official")).toBe(
      "code-review@claude-plugins-official",
    );
    expect(formatClaudePluginKey("plain")).toBe("plain");
  });
});

describe("normalizeGitRepositoryUrl", () => {
  it("normalizes https / ssh / owner-repo forms", () => {
    expect(
      normalizeGitRepositoryUrl("https://github.com/anthropics/claude-plugins-official.git")
        .repository,
    ).toBe("anthropics/claude-plugins-official");
    expect(
      normalizeGitRepositoryUrl("git@github.com:anthropics/claude-plugins-official.git")
        .repository,
    ).toBe("anthropics/claude-plugins-official");
    expect(
      normalizeGitRepositoryUrl("ssh://git@github.com/anthropics/claude-plugins-official.git")
        .repository,
    ).toBe("anthropics/claude-plugins-official");
    expect(
      normalizeGitRepositoryUrl("anthropics/claude-plugins-official").repository,
    ).toBe("anthropics/claude-plugins-official");
  });
});
