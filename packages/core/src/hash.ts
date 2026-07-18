import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { listFilesRecursive, pathExists } from "./fs.js";

export async function hashFile(filePath: string): Promise<string> {
  const data = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(data).digest("hex");
}

export async function hashDirectory(
  dir: string,
  options: { ignoreNames?: string[] } = {},
): Promise<string> {
  if (!(await pathExists(dir))) {
    throw new Error(`Directory not found: ${dir}`);
  }
  const files = (
    await listFilesRecursive(dir, {
      ignoreNames: options.ignoreNames,
    })
  ).sort((a, b) => a.localeCompare(b));

  const hash = crypto.createHash("sha256");
  for (const file of files) {
    const rel = path.relative(dir, file).replace(/\\/g, "/");
    hash.update(rel);
    hash.update("\0");
    const content = await fs.readFile(file);
    hash.update(content);
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function shortHash(hex: string, len = 12): string {
  return hex.slice(0, len);
}
