import fs from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { z, ZodTypeAny } from "zod";

export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

export async function readText(filePath: string): Promise<string> {
  return fs.readFile(filePath, "utf8");
}

export async function writeText(filePath: string, content: string): Promise<void> {
  await ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, content, "utf8");
  await fs.rename(tmp, filePath);
}

export async function readJsonFile<T>(filePath: string): Promise<T> {
  const raw = await readText(filePath);
  return JSON.parse(raw) as T;
}

export async function writeJsonFile(
  filePath: string,
  data: unknown,
  pretty = true,
): Promise<void> {
  const content = pretty
    ? `${JSON.stringify(data, null, 2)}\n`
    : JSON.stringify(data);
  await writeText(filePath, content);
}

export async function readYamlFile<T>(filePath: string): Promise<T> {
  const raw = await readText(filePath);
  return parseYaml(raw) as T;
}

export async function writeYamlFile(
  filePath: string,
  data: unknown,
): Promise<void> {
  const content = stringifyYaml(data, {
    lineWidth: 100,
    defaultStringType: "PLAIN",
  });
  await writeText(filePath, content);
}

export async function readValidatedYaml<S extends ZodTypeAny>(
  filePath: string,
  schema: S,
): Promise<z.output<S>> {
  const data = await readYamlFile<unknown>(filePath);
  return schema.parse(data) as z.output<S>;
}

export async function readValidatedJson<S extends ZodTypeAny>(
  filePath: string,
  schema: S,
): Promise<z.output<S>> {
  const data = await readJsonFile<unknown>(filePath);
  return schema.parse(data) as z.output<S>;
}

export function parseValidatedYaml<S extends ZodTypeAny>(
  raw: string,
  schema: S,
): z.output<S> {
  const data = parseYaml(raw);
  return schema.parse(data) as z.output<S>;
}

export async function listDirNames(dir: string): Promise<string[]> {
  if (!(await pathExists(dir))) return [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

export async function listFilesRecursive(
  root: string,
  options: { maxDepth?: number; ignoreNames?: string[] } = {},
): Promise<string[]> {
  const maxDepth = options.maxDepth ?? 8;
  const ignore = new Set(
    options.ignoreNames ?? ["node_modules", ".git", "dist", "coverage"],
  );
  const out: string[] = [];

  async function walk(current: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (ignore.has(entry.name)) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
  }

  await walk(root, 0);
  return out;
}

export async function copyDirectory(
  src: string,
  dest: string,
  options: { overwrite?: boolean; rejectSymlinks?: boolean } = {},
): Promise<void> {
  const overwrite = options.overwrite ?? true;
  const rejectSymlinks = options.rejectSymlinks ?? true;
  if (!(await pathExists(src))) {
    throw new Error(`Source directory does not exist: ${src}`);
  }
  if (rejectSymlinks) {
    try {
      const st = await fs.lstat(src);
      if (st.isSymbolicLink()) {
        throw new Error(`Symlink rejected as copy source: ${src}`);
      }
    } catch (e) {
      if ((e as Error).message?.startsWith("Symlink rejected")) throw e;
    }
  }
  if ((await pathExists(dest)) && !overwrite) {
    throw new Error(`Destination already exists: ${dest}`);
  }
  await fs.cp(src, dest, {
    recursive: true,
    force: overwrite,
    errorOnExist: !overwrite,
    // Node 18+: do not follow symlinks when copying
    // (dereference false is default for fs.cp in recent Node)
  });
}

/**
 * Atomically replace the entire destination directory with a copy of `src`.
 *
 * Unlike `copyDirectory(overwrite: true)` (which only overwrites same-named
 * files and leaves stale files behind), this swaps the whole target dir so a
 * source that deleted a file results in that file being removed at the target
 * - drift converges. Flow: copy src to a sibling temp dir -> remove dest ->
 * rename temp into place. On any error the temp dir is cleaned up and dest is
 * left untouched. Symlinks in src are rejected.
 *
 * Returns the absolute destination path.
 */
export async function atomicReplaceDirectory(
  src: string,
  dest: string,
  options: { rejectSymlinks?: boolean } = {},
): Promise<string> {
  const rejectSymlinks = options.rejectSymlinks ?? true;
  if (!(await pathExists(src))) {
    throw new Error(`Source directory does not exist: ${src}`);
  }
  if (rejectSymlinks) {
    const st = await fs.lstat(src);
    if (st.isSymbolicLink()) {
      throw new Error(`Symlink rejected as copy source: ${src}`);
    }
  }
  await ensureDir(path.dirname(dest));
  // Sibling temp so the rename stays on the same filesystem (atomic).
  const tmp = `${dest}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fs.cp(src, tmp, {
      recursive: true,
      force: true,
      // Reject symlinks inside the tree so a malicious source can't plant one
      dereference: false,
    });
    if (rejectSymlinks) {
      await assertNoSymlinksInTreeRaw(tmp);
    }
    if (await pathExists(dest)) {
      await fs.rm(dest, { recursive: true, force: true });
    }
    await fs.rename(tmp, dest).catch(async () => {
      // Cross-device fallback: recursive copy then rm temp
      await fs.cp(tmp, dest, { recursive: true, force: true });
      await fs.rm(tmp, { recursive: true, force: true });
    });
    return dest;
  } catch (e) {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
}

async function assertNoSymlinksInTreeRaw(root: string): Promise<void> {
  const stack = [root];
  while (stack.length) {
    const current = stack.pop()!;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Symlink rejected in source tree: ${full}`);
      }
      if (entry.isDirectory()) stack.push(full);
    }
  }
}

export async function removePath(target: string): Promise<void> {
  await fs.rm(target, { recursive: true, force: true });
}

export async function readDirTree(
  root: string,
  maxDepth = 3,
): Promise<string[]> {
  const files = await listFilesRecursive(root, { maxDepth });
  return files.map((f) => path.relative(root, f).replace(/\\/g, "/"));
}
