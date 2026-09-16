#!/usr/bin/env node
/**
 * daily-release-next-version.mjs <lastTag> <bump> — DEPRECATED for CI.
 *
 * Historically computed the next *stable line* from a stable baseline and
 * rejected prerelease tags (that rejection is what broke the 2026-09-15
 * daily-release run when the gate passed LAST_TAG=v0.7.1-rc.3).
 *
 * CI now uses `scripts/daily-release-decide.mjs` (RC ladder). This file
 * remains as a thin hand-use helper: given a stable `vX.Y.Z` baseline it
 * prints the next bare line version (no `-rc.N`) to stdout — same bump
 * rules as before (`auto` feat→minor else patch). Prefer decide.mjs for
 * anything that must handle an rc tip on main.
 *
 * Contract (hand use only):
 *   args: lastTag = `v<major>.<minor>.<patch>`; bump = auto|patch|minor
 *   stdout: bare next semver line (no `v`); diagnostics on stderr
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { nextLineVersion, parseStable } from "./daily-release-decide.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

function fail(msg) {
  console.error(`daily-release-next-version: ${msg}`);
  process.exit(1);
}

function git(...args) {
  return execFileSync("git", args, { encoding: "utf-8", cwd: ROOT }).trim();
}

console.error(
  "daily-release-next-version: DEPRECATED for CI — use daily-release-decide.mjs (RC ladder)",
);

const [lastTag, bump] = process.argv.slice(2);
if (!parseStable(lastTag)) {
  fail(
    `invalid last tag '${lastTag ?? ""}'. Expected a stable v<major>.<minor>.<patch>; ` +
      "for RC-ladder decisions use: node scripts/daily-release-decide.mjs --bump auto",
  );
}
if (!["auto", "patch", "minor"].includes(bump)) {
  fail(`invalid bump '${bump ?? ""}'. Expected auto | patch | minor`);
}

/* ---- lockstep assertion: root manifest version must equal lastTag ---- */
const rootJson = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const rootVersion = rootJson.version;
if (`v${rootVersion}` !== lastTag) {
  fail(
    `lockstep broken: root package.json version (${rootVersion}) != last tag (${lastTag}). ` +
      `Likely a half-finished previous release. Recover with: git checkout main && git pull && ` +
      `git tag v${rootVersion} && git push origin v${rootVersion} && ` +
      `gh workflow run publish.yml -f tag=v${rootVersion}`,
  );
}

let hasFeat = false;
if (bump === "auto") {
  const subjects = git("log", "--format=%s", `${lastTag}..origin/main`);
  hasFeat = subjects.split("\n").some((s) => /^feat(?:\(|!|:)/.test(s));
}

console.log(nextLineVersion(lastTag, bump, hasFeat));
