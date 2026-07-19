import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import {
  ensureDir,
  pathExists,
  scanTextForSecrets,
  type SecretFinding,
} from "@ai-config-sync/core";

const execFileAsync = promisify(execFile);

export interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

export class GitError extends Error {
  constructor(
    message: string,
    public readonly result?: GitResult,
  ) {
    super(message);
    this.name = "GitError";
  }
}

export async function runGit(
  cwd: string,
  args: string[],
  options: { allowFail?: boolean } = {},
): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
    });
    return { stdout: stdout.trimEnd(), stderr: stderr.trimEnd(), code: 0 };
  } catch (err) {
    const e = err as {
      stdout?: string;
      stderr?: string;
      code?: number;
      message?: string;
    };
    const result: GitResult = {
      stdout: (e.stdout ?? "").toString().trimEnd(),
      stderr: (e.stderr ?? "").toString().trimEnd(),
      code: typeof e.code === "number" ? e.code : 1,
    };
    if (options.allowFail) return result;
    throw new GitError(
      `git ${args.join(" ")} failed: ${result.stderr || e.message}`,
      result,
    );
  }
}

export async function isGitRepo(dir: string): Promise<boolean> {
  if (!(await pathExists(dir))) return false;
  const r = await runGit(dir, ["rev-parse", "--is-inside-work-tree"], {
    allowFail: true,
  });
  return r.code === 0 && r.stdout.trim() === "true";
}

export async function getRemoteUrl(
  dir: string,
  name = "origin",
): Promise<string | undefined> {
  const r = await runGit(dir, ["remote", "get-url", name], { allowFail: true });
  if (r.code !== 0) return undefined;
  return r.stdout.trim() || undefined;
}

export async function getHeadCommit(dir: string): Promise<string | undefined> {
  const r = await runGit(dir, ["rev-parse", "HEAD"], { allowFail: true });
  if (r.code !== 0) return undefined;
  return r.stdout.trim() || undefined;
}

export async function hasUncommittedChanges(dir: string): Promise<boolean> {
  const r = await runGit(dir, ["status", "--porcelain"], { allowFail: true });
  if (r.code !== 0) return false;
  return r.stdout.trim().length > 0;
}

export async function isDiverged(dir: string): Promise<boolean> {
  // fetch not automatic — compare with upstream if set
  const r = await runGit(
    dir,
    ["rev-list", "--left-right", "--count", "@{u}...HEAD"],
    { allowFail: true },
  );
  if (r.code !== 0) return false;
  const parts = r.stdout.trim().split(/\s+/);
  const behind = Number(parts[0] ?? 0);
  const ahead = Number(parts[1] ?? 0);
  return behind > 0 && ahead > 0;
}

export interface GitSafetyStatus {
  isRepo: boolean;
  remoteUrl?: string;
  head?: string;
  dirty: boolean;
  diverged: boolean;
  canPull: boolean;
  canPush: boolean;
  messages: string[];
}

export async function inspectGitSafety(dir: string): Promise<GitSafetyStatus> {
  const messages: string[] = [];
  const repo = await isGitRepo(dir);
  if (!repo) {
    return {
      isRepo: false,
      dirty: false,
      diverged: false,
      canPull: false,
      canPush: false,
      messages: ["Not a git repository"],
    };
  }
  const remoteUrl = await getRemoteUrl(dir);
  const head = await getHeadCommit(dir);
  const dirty = await hasUncommittedChanges(dir);
  const diverged = await isDiverged(dir);
  if (dirty) messages.push("Uncommitted local changes present — auto pull/push disabled");
  if (diverged) messages.push("Local and remote have diverged — resolve manually");
  if (!remoteUrl) messages.push("No origin remote configured");

  return {
    isRepo: true,
    remoteUrl,
    head,
    dirty,
    diverged,
    canPull: !dirty && !diverged && !!remoteUrl,
    canPush: !dirty && !diverged && !!remoteUrl,
    messages,
  };
}

export async function cloneRepo(
  remote: string,
  localPath: string,
): Promise<void> {
  if (await pathExists(localPath)) {
    throw new GitError(
      `Target directory already exists: ${localPath}. Refusing to clone over it.`,
    );
  }
  await ensureDir(path.dirname(localPath));
  await runGit(path.dirname(localPath), ["clone", remote, localPath]);
}

export async function pullRepo(dir: string): Promise<GitResult> {
  const safety = await inspectGitSafety(dir);
  if (!safety.canPull) {
    throw new GitError(
      `Refusing to pull: ${safety.messages.join("; ") || "unsafe state"}`,
    );
  }
  return runGit(dir, ["pull", "--ff-only"]);
}

export async function commitAll(
  dir: string,
  message: string,
  options: { allowEmpty?: boolean } = {},
): Promise<GitResult | null> {
  // Secret scan staged-ish content: scan working tree text files for secrets first
  const status = await runGit(dir, ["status", "--porcelain=v1", "-z"], {
    allowFail: true,
  });
  if ((!status.stdout || !status.stdout.replace(/\0/g, "").trim()) && !options.allowEmpty) {
    return null;
  }

  const findings = await scanWorkingTreeSecrets(dir);
  if (findings.length > 0) {
    const summary = findings
      .slice(0, 5)
      .map((f) => `${f.path}:${f.line} ${f.rule} ${f.preview}`)
      .join("; ");
    throw new GitError(
      `Secret scan blocked commit (${findings.length} finding(s)): ${summary}`,
    );
  }

  await runGit(dir, ["add", "-A"]);
  return runGit(dir, ["commit", "-m", message], {
    allowFail: options.allowEmpty,
  });
}

/**
 * Stage and commit only the given relative paths (never git add -A).
 * Leaves other dirty files unstaged/uncommitted.
 */
export async function commitPaths(
  dir: string,
  message: string,
  relPaths: string[],
  options: { allowEmpty?: boolean } = {},
): Promise<GitResult | null> {
  if (!relPaths.length) {
    if (options.allowEmpty) {
      return runGit(dir, ["commit", "--allow-empty", "-m", message], {
        allowFail: true,
      });
    }
    return null;
  }

  // Normalize to forward-slash relative paths under dir
  const unique = [
    ...new Set(
      relPaths
        .map((p) => p.replace(/\\/g, "/").replace(/^\.?\//, ""))
        .filter(Boolean),
    ),
  ];

  // Secret scan ONLY the files we intend to commit
  const findings = await scanPathsForSecrets(dir, unique);
  if (findings.length > 0) {
    const summary = findings
      .slice(0, 5)
      .map((f) => `${f.path}:${f.line} ${f.rule} ${f.preview}`)
      .join("; ");
    throw new GitError(
      `Secret scan blocked commit (${findings.length} finding(s)): ${summary}`,
    );
  }

  // Stage only these paths (pathspec). Use -- to stop option parsing.
  await runGit(dir, ["add", "--", ...unique]);

  // If nothing staged, skip commit unless allowEmpty
  const staged = await runGit(dir, ["diff", "--cached", "--name-only", "-z"], {
    allowFail: true,
  });
  const stagedNames = (staged.stdout || "")
    .split("\0")
    .map((s) => s.trim())
    .filter(Boolean);
  if (stagedNames.length === 0 && !options.allowEmpty) {
    return null;
  }

  return runGit(dir, ["commit", "-m", message], {
    allowFail: options.allowEmpty,
  });
}

export async function pushRepo(dir: string): Promise<GitResult> {
  const safety = await inspectGitSafety(dir);
  if (safety.diverged) {
    throw new GitError("Refusing to push: branch has diverged from upstream");
  }
  if (safety.dirty) {
    throw new GitError("Refusing to push: uncommitted changes remain");
  }
  return runGit(dir, ["push"]);
}

/** Parse `git status --porcelain=v1 -z` into path list (handles rename, quotes, unicode). */
export function parsePorcelainZ(stdout: string): string[] {
  if (!stdout) return [];
  const paths: string[] = [];
  const parts = stdout.split("\0").filter((p) => p.length > 0);
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]!;
    // Format: XY <path> or XY <old>\0<new> for renames (R/C)
    if (entry.length < 3) continue;
    const xy = entry.slice(0, 2);
    const rest = entry.slice(3);
    if (xy[0] === "R" || xy[0] === "C" || xy[1] === "R" || xy[1] === "C") {
      // next null-separated field is the new path
      const next = parts[i + 1];
      if (next) {
        paths.push(next);
        i++;
      } else if (rest) {
        paths.push(rest.split(" -> ").pop()!.trim());
      }
    } else {
      // strip optional quotes
      const p = rest.replace(/^"|"$/g, "").trim();
      if (p) paths.push(p);
    }
  }
  return paths;
}

export async function scanPathsForSecrets(
  dir: string,
  relPaths: string[],
): Promise<SecretFinding[]> {
  const findings: SecretFinding[] = [];
  for (const filePath of relPaths) {
    if (
      filePath.endsWith(".png") ||
      filePath.endsWith(".jpg") ||
      filePath.endsWith(".zip") ||
      filePath.endsWith(".woff")
    ) {
      continue;
    }
    const full = path.join(dir, filePath);
    if (!(await pathExists(full))) continue;
    try {
      const st = await (await import("node:fs/promises")).stat(full);
      if (st.isDirectory()) {
        // Scan files under vendor dirs
        const { listFilesRecursive, readText } = await import(
          "@ai-config-sync/core"
        );
        const files = await listFilesRecursive(full, { maxDepth: 6 });
        for (const f of files) {
          const rel = path.relative(dir, f).replace(/\\/g, "/");
          try {
            const text = await readText(f);
            findings.push(...scanTextForSecrets(text, rel));
          } catch {
            /* binary */
          }
        }
        continue;
      }
      const { readText } = await import("@ai-config-sync/core");
      const text = await readText(full);
      findings.push(...scanTextForSecrets(text, filePath));
    } catch {
      /* binary or unreadable */
    }
  }
  return findings;
}

export async function scanWorkingTreeSecrets(
  dir: string,
): Promise<SecretFinding[]> {
  const status = await runGit(dir, ["status", "--porcelain=v1", "-z"], {
    allowFail: true,
  });
  if (status.code !== 0 || !status.stdout) return [];
  const paths = parsePorcelainZ(status.stdout);
  return scanPathsForSecrets(dir, paths);
}

/** Normalize remote URLs for comparison. */
export function remotesMatch(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  const norm = (u: string) =>
    u
      .trim()
      .replace(/\.git$/i, "")
      .replace(/^git@github\.com:/i, "github.com/")
      .replace(/^https?:\/\/github\.com\//i, "github.com/")
      .replace(/\/+$/, "")
      .toLowerCase();
  return norm(a) === norm(b);
}

export {
  resolveCachedSource,
  listCachedSources,
  type ResolveSourceOptions,
  type ResolvedSource,
} from "./source-cache.js";
