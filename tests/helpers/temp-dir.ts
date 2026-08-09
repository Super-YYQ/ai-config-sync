import fs from "node:fs/promises";

/**
 * Windows virus scanners and child processes can briefly retain directory
 * handles after a test finishes. Use Node's bounded recursive retry support so
 * teardown remains deterministic without hiding a permanently leaked handle.
 */
export async function removeTempDir(root: string | undefined): Promise<void> {
  if (!root) return;
  await fs.rm(root, {
    recursive: true,
    force: true,
    maxRetries: process.platform === "win32" ? 8 : 2,
    retryDelay: 125,
  });
}
