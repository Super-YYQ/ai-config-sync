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
  options: { overwrite?: boolean } = {},
): Promise<void> {
  const overwrite = options.overwrite ?? true;
  if (!(await pathExists(src))) {
    throw new Error(`Source directory does not exist: ${src}`);
  }
  if ((await pathExists(dest)) && !overwrite) {
    throw new Error(`Destination already exists: ${dest}`);
  }
  await fs.cp(src, dest, {
    recursive: true,
    force: overwrite,
    errorOnExist: !overwrite,
  });
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
