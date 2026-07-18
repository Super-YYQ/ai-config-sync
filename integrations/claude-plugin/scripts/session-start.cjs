/**
 * Lightweight SessionStart: prefer plugin-bundled CLI FIRST, then PATH fallback.
 * Never call npx — old global installs must not override the plugin version.
 */
const { spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");

function resolveCli() {
  // 1) Plugin-bundled binary FIRST (CLAUDE_PLUGIN_ROOT / sibling bin)
  const root =
    process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, "..");
  const cjs = path.join(root, "bin", "ai-config-sync.cjs");
  if (fs.existsSync(cjs)) {
    return { cmd: process.execPath, argsPrefix: [cjs], via: "plugin-root" };
  }

  // 2) PATH / global only as fallback
  const which = spawnSync(
    process.platform === "win32" ? "where" : "which",
    ["ai-config-sync"],
    {
      encoding: "utf8",
      windowsHide: true,
      shell: process.platform === "win32",
    },
  );
  if (which.status === 0 && which.stdout) {
    const first = which.stdout
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find(Boolean);
    if (first) return { cmd: first, argsPrefix: [], via: "path" };
  }

  return null;
}

function run() {
  const resolved = resolveCli();
  if (!resolved) return;

  const args = [...resolved.argsPrefix, "scan", "--light", "--json"];
  const r = spawnSync(resolved.cmd, args, {
    encoding: "utf8",
    timeout: 15000,
    windowsHide: true,
    env: process.env,
  });
  if (r.status !== 0 || !r.stdout) return;

  try {
    const data = JSON.parse(r.stdout);
    const unmanaged = (data.resources || []).filter(
      (x) =>
        x.classification !== "managed" &&
        x.classification !== "system-cache" &&
        x.kind !== "config" &&
        !String(x.id || "")
          .toLowerCase()
          .includes("ai-config-sync") &&
        String(x.id || "") !== "config-sync",
    );
    if (unmanaged.length > 0) {
      const names = unmanaged
        .slice(0, 5)
        .map((x) => `${x.target}/${x.id}`)
        .join(", ");
      const more =
        unmanaged.length > 5 ? ` …(+${unmanaged.length - 5})` : "";
      process.stderr.write(
        `[ai-config-sync] 发现 ${unmanaged.length} 个未纳管资源: ${names}${more}\n` +
          `  说「同步配置」或运行 /ai-config-sync:capture\n`,
      );
    }
  } catch {
    /* ignore */
  }
}

try {
  run();
} catch {
  /* never block session start */
}
