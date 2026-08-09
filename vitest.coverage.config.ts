import { defineConfig } from "vitest/config";
import { resolveAliases } from "./vitest.config.js";

const isWindows = process.platform === "win32";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["tests/**/*.test.ts", "packages/**/*.test.ts"],
    testTimeout: isWindows ? 120_000 : 60_000,
    hookTimeout: isWindows ? 60_000 : 30_000,
    fileParallelism: !isWindows,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "html"],
      reportsDirectory: "coverage",
      include: ["packages/*/src/**/*.ts", "drivers/src/**/*.ts"],
      exclude: [
        "**/src/index.ts",
        "**/*-types.ts",
        "packages/cli/src/bin.ts",
        "**/*.d.ts",
      ],
      thresholds: {
        statements: 70,
        branches: 60,
        functions: 70,
        lines: 70,
        "packages/core/src/path-security.ts": {
          statements: 88,
          branches: 75,
          functions: 85,
          lines: 88,
        },
        "packages/state-manager/src/file-lock.ts": {
          statements: 78,
          branches: 68,
          functions: 80,
          lines: 78,
        },
        "packages/recipe-engine/src/{plan-builder,apply-executor}.ts": {
          statements: 68,
          branches: 65,
          functions: 85,
          lines: 68,
        },
        "packages/recipe-engine/src/capture-transaction.ts": {
          statements: 88,
          branches: 72,
          functions: 90,
          lines: 88,
        },
      },
    },
  },
  resolve: {
    alias: resolveAliases,
  },
});
