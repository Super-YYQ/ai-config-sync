import path from "node:path";
import {
  claudeSkillsDir,
  codexConfigPath,
  codexHooksManifestPath,
  codexSkillsDir,
  collectSecretRefs,
  checkSecrets,
  getTomlValue,
  loadResources,
  pathExists,
  readText,
  hasManagedCodexSessionStart,
  readJsonFile,
  type LocalConfig,
} from "@ai-config-sync/core";
import { getState } from "@ai-config-sync/state-manager";
import { inspectGitSafety, listCachedSources } from "@ai-config-sync/git-sync";

export type DoctorSeverity = "ok" | "warn" | "error";

export interface DoctorFinding {
  severity: DoctorSeverity;
  code: string;
  message: string;
  path?: string;
}

export interface DoctorReport {
  ok: boolean;
  findings: DoctorFinding[];
}

export async function runDoctor(options: {
  home: string;
  localConfig?: LocalConfig;
  configRepoPath?: string;
}): Promise<DoctorReport> {
  const findings: DoctorFinding[] = [];
  const home = options.home;

  // Home dirs
  for (const [label, dir] of [
    ["claude-skills", claudeSkillsDir(home)],
    ["codex-skills", codexSkillsDir(home)],
  ] as const) {
    if (!(await pathExists(dir))) {
      findings.push({
        severity: "warn",
        code: "missing-dir",
        message: `${label} directory missing (will be created on apply)`,
        path: dir,
      });
    } else {
      findings.push({
        severity: "ok",
        code: "dir-present",
        message: `${label} present`,
        path: dir,
      });
    }
  }

  // git / node / ai-config-sync CLI
  for (const bin of ["git", "node"]) {
    try {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execFileAsync = promisify(execFile);
      await execFileAsync(bin, ["--version"], { windowsHide: true });
      findings.push({
        severity: "ok",
        code: "dep-present",
        message: `${bin} available`,
      });
    } catch {
      findings.push({
        severity: "error",
        code: "dep-missing",
        message: `${bin} not found on PATH`,
      });
    }
  }

  // CLI on PATH or plugin bin
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    const out = await execFileAsync("ai-config-sync", ["--version"], {
      windowsHide: true,
      encoding: "utf8",
    });
    findings.push({
      severity: "ok",
      code: "cli-present",
      message: `ai-config-sync CLI: ${String(out.stdout || out.stderr || "").trim()}`,
    });
  } catch {
    findings.push({
      severity: "warn",
      code: "cli-missing",
      message:
        "ai-config-sync not on PATH (Claude Plugin bin may still work in-session)",
    });
  }

  // Config repo
  if (options.configRepoPath) {
    const repo = options.configRepoPath;
    if (!(await pathExists(repo))) {
      findings.push({
        severity: "error",
        code: "config-repo-missing",
        message: `Config repository path does not exist: ${repo}`,
        path: repo,
      });
    } else {
      const git = await inspectGitSafety(repo);
      if (!git.isRepo) {
        findings.push({
          severity: "warn",
          code: "config-not-git",
          message: "Config repository is not a git repo",
          path: repo,
        });
      } else {
        if (git.dirty) {
          findings.push({
            severity: "warn",
            code: "config-dirty",
            message: "Config repository has uncommitted changes — auto pull/push disabled",
            path: repo,
          });
        }
        if (git.diverged) {
          findings.push({
            severity: "error",
            code: "config-diverged",
            message: "Config repository has diverged from upstream",
            path: repo,
          });
        }
        if (!git.dirty && !git.diverged) {
          findings.push({
            severity: "ok",
            code: "config-git-ok",
            message: `Config git ok${git.head ? ` @ ${git.head.slice(0, 8)}` : ""}`,
            path: repo,
          });
        }
      }

      const resourcesPath = path.join(repo, "resources.yaml");
      if (!(await pathExists(resourcesPath))) {
        findings.push({
          severity: "warn",
          code: "resources-missing",
          message: "resources.yaml not found",
          path: resourcesPath,
        });
      } else {
        try {
          const res = await loadResources(resourcesPath);
          findings.push({
            severity: "ok",
            code: "resources-loaded",
            message: `Loaded ${res.resources.length} resource(s)`,
            path: resourcesPath,
          });
        } catch (e) {
          findings.push({
            severity: "error",
            code: "resources-invalid",
            message: `resources.yaml invalid: ${(e as Error).message}`,
            path: resourcesPath,
          });
        }
      }
    }
  } else {
    findings.push({
      severity: "warn",
      code: "not-linked",
      message: "No config repository linked — run setup",
    });
  }

  // Codex hooks feature
  const codexCfg = codexConfigPath(home);
  if (await pathExists(codexCfg)) {
    const text = await readText(codexCfg);
    const hooks = getTomlValue(text, "features", "hooks");
    if (hooks === true) {
      findings.push({
        severity: "ok",
        code: "codex-hooks-enabled",
        message: "Codex features.hooks = true",
        path: codexCfg,
      });
    } else {
      findings.push({
        severity: "warn",
        code: "codex-hooks-disabled",
        message: "Codex features.hooks is not true",
        path: codexCfg,
      });
    }
  }

  const hooksManifest = codexHooksManifestPath(home);
  if (await pathExists(hooksManifest)) {
    try {
      const hooks = await readJsonFile(hooksManifest);
      const managed = hasManagedCodexSessionStart(hooks);
      findings.push({
        severity: managed ? "ok" : "warn",
        code: managed ? "codex-hooks-managed" : "codex-hooks-unmanaged",
        message: managed
          ? "Codex SessionStart ai-config-sync hook present"
          : "Codex hooks.json present but managed SessionStart not found",
        path: hooksManifest,
      });
      if (Array.isArray((hooks as { hooks?: unknown }).hooks)) {
        findings.push({
          severity: "warn",
          code: "codex-hooks-legacy-array",
          message:
            "hooks.json uses legacy array form; prefer event-map SessionStart",
          path: hooksManifest,
        });
      }
    } catch {
      findings.push({
        severity: "error",
        code: "codex-hooks-invalid",
        message: "hooks.json unreadable or invalid JSON",
        path: hooksManifest,
      });
    }
  }

  // State installed vs disk
  const state = await getState(home);
  for (const [id, targets] of Object.entries(state.installed)) {
    for (const t of ["claude", "codex"] as const) {
      const info = targets[t];
      if (!info || info.status !== "installed") continue;
      if (info.path && !(await pathExists(info.path))) {
        findings.push({
          severity: "error",
          code: "installed-missing",
          message: `State says ${id}@${t} installed but path missing`,
          path: info.path,
        });
      }
    }
  }

  // Secret refs in resources
  if (options.configRepoPath) {
    try {
      const res = await loadResources(
        path.join(options.configRepoPath, "resources.yaml"),
      );
      const refs = collectSecretRefs(res);
      if (refs.length > 0) {
        const checks = await checkSecrets(refs, "env");
        for (const c of checks) {
          findings.push({
            severity: c.ok ? "ok" : "warn",
            code: c.ok ? "secret-present" : "secret-missing",
            message: c.message,
          });
        }
      }
    } catch {
      /* already reported resources issues */
    }

    try {
      const cached = await listCachedSources(home);
      findings.push({
        severity: "ok",
        code: "source-cache",
        message: `Source cache entries: ${cached.length}`,
      });
    } catch {
      /* ignore */
    }
  }

  const ok = !findings.some((f) => f.severity === "error");
  return { ok, findings };
}

export function formatDoctor(report: DoctorReport): string {
  const lines = report.findings.map((f) => {
    const tag =
      f.severity === "ok" ? "OK" : f.severity === "warn" ? "WARN" : "ERROR";
    return `[${tag}] ${f.code}: ${f.message}${f.path ? ` (${f.path})` : ""}`;
  });
  lines.push("");
  lines.push(report.ok ? "Doctor: PASS" : "Doctor: FAIL");
  return lines.join("\n");
}
