import { defineConfig } from "vitest/config";
import { resolveAliases } from "./vitest.config.js";

const isWindows = process.platform === "win32";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["tests/integration/**/*.test.ts"],
    testTimeout: isWindows ? 120_000 : 60_000,
    hookTimeout: isWindows ? 60_000 : 30_000,
    fileParallelism: false,
    maxWorkers: 1,
  },
  resolve: {
    alias: resolveAliases,
  },
});
