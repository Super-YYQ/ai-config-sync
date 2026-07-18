/**
 * Optional helper: initialize a private config repo from the bundled template.
 * Usage: npx tsx scripts/init-config-repo.ts ~/ai-config/my-ai-config
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dest = process.argv[2];
if (!dest) {
  console.error("Usage: tsx scripts/init-config-repo.ts <dest-dir>");
  process.exit(1);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "examples", "private-config-template");
const absDest = path.resolve(dest);

await fs.cp(src, absDest, { recursive: true, errorOnExist: true, force: false });
console.log(`Initialized private config template at ${absDest}`);
console.log(`Next: ai-config-sync setup --config-path ${absDest} --profile home`);
