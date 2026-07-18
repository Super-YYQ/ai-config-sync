import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
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

async function git(
  cwd: string,
  args: string[],
  allowFail = false,
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
    if (allowFail) {
      return {
        stdout: (e.stdout ?? "").toString(),
        code: typeof e.code === "number" ? e.code : 1,
      };
    }
    throw new Error(`git ${args.join(" ")} failed: ${e.message}`);
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
 * Resolve a local directory for a resource source.
 * Order: absolute path → git cache under ~/.ai-config-sync/cache/sources.
 */
export async function resolveCachedSource(
  source: Source | undefined,
  options: ResolveSourceOptions,
): Promise<ResolvedSource | undefined> {
  if (!source) return undefined;

  if (source.path && path.isAbsolute(source.path) && (await pathExists(source.path))) {
    return { root: source.path, fromCache: false };
  }

  const remote =
    source.url ??
    (source.repository
      ? githubHttpsUrl(source.repository)
      : undefined);

  if (!remote && !source.repository) return undefined;
  if (!remote) return undefined;

  const key = cacheKey(source);
  const root = path.join(cacheDir(options.home), "sources", key);
  await ensureDir(path.dirname(root));

  if (await pathExists(root)) {
    const inside = await git(root, ["rev-parse", "--is-inside-work-tree"], true);
    if (inside.code === 0 && inside.stdout.trim() === "true") {
      const remoteResult = await git(root, ["remote", "get-url", "origin"], true);
      const existingRemote =
        remoteResult.code === 0 ? remoteResult.stdout.trim() : undefined;
      if (existingRemote && !remotesMatch(remote, existingRemote)) {
        throw new Error(
          `Cache path ${root} has remote ${existingRemote}, expected ${remote}`,
        );
      }
      if (options.update && !options.offline) {
        await git(root, ["fetch", "--tags", "--force"], true);
        const ref = options.ref ?? source.commit ?? source.ref;
        if (ref) await git(root, ["checkout", ref], true);
        else await git(root, ["pull", "--ff-only"], true);
      } else if (options.ref || source.commit) {
        const want = options.ref ?? source.commit!;
        const head = await git(root, ["rev-parse", "HEAD"], true);
        if (
          head.code === 0 &&
          !head.stdout.startsWith(want) &&
          want.length >= 7
        ) {
          if (!options.offline) await git(root, ["fetch", "--tags", "--force"], true);
          await git(root, ["checkout", want], true);
        }
      }
      const head = await git(root, ["rev-parse", "HEAD"], true);
      return {
        root,
        fromCache: true,
        commit: head.code === 0 ? head.stdout.trim() : undefined,
        remote: existingRemote ?? remote,
      };
    }
    return { root, fromCache: true };
  }

  if (options.offline) return undefined;

  const args = ["clone"];
  const ref = options.ref ?? source.commit ?? source.ref;
  if (!ref) args.push("--depth", "1");
  args.push(remote, root);
  await ensureDir(path.dirname(root));
  await git(path.dirname(root), args);
  if (ref) await git(root, ["checkout", ref], true);

  const head = await git(root, ["rev-parse", "HEAD"], true);
  return {
    root,
    fromCache: true,
    commit: head.code === 0 ? head.stdout.trim() : undefined,
    remote,
  };
}

export async function listCachedSources(home: string): Promise<string[]> {
  const root = path.join(cacheDir(home), "sources");
  if (!(await pathExists(root))) return [];
  const { readdir } = await import("node:fs/promises");
  return (await readdir(root)).map((n) => path.join(root, n));
}
