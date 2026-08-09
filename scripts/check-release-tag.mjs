import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const tag = process.env.GITHUB_REF_NAME || process.argv[2];
const expected = `v${pkg.version}`;

if (!tag) {
  console.error("Release tag missing. Pass vX.Y.Z or set GITHUB_REF_NAME.");
  process.exit(1);
}
if (tag !== expected) {
  console.error(`Release tag ${tag} does not match package version ${expected}.`);
  process.exit(1);
}

const changelog = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
const escapedVersion = pkg.version.replace(/\./g, "\\.");
if (!new RegExp(`^##\\s+(?:\\[)?${escapedVersion}(?:\\])?(?:\\s|—|-)`, "m").test(changelog)) {
  console.error(`CHANGELOG.md has no release heading for ${pkg.version}.`);
  process.exit(1);
}

console.log(`Release tag OK: ${tag}`);
