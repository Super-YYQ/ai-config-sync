/**
 * Safely vendor a local skill directory into the private config repo.
 * Excludes secrets, VCS, and heavy caches. Scans for secrets before write.
 */
import fs from "node:fs/promises";
import path from "node:path";
import {
  ensureDir,
  pathExists,
  scanTextForSecrets,
  hashDirectory,
  shortHash,
  listFilesRecursive,
  readText,
  vendorSkillRelPath,
  safeJoin,
  assertSafeRelPath,
} from "@ai-config-sync/core";

const SKIP_DIR_NAMES = new Set([
  ".git",
  "node_modules",
  "dist",
  "coverage",
  "cache",
  "logs",
  ".cache",
  "__pycache__",
  ".venv",
  "venv",
]);

const SKIP_FILE_GLOBS = [
  /^\.env($|\.)/i,
  /^auth\.json$/i,
  /\.key$/i,
  /\.pem$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /id_rsa/i,
  /id_ed25519/i,
  /\.secret\./i,
];

export interface VendorResult {
  ok: boolean;
  destRel: string;
  destAbs: string;
  hash?: string;
  filesCopied: number;
  blockedSecrets: Array<{ path: string; rule: string }>;
  message: string;
}

function shouldSkipFile(name: string): boolean {
  return SKIP_FILE_GLOBS.some((re) => re.test(name));
}

/**
 * Copy skill source into configRepo/sources/skills/<storageKey>
 * When stagingRoot is provided, write under stagingRoot instead of configRepoPath
 * (used for transactional capture).
 */
export async function vendorSkillDirectory(
  sourceDir: string,
  configRepoPath: string,
  resourceId: string,
  options: { stagingRoot?: string } = {},
): Promise<VendorResult> {
  const destRel = assertSafeRelPath(vendorSkillRelPath(resourceId));
  const baseRoot = options.stagingRoot ?? configRepoPath;
  const destAbs = safeJoin(baseRoot, destRel);

  if (!(await pathExists(sourceDir))) {
    return {
      ok: false,
      destRel,
      destAbs,
      filesCopied: 0,
      blockedSecrets: [],
      message: `source missing: ${sourceDir}`,
    };
  }

  const files = await listFilesRecursive(sourceDir, {
    ignoreNames: [...SKIP_DIR_NAMES],
  });

  const blockedSecrets: Array<{ path: string; rule: string }> = [];
  const toCopy: string[] = [];

  for (const full of files) {
    const base = path.basename(full);
    if (shouldSkipFile(base)) continue;
    const rel = path.relative(sourceDir, full);
    // skip nested skip dirs already handled by listFilesRecursive ignore
    try {
      const text = await readText(full);
      const findings = scanTextForSecrets(text, rel);
      if (findings.length) {
        for (const f of findings) {
          blockedSecrets.push({ path: rel, rule: f.rule });
        }
        continue;
      }
    } catch {
      // binary — copy if not skipped by name
    }
    toCopy.push(full);
  }

  if (blockedSecrets.length) {
    return {
      ok: false,
      destRel,
      destAbs,
      filesCopied: 0,
      blockedSecrets,
      message: `Secret scan blocked vendor (${blockedSecrets.length} finding(s))`,
    };
  }

  if (await pathExists(destAbs)) {
    await fs.rm(destAbs, { recursive: true, force: true });
  }
  await ensureDir(destAbs);

  let copied = 0;
  for (const full of toCopy) {
    const rel = path.relative(sourceDir, full);
    const out = path.join(destAbs, rel);
    await ensureDir(path.dirname(out));
    await fs.copyFile(full, out);
    copied++;
  }

  // Ensure SKILL.md if source had it
  const hash = shortHash(await hashDirectory(destAbs));
  return {
    ok: true,
    destRel,
    destAbs,
    hash,
    filesCopied: copied,
    blockedSecrets: [],
    message: `vendored ${copied} file(s) → ${destRel}`,
  };
}
