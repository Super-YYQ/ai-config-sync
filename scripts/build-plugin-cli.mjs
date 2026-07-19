/**
 * Bundle the monorepo CLI into standalone CJS files for:
 * - integrations/claude-plugin/bin/ai-config-sync.cjs  (plugin PATH)
 * - dist/ai-config-sync.cjs                            (npm package bin)
 *
 * Usage: node scripts/build-plugin-cli.mjs
 */
import * as esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(root, "packages/cli/src/index.ts");
const outPlugin = path.join(
  root,
  "integrations/claude-plugin/bin/ai-config-sync.cjs",
);
const outDist = path.join(root, "dist/ai-config-sync.cjs");
const outCmd = path.join(
  root,
  "integrations/claude-plugin/bin/ai-config-sync.cmd",
);

const pkg = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8"),
);
const appVersion = String(pkg.version ?? "0.0.0");

fs.mkdirSync(path.dirname(outPlugin), { recursive: true });
fs.mkdirSync(path.dirname(outDist), { recursive: true });

const common = {
  entryPoints: [entry],
  bundle: true,
  platform: "node",
  target: "node18",
  format: "cjs",
  sourcemap: false,
  minify: false,
  // Shebang is written after build so `node file.cjs` works on Windows.
  logLevel: "info",
  define: {
    "process.env.ACS_BUNDLE": '"1"',
    __APP_VERSION__: JSON.stringify(appVersion),
  },
};

await esbuild.build({
  ...common,
  outfile: outPlugin,
});

await esbuild.build({
  ...common,
  outfile: outDist,
});

function withShebang(file) {
  const body = fs.readFileSync(file, "utf8");
  const cleaned = body.replace(/^#!.*\r?\n/, "");
  fs.writeFileSync(file, `#!/usr/bin/env node\n${cleaned}`, "utf8");
}

withShebang(outPlugin);
withShebang(outDist);

// Windows cmd shim for plugin bin
fs.writeFileSync(
  outCmd,
  `@echo off\r\nnode "%~dp0ai-config-sync.cjs" %*\r\n`,
  "utf8",
);

// Ensure unix shebang executable bit is preserved conceptually (git may handle)
try {
  fs.chmodSync(outPlugin, 0o755);
  fs.chmodSync(outDist, 0o755);
} catch {
  /* windows */
}

console.log(`Bundled CLI v${appVersion}`);
console.log(`  → ${path.relative(root, outPlugin)}`);
console.log(`  → ${path.relative(root, outDist)}`);
console.log(`  → ${path.relative(root, outCmd)}`);
