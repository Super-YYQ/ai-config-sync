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
  const status = await runGit(dir, ["status", "--porcelain"]);
  if (!status.stdout.trim() && !options.allowEmpty) return null;

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

export async function scanWorkingTreeSecrets(
  dir: string,
): Promise<SecretFinding[]> {
  const status = await runGit(dir, ["status", "--porcelain"], {
    allowFail: true,
  });
  if (status.code !== 0 || !status.stdout.trim()) return [];

  const findings: SecretFinding[] = [];
  const lines = status.stdout.split("\n").filter(Boolean);
  for (const line of lines) {
    // XY path or rename
    const filePath = line.slice(3).split(" -> ").pop()!.trim().replace(/^"|"$/g, "");
    if (!filePath) continue;
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
      const { readText } = await import("@ai-config-sync/core");
      const text = await readText(full);
      findings.push(...scanTextForSecrets(text, filePath));
    } catch {
      /* binary or unreadable */
    }
  }
  return findings;
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
