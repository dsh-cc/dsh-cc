#!/usr/bin/env node
/**
 * daily-release-decide.mjs — Daily Release RC ladder decision (scheme B).
 *
 * Pure `decide(input)` is the source of truth (imported by tests). The CLI
 * gathers git state when not under test and prints ONLY machine-readable
 * key=value lines on stdout for GITHUB_OUTPUT; diagnostics go to stderr.
 *
 * Policy (Asia/Singapore weekdays; cron stays `0 0 * * 1-5`):
 *   1. Same Mon–Sun week already has a stable tag → skip (week_has_stable).
 *   2. No commits on main after last stable → skip (no_unreleased_work).
 *   3. Else compute next line from lastStable + bump/hasFeat.
 *   4. No rc on that line yet → propose X.Y.Z-rc.1 (incl. mid-week first run).
 *   5. Commits after latest rc → propose X.Y.Z-rc.(N+1).
 *   6. No commits after latest rc → propose stable X.Y.Z.
 *
 * Never tags/publishes — the workflow only opens release/v* PRs.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const STABLE_TAG_RE = /^v(\d+)\.(\d+)\.(\d+)$/;
const RC_TAG_RE = /^v(\d+)\.(\d+)\.(\d+)-rc\.(\d+)$/;
const DEFAULT_TZ = "Asia/Singapore";

function fail(msg) {
  console.error(`daily-release-decide: ${msg}`);
  process.exit(1);
}

function git(...args) {
  return execFileSync("git", args, { encoding: "utf-8", cwd: ROOT }).trim();
}

/** Calendar YYYY-MM-DD in the given IANA zone. */
export function zonedYmd(date, timeZone = DEFAULT_TZ) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/** Monday=0 … Sunday=6 for the calendar day of `date` in `timeZone`. */
export function zonedWeekdayMon0(date, timeZone = DEFAULT_TZ) {
  const wd = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
  }).format(date);
  const map = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
  const n = map[wd];
  if (n === undefined) throw new Error(`unexpected weekday '${wd}'`);
  return n;
}

/**
 * Monday YYYY-MM-DD (Asia/Singapore by default) of the ISO-style Mon–Sun
 * week containing `date`. Week membership is calendar-day based: a tag
 * dated anywhere on Mon–Sun of that week counts.
 */
export function weekStartYmd(date, timeZone = DEFAULT_TZ) {
  const ymd = zonedYmd(date, timeZone);
  const mon0 = zonedWeekdayMon0(date, timeZone);
  // Pure calendar arithmetic on the zoned YYYY-MM-DD (no DST footguns).
  const [y, m, d] = ymd.split("-").map(Number);
  const mondayUtc = new Date(Date.UTC(y, m - 1, d - mon0));
  const yy = mondayUtc.getUTCFullYear();
  const mm = String(mondayUtc.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(mondayUtc.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

export function sameSingaporeWeek(a, b, timeZone = DEFAULT_TZ) {
  return weekStartYmd(a, timeZone) === weekStartYmd(b, timeZone);
}

export function isStableTagName(name) {
  return STABLE_TAG_RE.test(name);
}

export function parseStable(name) {
  const m = typeof name === "string" && name.match(STABLE_TAG_RE);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

export function parseRc(name) {
  const m = typeof name === "string" && name.match(RC_TAG_RE);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    n: Number(m[4]),
    line: `${m[1]}.${m[2]}.${m[3]}`,
  };
}

export function cmpSemverTriple(a, b) {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

/** Next release LINE (bare X.Y.Z) from last stable + bump policy. */
export function nextLineVersion(lastStable, bump, hasFeatSinceStable) {
  const parsed = parseStable(lastStable);
  if (!parsed) {
    throw new Error(
      `invalid lastStable '${lastStable}'; expected v<major>.<minor>.<patch>`,
    );
  }
  if (!["auto", "patch", "minor"].includes(bump)) {
    throw new Error(`invalid bump '${bump}'; expected auto | patch | minor`);
  }
  const { major: M, minor: m, patch: p } = parsed;
  if (bump === "patch") return `${M}.${m}.${p + 1}`;
  if (bump === "minor") return `${M}.${m + 1}.0`;
  return hasFeatSinceStable ? `${M}.${m + 1}.0` : `${M}.${m}.${p + 1}`;
}

/**
 * Pure decision. All inputs injectable for tests (no git, no network).
 *
 * @param {object} input
 * @param {Date} input.now
 * @param {string} [input.timeZone]
 * @param {Array<{name:string, date:Date}>} input.tags
 * @param {string} input.lastStable  e.g. 'v0.7.1'
 * @param {string|null} input.latestRcOnLine  e.g. 'v0.8.0-rc.2' or null
 * @param {boolean} input.headAheadOfStable
 * @param {boolean} input.headAheadOfLatestRc  false when no rc
 * @param {'auto'|'patch'|'minor'} input.bump
 * @param {boolean} input.hasFeatSinceStable
 * @returns {{action:'propose'|'skip', reason:string, version?:string, last_stable:string, line?:string}}
 */
export function decide(input) {
  const timeZone = input.timeZone ?? DEFAULT_TZ;
  const now = input.now;
  const tags = input.tags ?? [];
  const lastStable = input.lastStable;
  const bump = input.bump;
  const hasFeatSinceStable = Boolean(input.hasFeatSinceStable);

  if (!parseStable(lastStable)) {
    throw new Error(
      `invalid lastStable '${lastStable}'; expected v<major>.<minor>.<patch>`,
    );
  }

  // 1. Week already has a stable release → skip everything.
  for (const t of tags) {
    if (isStableTagName(t.name) && sameSingaporeWeek(t.date, now, timeZone)) {
      return {
        action: "skip",
        reason: "week_has_stable",
        last_stable: lastStable,
        week_stable: t.name,
      };
    }
  }

  // 2. Nothing unreleased vs last stable.
  if (!input.headAheadOfStable) {
    return {
      action: "skip",
      reason: "no_unreleased_work",
      last_stable: lastStable,
    };
  }

  // 3. Next line from last stable.
  const line = nextLineVersion(lastStable, bump, hasFeatSinceStable);

  // 4. Only honour latestRcOnLine when it is on THIS line.
  let rc = input.latestRcOnLine ? parseRc(input.latestRcOnLine) : null;
  if (rc && rc.line !== line) {
    rc = null;
  }

  // 5–7. Ladder.
  let version;
  let reason;
  if (!rc) {
    version = `${line}-rc.1`;
    reason = "first_rc";
  } else if (input.headAheadOfLatestRc) {
    version = `${line}-rc.${rc.n + 1}`;
    reason = "rc_bump";
  } else {
    version = line;
    reason = "stabilize";
  }

  return {
    action: "propose",
    reason,
    version,
    last_stable: lastStable,
    line,
  };
}

/* ---- CI gather (git) ---- */

function listMergedTagsWithDates() {
  // creatordate = tagger date for annotated tags, committer date for lightweight.
  const raw = git(
    "for-each-ref",
    "--format=%(refname:short)|%(creatordate:iso-strict)",
    "--merged=origin/main",
    "refs/tags",
  );
  if (!raw) return [];
  const out = [];
  for (const line of raw.split("\n")) {
    const [name, iso] = line.split("|");
    if (!name || !name.startsWith("v")) continue;
    if (!STABLE_TAG_RE.test(name) && !RC_TAG_RE.test(name)) continue;
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) {
      fail(`unparseable creatordate for tag ${name}: '${iso}'`);
    }
    out.push({ name, date });
  }
  return out;
}

function highestStableName(tags) {
  let best = null;
  let bestParsed = null;
  for (const t of tags) {
    const p = parseStable(t.name);
    if (!p) continue;
    if (!bestParsed || cmpSemverTriple(p, bestParsed) > 0) {
      best = t.name;
      bestParsed = p;
    }
  }
  return best;
}

function highestRcOnLine(tags, line) {
  let best = null;
  let bestN = -1;
  const re = new RegExp(
    `^v${line.replace(/\./g, "\\.")}-rc\\.(\\d+)$`,
  );
  for (const t of tags) {
    const m = t.name.match(re);
    if (!m) continue;
    const n = Number(m[1]);
    if (n > bestN) {
      bestN = n;
      best = t.name;
    }
  }
  return best;
}

function headAheadOf(tagName) {
  // Commits reachable from origin/main but not from the tag.
  const count = git("rev-list", "--count", `${tagName}..origin/main`);
  return Number(count) > 0;
}

function hasFeatSince(tagName) {
  let subjects = "";
  try {
    subjects = git("log", "--format=%s", `${tagName}..origin/main`);
  } catch {
    subjects = "";
  }
  if (!subjects) return false;
  return subjects.split("\n").some((s) => /^feat(?:\(|!|:)/.test(s));
}

/**
 * Soft lockstep diagnostic (stderr only). After an rc merge, root may be
 * `X.Y.Z-rc.N` while lastStable is still the previous stable — that is
 * expected and must NOT fail the decide path (the 9/15-era script did).
 */
function warnLockstep(lastStable, latestRcOnLine) {
  try {
    const rootJson = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    const rootVersion = rootJson.version;
    const expected = new Set([lastStable.slice(1)]);
    if (latestRcOnLine) expected.add(latestRcOnLine.slice(1));
    if (!expected.has(rootVersion)) {
      console.error(
        `daily-release-decide: note: root package.json version (${rootVersion}) ` +
          `is neither lastStable (${lastStable.slice(1)}) nor latestRc ` +
          `(${latestRcOnLine ? latestRcOnLine.slice(1) : "none"}); continuing`,
      );
    }
  } catch (e) {
    console.error(`daily-release-decide: could not read root package.json: ${e.message}`);
  }
}

export function gatherInputFromGit(bump) {
  if (!["auto", "patch", "minor"].includes(bump)) {
    fail(`invalid bump '${bump ?? ""}'. Expected auto | patch | minor`);
  }
  const tags = listMergedTagsWithDates();
  const lastStable = highestStableName(tags);
  if (!lastStable) {
    fail("no stable v* tag reachable from main; cannot establish a release baseline");
  }
  const hasFeatSinceStable = hasFeatSince(lastStable);
  const line = nextLineVersion(lastStable, bump, hasFeatSinceStable);
  const latestRcOnLine = highestRcOnLine(tags, line);
  warnLockstep(lastStable, latestRcOnLine);
  return {
    now: new Date(),
    timeZone: DEFAULT_TZ,
    tags,
    lastStable,
    latestRcOnLine,
    headAheadOfStable: headAheadOf(lastStable),
    headAheadOfLatestRc: latestRcOnLine ? headAheadOf(latestRcOnLine) : false,
    bump,
    hasFeatSinceStable,
  };
}

function printDecision(result) {
  const lines = [
    `action=${result.action}`,
    `reason=${result.reason}`,
    `last_stable=${result.last_stable}`,
  ];
  if (result.version) lines.push(`version=${result.version}`);
  if (result.line) lines.push(`line=${result.line}`);
  if (result.week_stable) lines.push(`week_stable=${result.week_stable}`);
  process.stdout.write(`${lines.join("\n")}\n`);
}

function parseArgs(argv) {
  let bump = "auto";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--bump") {
      bump = argv[++i];
    } else if (a.startsWith("--bump=")) {
      bump = a.slice("--bump=".length);
    } else if (a === "--help" || a === "-h") {
      console.error(
        "Usage: node scripts/daily-release-decide.mjs --bump auto|patch|minor\n" +
          "Stdout: action=… reason=… last_stable=… [version=…] (GITHUB_OUTPUT lines)",
      );
      process.exit(0);
    } else {
      fail(`unknown arg '${a}'`);
    }
  }
  return { bump };
}

function main() {
  const { bump } = parseArgs(process.argv.slice(2));
  let input;
  try {
    input = gatherInputFromGit(bump);
  } catch (e) {
    if (e && e.status !== undefined) {
      fail(`git failed: ${e.message}`);
    }
    throw e;
  }
  console.error(
    `daily-release-decide: lastStable=${input.lastStable} ` +
      `latestRcOnLine=${input.latestRcOnLine ?? "(none)"} ` +
      `headAheadOfStable=${input.headAheadOfStable} ` +
      `headAheadOfLatestRc=${input.headAheadOfLatestRc} ` +
      `hasFeat=${input.hasFeatSinceStable} bump=${bump}`,
  );
  let result;
  try {
    result = decide(input);
  } catch (e) {
    fail(e.message);
  }
  console.error(
    `daily-release-decide: → action=${result.action} reason=${result.reason}` +
      (result.version ? ` version=${result.version}` : ""),
  );
  printDecision(result);
}

const isMain =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main();
}
