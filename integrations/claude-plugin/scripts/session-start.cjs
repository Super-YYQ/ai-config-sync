/**
 * Claude Code SessionStart: lightweight scan, never blocks startup long.
 * Prints a short hint when unmanaged skills/plugins are found.
 */
const { spawnSync } = require("child_process");
const path = require("path");

function run() {
  const isWin = process.platform === "win32";
  const cmd = isWin ? "npx.cmd" : "npx";
  const r = spawnSync(
    cmd,
    ["--yes", "ai-config-sync", "scan", "--light", "--json"],
    {
      encoding: "utf8",
      timeout: 15000,
      windowsHide: true,
      env: process.env,
    },
  );

  // Fallback: global / PATH binary
  let stdout = r.stdout || "";
  if (r.error || r.status !== 0) {
    const r2 = spawnSync("ai-config-sync", ["scan", "--light", "--json"], {
      encoding: "utf8",
      timeout: 15000,
      windowsHide: true,
      shell: isWin,
    });
    if (r2.status !== 0 || !r2.stdout) return;
    stdout = r2.stdout;
  }

  try {
    const data = JSON.parse(stdout);
    const unmanaged = (data.resources || []).filter(
      (x) =>
        x.classification !== "managed" &&
        x.classification !== "system-cache" &&
        x.kind !== "config" &&
        !String(x.id || "").startsWith("marketplace:"),
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
          `  在对话中说「同步配置」或运行 /ai-config-sync:capture\n`,
      );
    }
  } catch {
    /* ignore parse errors — never break session start */
  }
}

try {
  run();
} catch {
  /* swallow */
}
