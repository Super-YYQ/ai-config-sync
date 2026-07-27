import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { ensureDir, pathExists } from "@ai-config-sync/core";

export interface LockPayload {
  pid: number;
  startedAt: string;
  /** Free-form scope label, e.g. "config-repo" or "home-target". */
  scope: string;
  /** Absolute path this lock guards (config repo dir or home). */
  target: string;
  command: string;
}

export interface AcquireOptions {
  /** Total attempts before giving up (default 50). */
  maxAttempts?: number;
  /** Per-wait base delay ms (default 50). */
  baseDelayMs?: number;
  /** Per-attempt delay step ms (default 30). */
  stepDelayMs?: number;
  /** Stale-lock age in ms before force-breaking (default 30 min). */
  staleMs?: number;
  /** Test hook: throw after acquiring (used to assert release). */
  injectThrowAfterAcquire?: boolean;
}

/**
 * Cross-process filesystem mutex over a single lock file.
 *
 * - acquireLock fails closed (O_EXCL `wx` open) so two processes never share it
 * - stale locks (owner dead or older than staleMs) are broken safely
 * - call within try/finally + releaseLock; never hold across unbounded work
 *
 * Returns the lock file path so the (caller-controlled) finally can release it.
 */
export async function acquireFileLock(
  lockPath: string,
  payload: LockPayload,
  options: AcquireOptions = {},
): Promise<string> {
  const maxAttempts = options.maxAttempts ?? 50;
  const baseDelay = options.baseDelayMs ?? 50;
  const stepDelay = options.stepDelayMs ?? 30;
  const staleMs = options.staleMs ?? 30 * 60 * 1000;

  await ensureDir(path.dirname(lockPath));

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const fh = await fs.open(lockPath, "wx");
      await fh.writeFile(JSON.stringify(payload, null, 2), "utf8");
      await fh.close();
      if (options.injectThrowAfterAcquire) {
        // Acquired then immediately failed: must not leak the lock file.
        await fs.rm(lockPath, { force: true }).catch(() => {});
        throw new Error("injectThrowAfterAcquire");
      }
      return lockPath;
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== "EEXIST") throw e;
      // Stale-lock heuristics
      let stale = false;
      try {
        const raw = await fs.readFile(lockPath, "utf8");
        const existing = JSON.parse(raw) as {
          pid?: number;
          startedAt?: string;
        };
        if (existing.startedAt) {
          const age = Date.now() - Date.parse(existing.startedAt);
          if (Number.isFinite(age) && age > staleMs) stale = true;
        }
        if (existing.pid && existing.pid !== process.pid) {
          try {
            process.kill(existing.pid, 0);
          } catch {
            stale = true; // process no longer alive
          }
        }
        if (stale) {
          await fs.rm(lockPath, { force: true });
          continue;
        }
      } catch {
        // unreadable / corrupt lock — break and retry
        await fs.rm(lockPath, { force: true }).catch(() => {});
        continue;
      }
      await new Promise((r) => setTimeout(r, baseDelay + attempt * stepDelay));
    }
  }
  throw new Error(
    `Lock busy (${payload.scope} on ${payload.target}): ${lockPath}`,
  );
}

export async function releaseFileLock(lockPath: string): Promise<void> {
  try {
    await fs.rm(lockPath, { force: true });
  } catch {
    /* ignore — released or already gone */
  }
}

/** Stable lock file path for a given target under a base dir. */
export function lockFilePath(
  baseDir: string,
  scope: string,
  targetPath: string,
): string {
  // Deterministic, filesystem-safe key from the guarded target.
  const key = crypto
    .createHash("sha256")
    .update(path.resolve(targetPath))
    .digest("hex")
    .slice(0, 16);
  return path.join(baseDir, `${scope}-${key}.lock`);
}

/** Run `work` while holding the lock; always release in finally. */
export async function withFileLock<T>(
  lockPath: string,
  payload: LockPayload,
  work: () => Promise<T>,
  options: AcquireOptions = {},
): Promise<T> {
  await acquireFileLock(lockPath, payload, options);
  try {
    return await work();
  } finally {
    await releaseFileLock(lockPath);
  }
}

/** True when a lock file currently exists (diagnostic / tests). */
export async function isLockHeld(lockPath: string): Promise<boolean> {
  return pathExists(lockPath);
}
