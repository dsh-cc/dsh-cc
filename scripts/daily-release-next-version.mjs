#!/usr/bin/env node
/**
 * daily-release-next-version.mjs <lastTag> <bump>
 *
 * Compatibility entry used by the *pre-#83* `.github/workflows/daily-release.yml`
 * which still runs:
 *   NEXT=$(node scripts/daily-release-next-version.mjs "$LAST_TAG" "$BUMP")
 *
 * #83 landed `daily-release-decide.mjs` but could not update the workflow
 * (PAT lacked `workflows` scope). Calling the old stable-only logic with an
 * rc tip (e.g. v0.7.1-rc.3) crashed manual/scheduled runs.
 *
 * Under GitHub Actions (or with `--decide`), ignore lastTag and run the RC
 * ladder via decide():
 *   - action=propose → print bare version to stdout (for release.mjs)
 *   - action=skip    → print __daily_release_skip__ (release.mjs no-ops)
 *
 * Outside CI, keep the historical hand helper: stable baseline only.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  decide,
  gatherInputFromGit,
  nextLineVersion,
  parseStable,
} from "./daily-release-decide.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

/** Sentinel consumed by release.mjs so old workflow dry-run/propose steps exit 0 on skip. */
export const DAILY_RELEASE_SKIP_SENTINEL = "__daily_release_skip__";

function fail(msg) {
  console.error(`daily-release-next-version: ${msg}`);
  process.exit(1);
}

function git(...args) {
  return execFileSync("git", args, { encoding: "utf-8", cwd: ROOT }).trim();
}

function runDecideLadder(bump) {
  if (!["auto", "patch", "minor"].includes(bump)) {
    fail(`invalid bump '${bump ?? ""}'. Expected auto | patch | minor`);
  }
  let input;
  try {
    input = gatherInputFromGit(bump);
  } catch (e) {
    fail(e.message || String(e));
  }
  console.error(
    `daily-release-next-version: CI/decide path lastStable=${input.lastStable} ` +
      `latestRc=${input.latestRcOnLine ?? "(none)"} bump=${bump}`,
  );
  let result;
  try {
    result = decide(input);
  } catch (e) {
    fail(e.message || String(e));
  }
  if (result.action === "skip") {
    console.error(
      `daily-release-next-version: decide skip reason=${result.reason} ` +
        `(printing ${DAILY_RELEASE_SKIP_SENTINEL} for old workflow compatibility)`,
    );
    console.log(DAILY_RELEASE_SKIP_SENTINEL);
    return;
  }
  if (result.action === "propose" && result.version) {
    console.error(
      `daily-release-next-version: decide propose version=${result.version} reason=${result.reason}`,
    );
    console.log(result.version);
    return;
  }
  fail(`unexpected decide result action=${result.action}`);
}

function runHandHelper(lastTag, bump) {
  console.error(
    "daily-release-next-version: hand-use stable helper " +
      "(CI should use decide ladder; pass --decide or set GITHUB_ACTIONS)",
  );
  if (!parseStable(lastTag)) {
    fail(
      `invalid last tag '${lastTag ?? ""}'. Expected a stable v<major>.<minor>.<patch>; ` +
        "for RC-ladder decisions use: node scripts/daily-release-decide.mjs --bump auto " +
        "(or GITHUB_ACTIONS=true node scripts/daily-release-next-version.mjs <ignored> <bump>)",
    );
  }
  if (!["auto", "patch", "minor"].includes(bump)) {
    fail(`invalid bump '${bump ?? ""}'. Expected auto | patch | minor`);
  }
  const rootJson = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const rootVersion = rootJson.version;
  if (`v${rootVersion}` !== lastTag) {
    fail(
      `lockstep broken: root package.json version (${rootVersion}) != last tag (${lastTag}).`,
    );
  }
  let hasFeat = false;
  if (bump === "auto") {
    const subjects = git("log", "--format=%s", `${lastTag}..origin/main`);
    hasFeat = subjects.split("\n").some((s) => /^feat(?:\(|!|:)/.test(s));
  }
  console.log(nextLineVersion(lastTag, bump, hasFeat));
}

const args = process.argv.slice(2).filter((a) => a !== "--decide");
const forceDecide = process.argv.includes("--decide");
const inCi =
  process.env.GITHUB_ACTIONS === "true" || forceDecide;

const isMain =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  if (inCi) {
    // Old workflow: argv = [lastTag, bump]; lastTag ignored for decide.
    const bump = args[1] || args[0] || "auto";
    // If only bump was passed: `node script.mjs --decide auto`
    const bumpResolved = ["auto", "patch", "minor"].includes(args[0]) && args[1] === undefined
      ? args[0]
      : ["auto", "patch", "minor"].includes(args[1])
        ? args[1]
        : "auto";
    runDecideLadder(bumpResolved);
  } else {
    const [lastTag, bump] = args;
    runHandHelper(lastTag, bump);
  }
}
