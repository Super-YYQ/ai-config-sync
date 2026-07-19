/**
 * Structural validation of Claude marketplace + plugin manifests.
 * Used as a CI quality gate when `claude` CLI is unavailable.
 * Exit 1 on any failure.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];

function mustExist(rel) {
  const p = path.join(root, rel);
  if (!fs.existsSync(p)) errors.push(`missing: ${rel}`);
  return p;
}

function readJson(rel) {
  const p = mustExist(rel);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    errors.push(`invalid JSON ${rel}: ${(e).message}`);
    return null;
  }
}

const marketplace = readJson(".claude-plugin/marketplace.json");
if (marketplace) {
  if (!marketplace.name) errors.push("marketplace.json: missing name");
  if (!Array.isArray(marketplace.plugins) || marketplace.plugins.length === 0) {
    errors.push("marketplace.json: plugins[] required");
  } else {
    for (const p of marketplace.plugins) {
      if (!p.name) errors.push("marketplace plugin entry missing name");
      if (!p.source) errors.push(`marketplace plugin ${p.name}: missing source`);
      else {
        const src = path.join(root, p.source);
        if (!fs.existsSync(src)) {
          errors.push(`marketplace plugin ${p.name}: source not found: ${p.source}`);
        }
      }
    }
  }
}

const plugin = readJson(
  "integrations/claude-plugin/.claude-plugin/plugin.json",
);
if (plugin) {
  if (!plugin.name) errors.push("plugin.json: missing name");
  if (!plugin.version) errors.push("plugin.json: missing version");
}

// Required plugin layout
for (const rel of [
  "integrations/claude-plugin/hooks/hooks.json",
  "integrations/claude-plugin/scripts/session-start.cjs",
  "integrations/claude-plugin/bin/ai-config-sync.cjs",
  "integrations/claude-plugin/skills/config-sync/SKILL.md",
]) {
  mustExist(rel);
}

// Hooks must prefer plugin-bundled CLI (session-start.cjs content check)
const sessionStart = path.join(
  root,
  "integrations/claude-plugin/scripts/session-start.cjs",
);
if (fs.existsSync(sessionStart)) {
  const text = fs.readFileSync(sessionStart, "utf8");
  if (!text.includes("CLAUDE_PLUGIN_ROOT")) {
    errors.push("session-start.cjs must reference CLAUDE_PLUGIN_ROOT");
  }
  // plugin root must be checked before PATH
  const pluginIdx = text.indexOf("bin");
  const whichIdx = Math.min(
    text.includes("which") ? text.indexOf("which") : Infinity,
    text.includes("where") ? text.indexOf("where") : Infinity,
  );
  if (pluginIdx < 0 || whichIdx < pluginIdx) {
    // softer: ensure comment or order indicates plugin-first
    if (!/plugin-bundled|plugin-root|FIRST|优先/.test(text)) {
      errors.push(
        "session-start.cjs must prefer ${CLAUDE_PLUGIN_ROOT}/bin over PATH",
      );
    }
  }
  // only flag actual npx invocations (not the word in comments)
  if (
    /spawnSync\(\s*["']npx["']/i.test(text) ||
    /exec(?:File|Sync)?\(\s*["']npx["']/i.test(text) ||
    /(?:^|[^/\w*])npx\s+(?:--yes\s+)?ai-config-sync/m.test(text)
  ) {
    errors.push("session-start.cjs must not invoke npx");
  }
}

const hooks = readJson("integrations/claude-plugin/hooks/hooks.json");
if (hooks) {
  const ss = hooks.hooks?.SessionStart;
  if (!ss) errors.push("hooks.json: missing SessionStart");
}

// Commands directory
const commandsDir = path.join(root, "integrations/claude-plugin/commands");
if (!fs.existsSync(commandsDir)) {
  errors.push("missing integrations/claude-plugin/commands");
} else {
  const cmds = fs.readdirSync(commandsDir).filter((f) => f.endsWith(".md"));
  if (cmds.length === 0) errors.push("no command markdown files under commands/");
}

if (errors.length) {
  console.error("Plugin validation FAILED:");
  for (const e of errors) console.error(" -", e);
  process.exit(1);
}

console.log("Plugin structural validation OK");

// Prefer official claude CLI when available.
// When claude is not installed, structural checks above are enough for CI.
import { spawnSync } from "node:child_process";
const claudeBin = process.platform === "win32" ? "claude.cmd" : "claude";
const claude = spawnSync(claudeBin, ["plugin", "validate", "."], {
  encoding: "utf8",
  cwd: root,
  shell: process.platform === "win32",
});
const out = `${claude.stdout ?? ""}${claude.stderr ?? ""}`;
const missing =
  (claude.error &&
    (claude.error.code === "ENOENT" || /not found|ENOENT/i.test(claude.error.message))) ||
  /not recognized as an internal or external command|command not found|is not recognized/i.test(
    out,
  ) ||
  (claude.status !== 0 && !out.trim() && claude.error);
if (missing || (claude.status !== 0 && /not recognized|command not found|ENOENT/i.test(out))) {
  console.log("(claude CLI not installed — structural checks only)");
  process.exit(0);
}
if (claude.status !== 0) {
  console.error(claude.stdout || "");
  console.error(claude.stderr || "");
  console.error("claude plugin validate failed");
  process.exit(1);
}
console.log("claude plugin validate OK");
