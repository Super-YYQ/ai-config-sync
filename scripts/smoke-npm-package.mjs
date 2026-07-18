/**
 * Smoke-test a packed tarball in a clean temp directory.
 * Usage: node scripts/smoke-npm-package.mjs [path-to.tgz]
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tgzArg = process.argv[2];

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    shell: process.platform === "win32",
    ...opts,
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  if (r.status !== 0) {
    console.error(out);
    throw new Error(`${cmd} ${args.join(" ")} failed: ${r.status}`);
  }
  return out;
}

console.log("Building…");
run("npm", ["run", "build"], { cwd: root });

// Remove old packs
for (const f of fs.readdirSync(root)) {
  if (f.endsWith(".tgz")) fs.unlinkSync(path.join(root, f));
}

let tgz = tgzArg;
if (!tgz) {
  console.log("Packing…");
  run("npm", ["pack"], { cwd: root });
  const packs = fs
    .readdirSync(root)
    .filter((f) => f.startsWith("ai-config-sync-") && f.endsWith(".tgz"));
  if (!packs.length) throw new Error("no tarball after npm pack");
  tgz = path.join(root, packs[packs.length - 1]);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "acs-smoke-"));
const home = path.join(tmp, "home");
const repo = path.join(tmp, "cfg");
fs.mkdirSync(home);
console.log("Temp:", tmp);
console.log("Install tarball:", tgz);

run("npm", ["install", tgz], { cwd: tmp });

const bin = path.join(
  tmp,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "ai-config-sync.cmd" : "ai-config-sync",
);

const env = { ...process.env, HOME: home, USERPROFILE: home };

function cli(args) {
  console.log(">", "ai-config-sync", ...args);
  const r = spawnSync(bin, args, {
    encoding: "utf8",
    env,
    shell: process.platform === "win32",
    cwd: tmp,
  });
  console.log(r.stdout || "");
  if (r.stderr) console.error(r.stderr);
  if (r.status !== 0) throw new Error(`CLI failed: ${args.join(" ")}`);
  return r.stdout || "";
}

const ver = cli(["--version"]);
if (!/\d+\.\d+\.\d+/.test(ver)) throw new Error("bad version: " + ver);

const template = path.join(root, "examples", "private-config-template");
fs.cpSync(template, repo, { recursive: true });

cli([
  "setup",
  "--config-path",
  repo,
  "--profile",
  "home",
  "--home",
  home,
  "--program-root",
  root,
]);
cli(["scan", "--home", home, "--light"]);
cli(["doctor", "--home", home]);
cli(["plan", "--home", home]);

console.log("SMOKE OK");
if (!tgzArg && tgz.startsWith(root)) {
  try {
    fs.unlinkSync(tgz);
  } catch {
    /* ignore */
  }
}
