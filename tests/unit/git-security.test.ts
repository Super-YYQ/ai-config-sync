import { describe, it, expect } from "vitest";
import { remotesMatch } from "@ai-config-sync/git-sync";
import { scanTextForSecrets } from "@ai-config-sync/core";

describe("git remote matching", () => {
  it("normalizes github urls", () => {
    expect(
      remotesMatch(
        "git@github.com:yyq/yyq-ai-config.git",
        "https://github.com/yyq/yyq-ai-config",
      ),
    ).toBe(true);
    expect(
      remotesMatch(
        "git@github.com:yyq/yyq-ai-config.git",
        "https://github.com/other/yyq-ai-config",
      ),
    ).toBe(false);
  });
});

describe("commit secret gate", () => {
  it("blocks openai keys", () => {
    const f = scanTextForSecrets(
      "OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456",
    );
    expect(
      f.some(
        (x) => x.rule.includes("openai") || x.rule.includes("high-entropy"),
      ),
    ).toBe(true);
  });
});
