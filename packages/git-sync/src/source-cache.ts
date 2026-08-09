import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import {
  cacheDir,
  ensureDir,
  pathExists,
  type Source,
} from "@ai-config-sync/core";

const execFileAsync = promisify(execFile);

function remotesMatch(a?: string, b?: string): boolean {
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

/**
 * Fail-closed git wrapper. Errors THROW (no silent allowFail swallowing), so
 * a failed fetch/checkout/pull aborts source resolution instead of leaving a
 * cache on an unknown commit. HEAD is always verified after any operation.
 */
async function git(
  cwd: string,
  args: string[],
): Promise<{ stdout: string; code: number }> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
    });
    return { stdout: stdout.trimEnd(), code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; code?: number; message?: string };
    const stderr = (e.stdout ?? "").toString();
    throw new Error(
      `git ${args.join(" ")} failed: ${(e.message ?? "").trim()}${
        stderr ? ` (out: ${stderr.trim().slice(0, 200)})` : ""
      }`,
    );
  }
}

async function gitMaybe(
  cwd: string,
  args: string[],
): Promise<{ stdout: string; code: number } | undefined> {
  try {
    return await git(cwd, args);
  } catch {
    return undefined;
  }
}

export interface ResolveSourceOptions {
  home: string;
  ref?: string;
  update?: boolean;
  offline?: boolean;
}

export interface ResolvedSource {
  root: string;
  fromCache: boolean;
  commit?: string;
  remote?: string;
}

function githubHttpsUrl(repository: string): string {
  const repo = repository
    .replace(/\.git$/i, "")
    .replace(/^https?:\/\/github\.com\//i, "");
  return `https://github.com/${repo}.git`;
}

/** Filesystem-safe cache key from a remote URL/repository. */
function cacheKey(source: Source): string {
  if (source.repository) {
    return source.repository.replace(/[\\/:]/g, "__").replace(/\.git$/i, "");
  }
  if (source.url) {
    return source.url.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120);
  }
  return "unknown";
}

/**
 * Validate a git remote URL / repository string. Fail-closed against the
 * injection vectors noted in the review:
 *  - only https:// (and ssh git@host:scp-style) protocols; no file://, no
 *    untrusted transports
 *  - no leading '-' (option injection), no control chars, no NUL
 *  - no embedded credentials (user:pass@) which would leak into commits/logs
 */
export function validateGitRemote(remote: string): string {
  if (typeof remote !== "string" || remote.length === 0) {
    throw new Error(`Empty git remote`);
  }
  // Reject control chars and NUL outright
  if (/[\x00-\x1f\x7f]/.test(remote)) {
    throw new Error(`git remote contains control characters: ${remote}`);
  }
  // Reject leading dash (option injection to git itself)
  if (/^-/.test(remote)) {
    throw new Error(`git remote must not start with '-': ${remote}`);
  }
  // Reject embedded credentials user:pass@host (credentials must not be in repo)
  if (/^[^@\s]+:[^@\s/]+@/.test(remote)) {
    throw new Error(
      `git remote must not embed credentials (user:pass@): ${remote}`,
    );
  }
  // Allowed protocols: https:// and ssh scp-style git@host:path
  const isHttps = /^https:\/\/[^\s]+$/i.test(remote);
  const isSshScp = /^git@[\w.-]+:[^\s]+$/i.test(remote);
  if (!isHttps && !isSshScp) {
    throw new Error(
      `git remote protocol not allowed (use https:// or git@host:): ${remote}`,
    );
  }
  // Disallow file:// / local paths entirely
  if (/^(file|ssh|git|rsync):\/\//i.test(remote) && !isHttps) {
    throw new Error(`git remote transport not allowed: ${remote}`);
  }
  return remote;
}

/**
 * Validate a git ref (branch / tag / commit-ish). Fail-closed against option
 * injection and unsafe chars. Commit hashes are validated separately; refs may
 * contain `/` (branch) but must not start with '-' or contain control chars.
 */
export function validateGitRef(ref: string): string {
  if (typeof ref !== "string" || ref.length === 0) {
    throw new Error(`Empty git ref`);
  }
  if (ref.length > 200) {
    throw new Error(`git ref too long: ${ref}`);
  }
  if (/[\x00-\x1f\x7f]/.test(ref)) {
    throw new Error(`git ref contains control characters`);
  }
  if (/^-/.test(ref)) {
    throw new Error(`git ref must not start with '-': ${ref}`);
  }
  // Reject option-like tokens and path traversal refs
  if (/^(--|-|\.\.|\.lock|@{)/.test(ref)) {
    throw new Error(`git ref rejected (unsafe/option-like): ${ref}`);
  }
  // Disallow backslash (Windows path sep) and spaces in refs (git forbids)
  if (/[\s\\]/.test(ref)) {
    throw new Error(`git ref must not contain spaces/backslashes: ${ref}`);
  }
  // Allow alnum, /, -, ., _ (branches, tags) and full hex commit hashes
  if (!/^[A-Za-z0-9._/+-]+$/.test(ref)) {
    throw new Error(`git ref contains disallowed characters: ${ref}`);
  }
  return ref;
}

/**
 * Resolve a local directory for a resource source.
 * Order: absolute path -> git cache under ~/.ai-config-sync/cache/sources.
 *
 * P0 hardening: remote/ref validated, git ops fail-closed, final HEAD
 * verified, per-cache lock, non-Git cache dir rejected (removed or blocked).
 */
export async function resolveCachedSource(
  source: Source | undefined,
  options: ResolveSourceOptions,
): Promise<ResolvedSource | undefined> {
  if (!source) return undefined;

  // Absolute local path: keep as-is (already validated elsewhere as vendored)
  if (source.path && path.isAbsolute(source.path) && (await pathExists(source.path))) {
    return { root: source.path, fromCache: false };
  }

  const remote =
    source.url ??
    (source.repository ? githubHttpsUrl(source.repository) : undefined);

  if (!remote && !source.repository) return undefined;
  if (!remote) return undefined;

  // Validate the remote URL/repo string BEFORE touching git.
  validateGitRemote(remote);

  const key = cacheKey(source);
  const root = path.join(cacheDir(options.home), "sources", key);
  await ensureDir(path.dirname(root));

  // Per-cache lock so two concurrent clones/checkouts on the same cache dir
  // don't corrupt each other.
  const lockPath = `${root}.lock`;
  await ensureDir(path.dirname(root));
  let lockHandle: fs.FileHandle | undefined;
  const lockOwnerId = crypto.randomUUID();
  let ownsLock = false;
  let lockWritten = false;
  try {
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        lockHandle = await fs.open(lockPath, "wx");
        ownsLock = true;
        break;
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code !== "EEXIST") throw e;
        // Stale-lock break: owner dead or older than 30 min
        let stale = false;
        try {
          const raw = await fs.readFile(lockPath, "utf8");
          const existing = JSON.parse(raw) as {
            pid?: number;
            startedAt?: string;
          };
          let ownerAlive: boolean | undefined;
          if (existing.pid) {
            if (existing.pid === process.pid) {
              ownerAlive = true;
            } else {
              try {
                process.kill(existing.pid, 0);
                ownerAlive = true;
              } catch (e) {
                ownerAlive = (e as NodeJS.ErrnoException).code === "EPERM";
              }
            }
          }
          if (existing.startedAt && ownerAlive !== true) {
            const age = Date.now() - Date.parse(existing.startedAt);
            if (Number.isFinite(age) && age > 30 * 60 * 1000) stale = true;
          }
          if (ownerAlive === false) stale = true;
          if (stale) {
            await fs.rm(lockPath, { force: true });
            continue;
          }
        } catch {
          await fs.rm(lockPath, { force: true }).catch(() => {});
          continue;
        }
        await new Promise((r) => setTimeout(r, 50 + attempt * 30));
      }
    }
    if (!lockHandle) {
      throw new Error(`Source cache lock busy: ${lockPath}`);
    }
    await lockHandle.writeFile(
      JSON.stringify(
        {
          pid: process.pid,
          startedAt: new Date().toISOString(),
          ownerId: lockOwnerId,
          cache: root,
        },
        null,
        2,
      ),
      "utf8",
    );
    await lockHandle.close();
    lockHandle = undefined;
    lockWritten = true;

    return await resolveUnderLock(root, remote, source, options);
  } finally {
    if (lockHandle) {
      try {
        await lockHandle.close();
      } catch {
        /* ignore */
      }
      lockHandle = undefined;
    }
    if (ownsLock) {
      try {
        if (!lockWritten) {
          await fs.rm(lockPath, { force: true });
        } else {
          const raw = await fs.readFile(lockPath, "utf8");
          const current = JSON.parse(raw) as { ownerId?: string };
          if (current.ownerId === lockOwnerId) {
            await fs.rm(lockPath, { force: true });
          }
        }
      } catch {
        /* already gone or replaced */
      }
    }
  }
}

async function resolveUnderLock(
  root: string,
  remote: string,
  source: Source,
  options: ResolveSourceOptions,
): Promise<ResolvedSource | undefined> {
  if (await pathExists(root)) {
    // Fail-closed: a cache dir that isn't a git repo is NOT trusted as a
    // source (could be a planted malicious tree). Reject instead of using it.
    const inside = await gitMaybe(root, ["rev-parse", "--is-inside-work-tree"]);
    if (!inside || inside.code !== 0 || inside.stdout.trim() !== "true") {
      throw new Error(
        `Cache path ${root} is not a git repository (refusing to use non-Git cache)`,
      );
    }
    const remoteResult = await gitMaybe(root, ["remote", "get-url", "origin"]);
    const existingRemote =
      remoteResult && remoteResult.code === 0
        ? remoteResult.stdout.trim()
        : undefined;
    if (existingRemote && !remotesMatch(remote, existingRemote)) {
      throw new Error(
        `Cache path ${root} has remote ${existingRemote}, expected ${remote}`,
      );
    }

    const want = options.ref ?? source.commit ?? source.ref;
    let fetched = false;
    if (options.update && !options.offline) {
      // Fail-closed fetch: a failed fetch aborts (no partial/unknown state).
      await git(root, ["fetch", "--tags", "--force"]);
      fetched = true;
    }
    if (want) {
      validateGitRef(want);
      const resolveDesired = async () => {
        const candidates = fetched
          ? [`refs/remotes/origin/${want}^{commit}`, `${want}^{commit}`]
          : [`${want}^{commit}`];
        for (const candidate of candidates) {
          const resolved = await gitMaybe(root, ["rev-parse", "--verify", candidate]);
          if (resolved?.stdout.trim()) return resolved;
        }
        return undefined;
      };
      let desired = await resolveDesired();
      if ((!desired || !desired.stdout.trim()) && !options.offline) {
        if (!fetched) {
          await git(root, ["fetch", "--tags", "--force"]);
          fetched = true;
        }
        desired = await resolveDesired();
      }
      if (!desired?.stdout.trim()) {
        throw new Error(`Requested git ref is unavailable in source cache: ${want}`);
      }
      const head = await git(root, ["rev-parse", "HEAD"]);
      const desiredCommit = desired.stdout.trim();
      if (head.stdout.trim() !== desiredCommit) {
        await git(root, ["checkout", "--detach", desiredCommit]);
        const checkedOut = await git(root, ["rev-parse", "HEAD"]);
        if (checkedOut.stdout.trim() !== desiredCommit) {
          throw new Error(
            `Source cache checkout mismatch for ${want}: expected ${desiredCommit}, got ${checkedOut.stdout.trim()}`,
          );
        }
      }
    } else if (options.update && !options.offline) {
      await git(root, ["pull", "--ff-only"]);
    }

    // Always verify the final HEAD - never return a cache whose commit we
    // could not confirm.
    const head = await git(root, ["rev-parse", "HEAD"]);
    const dirty = await git(root, ["status", "--porcelain", "--untracked-files=all"]);
    if (dirty.stdout.trim()) {
      throw new Error(
        `Source cache has uncommitted or untracked changes; refusing mutable source: ${root}`,
      );
    }
    return {
      root,
      fromCache: true,
      commit: head.code === 0 ? head.stdout.trim() : undefined,
      remote: existingRemote ?? remote,
    };
  }

  if (options.offline) return undefined;

  const args = ["clone"];
  const ref = options.ref ?? source.commit ?? source.ref;
  if (!ref) args.push("--depth", "1");
  if (ref) validateGitRef(ref);
  args.push(remote, root);
  await ensureDir(path.dirname(root));
  await git(path.dirname(root), args);
  if (ref) await git(root, ["checkout", ref]);

  const head = await git(root, ["rev-parse", "HEAD"]);
  if (head.code !== 0 || !head.stdout.trim()) {
    throw new Error(
      `Source clone succeeded but HEAD could not be verified for ${remote}`,
    );
  }
  return {
    root,
    fromCache: true,
    commit: head.stdout.trim(),
    remote,
  };
}

export async function listCachedSources(home: string): Promise<string[]> {
  const root = path.join(cacheDir(home), "sources");
  if (!(await pathExists(root))) return [];
  const { readdir } = await import("node:fs/promises");
  return (await readdir(root)).map((n) => path.join(root, n));
}
