import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["tests/**/*.test.ts", "packages/**/*.test.ts"],
    testTimeout: 30_000,
  },
  resolve: {
    alias: {
      "@ai-config-sync/core": path.resolve(__dirname, "packages/core/src"),
      "@ai-config-sync/scanner": path.resolve(__dirname, "packages/scanner/src"),
      "@ai-config-sync/state-manager": path.resolve(
        __dirname,
        "packages/state-manager/src",
      ),
      "@ai-config-sync/git-sync": path.resolve(
        __dirname,
        "packages/git-sync/src",
      ),
      "@ai-config-sync/recipe-engine": path.resolve(
        __dirname,
        "packages/recipe-engine/src",
      ),
      "@ai-config-sync/drivers": path.resolve(__dirname, "drivers/src"),
    },
  },
});
