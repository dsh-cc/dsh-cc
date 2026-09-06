#!/usr/bin/env node
/**
 * Reject legacy project identities anywhere in the tracked source tree.
 * Keep the marker fragments split so this checker does not match itself.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SKIP_DIRS = new Set([".git", ".verify", "coverage", "lib", "node_modules"]);
const LEGACY_OWNER = "jian" + "xx";
const LEGACY_MARKERS = [
  `@${LEGACY_OWNER}`,
  `github.com/${LEGACY_OWNER}/dsh-cc`,
  `${LEGACY_OWNER}/deepseek-harness`,
];

function* eachFile(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* eachFile(path);
    else yield path;
  }
}

const violations = [];
for (const path of eachFile(ROOT)) {
  const content = readFileSync(path);
  if (content.includes(0)) continue;
  const text = content.toString("utf8");
  for (const marker of LEGACY_MARKERS) {
    if (text.includes(marker)) {
      violations.push(`${relative(ROOT, path)} contains '${marker}'`);
    }
  }
}

if (violations.length) {
  console.error("check:identity — legacy project identities found:\n");
  for (const violation of violations) console.error(`  ${violation}`);
  process.exitCode = 1;
} else {
  console.log("check:identity OK — canonical @dsh-cc and dsh-cc/* identities only");
}
