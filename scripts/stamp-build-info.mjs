#!/usr/bin/env node
// stamp-build-info.mjs — write the dev-build stamp consumed by `dsh-cc --version`
// (see docs/plans/2026-09-13-dev-build-version-stamp.md §3.1). Best-effort:
// every probe failing yields null fields; the script never throws and always
// exits 0. Usage: node scripts/stamp-build-info.mjs <output-path>
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = process.argv[2];
if (!out) {
  console.error("usage: node scripts/stamp-build-info.mjs <output-path>");
  process.exit(2);
}

function tryOrNull(fn) {
  try {
    return fn();
  } catch {
    return null;
  }
}

const git = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

// Best-effort: locate the on-PATH dsh-cc launcher and read its package.json
// version. Never spawns the launcher (a probe must stay sub-millisecond).
function launcherVersion() {
  return tryOrNull(() => {
    for (const dir of (process.env.PATH ?? "").split(":")) {
      if (!dir) continue;
      try {
        const real = realpathSync(join(dir, "dsh-cc")); // throws when absent
        if (!statSync(real).isFile()) continue; // a directory named dsh-cc is not a launcher
        const version = JSON.parse(readFileSync(join(dirname(real), "..", "package.json"), "utf8")).version;
        if (typeof version === "string" && version) return version;
      } catch {
        /* keep scanning */
      }
    }
    return null;
  });
}

const commit = tryOrNull(() => git(["rev-parse", "--short=12", "HEAD"]));
const info = {
  channel: "dev",
  version: tryOrNull(() => JSON.parse(readFileSync(join(root, "packages/launcher/tui/package.json"), "utf8")).version),
  launcherVersion: launcherVersion(),
  commit,
  branch: tryOrNull(() => git(["rev-parse", "--abbrev-ref", "HEAD"])),
  dirty: tryOrNull(() => git(["status", "--porcelain"]).length > 0),
  syncedAt: new Date().toISOString(),
  syncedFrom: root,
};

const tmp = out + ".tmp";
try {
  writeFileSync(tmp, JSON.stringify(info, null, 2) + "\n");
  renameSync(tmp, out); // same-directory rename: atomic on POSIX
  console.log(`stamped dev build info -> ${out} (commit=${info.commit} dirty=${info.dirty} launcherVersion=${info.launcherVersion})`);
} catch (error) {
  // A sync must never fail over metadata (the worst case is no stamp, i.e.
  // `dsh-cc --version` falls back to the bare release version).
  console.error(`stamp-build-info: could not write ${out}: ${/** @type {Error} */ (error).message}`);
}
