#!/usr/bin/env node
/**
 * release.mjs <version> [--dry-run] — local release assistant (run by the
 * user manually, never in CI).
 *
 * Validates: semver-shaped arg; on branch `main`; working tree clean;
 * local HEAD === origin/main after `git fetch origin main`; tag `v<version>`
 * exists neither locally nor on the remote.
 *
 * Then writes the version into the root package.json and every non-private
 * package manifest (packages/<group>/<pkg>/package.json) with 2-space JSON
 * + trailing newline at stable key order, commits
 * `chore(release): v<version>`, and tags `v<version>`. It NEVER pushes —
 * it prints the exact manual push command to run.
 *
 * The ROOT package.json is always written even though it is private:
 * check-release-version.mjs asserts the root version equals the tag, so a
 * private root left at the old version fails the publish gate (v0.1.1
 * incident). Private *packages* under packages/ are still skipped.
 *
 * --dry-run prints validations + planned version writes with NO mutation,
 * commit, or tag.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

function fail(msg) {
  console.error(`release: ${msg}`);
  process.exit(1);
}

function git(...args) {
  return execFileSync("git", args, { encoding: "utf-8", cwd: ROOT }).trim();
}

function isValidVersionShape(str) {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(str);
}

/* ---- pure planner (exported for tests) ---- */

/**
 * Pure planner (exported for tests): given a repo root and a target
 * version, return the planned version rewrites — the private root
 * package.json (always, see the header note), every non-private
 * packages/<group>/<pkg>/package.json, and every existing
 * `<pkg>/.claude-plugin/plugin.json` of a non-private package (same
 * publishability rule as its package.json). No git side effects, no
 * process.argv reading; the CLI entry owns those.
 */
export function planReleaseVersionWrites(rootDir, targetVersion) {
  const rootManifest = join(rootDir, "package.json");
  const packagesDir = join(rootDir, "packages");
  const candidates = [rootManifest];
  if (existsSync(packagesDir)) {
    for (const group of readdirSync(packagesDir)) {
      const groupDir = join(packagesDir, group);
      if (!statSync(groupDir).isDirectory()) continue;
      for (const pkg of readdirSync(groupDir)) {
        const pkgDir = join(groupDir, pkg);
        if (!statSync(pkgDir).isDirectory()) continue;
        const path = join(pkgDir, "package.json");
        if (existsSync(path)) candidates.push(path);
      }
    }
  }

  const planned = [];
  for (const path of candidates) {
    const json = JSON.parse(readFileSync(path, "utf8"));
    // Private packages are never published, so their version is meaningless —
    // skip them (and their nested plugin manifest). The ROOT manifest is the
    // exception: it stays in lockstep with the release because
    // check-release-version.mjs asserts it against the tag.
    const isRoot = path === rootManifest;
    if (json.private === true && !isRoot) continue;
    if (json.version !== targetVersion) {
      planned.push({ path, name: json.name, from: json.version, to: targetVersion });
    }
    // Nested plugin manifest inherits the package's publishability; a stale
    // one would make `/plugin update` a permanent no-op for every user
    // (cc-plugin-manager skips updates when the declared version equals the
    // installed entry).
    const pluginJsonPath = join(dirname(path), ".claude-plugin", "plugin.json");
    if (!existsSync(pluginJsonPath)) continue;
    const pluginJson = JSON.parse(readFileSync(pluginJsonPath, "utf8"));
    if (pluginJson.version !== targetVersion) {
      planned.push({
        path: pluginJsonPath,
        name: json.name,
        from: pluginJson.version,
        to: targetVersion,
      });
    }
  }
  return planned;
}

/* ---- bundled release notes (pure, exported for tests) ---- */

/**
 * `/release-notes` ships a CHANGELOG string constant whose newest `## <version>`
 * section must equal the package version (pinned by
 * command-release-notes.spec.ts). A bump that only rewrites manifests leaves
 * the newest section one release behind and fails PreSubmit on the release
 * PR (v0.9.5-rc.1, #394), so release.mjs writes the section in the same
 * commit.
 */
export const RELEASE_NOTES_REL =
  "packages/interaction/command-release-notes/src/release-notes.ts";

const SECTION_RE = /^## (\S+)/mu;
const USER_FACING_RE = /^(?:feat|fix|perf)(?:\([^)]*\))?!?: /u;

/** Version of the newest `## <version>` section, or undefined when none. */
export function newestReleaseNotesVersion(src) {
  return findNewestSection(src)?.[1];
}

// Search only the CHANGELOG constant, so a `## ` line elsewhere in the file
// (doc comments) can never be mistaken for a section.
const CHANGELOG_MARKER = "export const CHANGELOG = `";
function findNewestSection(src) {
  const start = src.indexOf(CHANGELOG_MARKER);
  if (start === -1) return null;
  const re = new RegExp(SECTION_RE.source, "gmu");
  re.lastIndex = start;
  return re.exec(src);
}

/**
 * Plan the new section: one bullet per user-facing conventional-commit
 * subject (feat, fix, perf), oldest first. Returns null when the newest
 * section already names `targetVersion` (idempotent rerun). Subjects are
 * escaped for the enclosing template literal.
 */
export function planReleaseNotesSection(src, targetVersion, subjectsNewestFirst) {
  const match = findNewestSection(src);
  if (!match) throw new Error(`no "## <version>" section in the CHANGELOG constant of ${RELEASE_NOTES_REL}`);
  const from = match[1];
  if (from === targetVersion) return null;
  const escape = (line) => line.replace(/[\\`]/gu, "\\$&").replace(/\$\{/gu, "\\${");
  const bullets = subjectsNewestFirst
    .filter((subject) => USER_FACING_RE.test(subject))
    .reverse()
    .map((subject) => `- ${escape(subject)}`);
  if (bullets.length === 0) bullets.push(`- No user-facing changes since ${escape(from)}.`);
  const section = `## ${targetVersion}\n\n${bullets.join("\n")}\n\n`;
  return { from, to: targetVersion, src: src.slice(0, match.index) + section + src.slice(match.index) };
}

/* ---- validation (CLI entry; skipped on import by tests) ---- */

const isDirectRun = process.argv[1] && process.argv[1].endsWith("release.mjs");
if (!isDirectRun) {
  // imported (e.g. by release.test.mjs for the pure planner) — no CLI side effects
} else {
const argVersion = process.argv[2];
const dryRun = process.argv.includes("--dry-run");
const label = dryRun ? "DRY-RUN" : "release";

// Compatibility with daily-release-next-version.mjs under the pre-#83 workflow:
// when the RC ladder decides to skip, CI still invokes release.mjs with this
// sentinel so dry-run / propose steps exit 0 without opening a release PR.
const DAILY_RELEASE_SKIP_SENTINEL = "__daily_release_skip__";
if (argVersion === DAILY_RELEASE_SKIP_SENTINEL) {
  console.log(`  [${label}] daily-release decide skip sentinel — no-op`);
  process.exit(0);
}

if (!argVersion || !isValidVersionShape(argVersion)) {
  fail(`invalid version '${argVersion ?? ""}'. Expected a semver shape like 0.1.0 or 0.1.0-rc.1`);
}

const branch = git("branch", "--show-current");
console.log(`  [${label}] branch: ${branch}`);
if (branch !== "main") fail(`must run on 'main' (currently on '${branch}')`);

const status = git("status", "--porcelain");
console.log(`  [${label}] working tree clean: ${status === ""}`);
if (status !== "") fail("working tree is not clean; commit or stash first");

git("fetch", "origin", "main", "--quiet");
const head = git("rev-parse", "HEAD");
const originMain = git("rev-parse", "origin/main");
console.log(`  [${label}] HEAD === origin/main: ${head === originMain}`);
if (head !== originMain) fail("local HEAD is behind origin/main; sync first");

const tag = `v${argVersion}`;
let tagExistsLocal = false;
try {
  git("rev-parse", "-q", "--verify", `refs/tags/${tag}`);
  tagExistsLocal = true;
} catch {
  tagExistsLocal = false;
}
console.log(`  [${label}] tag ${tag} exists locally: ${tagExistsLocal}`);
if (tagExistsLocal) fail(`tag '${tag}' already exists locally`);

let tagExistsRemote = false;
try {
  const ls = git("ls-remote", "--tags", "origin", tag);
  tagExistsRemote = ls.length > 0;
} catch {
  tagExistsRemote = false;
}
console.log(`  [${label}] tag ${tag} exists on remote: ${tagExistsRemote}`);
if (tagExistsRemote) fail(`tag '${tag}' already exists on origin`);

/* ---- planned writes ---- */

const planned = planReleaseVersionWrites(ROOT, argVersion);

// FALLBACK_VERSION in @dsh-cc/version-info is the display value used when
// package.json is unreadable at runtime. Every consumer re-exports it from
// there, so this single constant is the only one to keep in lockstep — and a
// moved/renamed constant must fail loudly rather than ship stale. (The earlier
// per-package copies are gone: cc-acp's had already drifted four releases
// because it was never listed here.)
const FALLBACK_FILES = [
  { rel: "packages/observability/version-info/src/index.ts" },
];
const fallbackRe = /export const FALLBACK_VERSION = (['"])([^'"]+)\1/;
const fallbacks = FALLBACK_FILES.map(({ rel }) => {
  const path = join(ROOT, rel);
  const src = readFileSync(path, "utf8");
  const from = src.match(fallbackRe)?.[2];
  if (from === undefined) {
    fail(`could not locate FALLBACK_VERSION in ${rel} — update release.mjs alongside it`);
  }
  return { rel, path, src, from };
});

// Bundled release notes: commits since the tag of the newest section's
// version (falling back to the newest reachable tag when that tag is gone).
const releaseNotesPath = join(ROOT, RELEASE_NOTES_REL);
const releaseNotesSrc = readFileSync(releaseNotesPath, "utf8");
const notesFrom = newestReleaseNotesVersion(releaseNotesSrc);
if (notesFrom === undefined) {
  fail(`could not locate a "## <version>" section in ${RELEASE_NOTES_REL} — update release.mjs alongside it`);
}
let notesBase = `v${notesFrom}`;
try {
  git("rev-parse", "-q", "--verify", `refs/tags/${notesBase}`);
} catch {
  notesBase = git("describe", "--tags", "--abbrev=0", "HEAD");
}
const notesSubjects = git("log", "--no-merges", "--format=%s", `${notesBase}..HEAD`)
  .split("\n")
  .filter(Boolean);
const releaseNotes = planReleaseNotesSection(releaseNotesSrc, argVersion, notesSubjects);

console.log(`  [${label}] planned version writes (${planned.length}):`);
for (const p of planned) {
  console.log(`    ${p.name}: ${p.from} -> ${p.to}  (${join("..", p.path).replace(join("..", ROOT), ".")})`);
}
for (const f of fallbacks) {
  console.log(`    FALLBACK_VERSION: ${f.from} -> ${argVersion}  (${f.rel})`);
}
if (releaseNotes) {
  const count = releaseNotes.src.length - releaseNotesSrc.length;
  console.log(
    `    release notes: new "## ${argVersion}" section from ${notesBase}..HEAD (+${count} chars)  (${RELEASE_NOTES_REL})`,
  );
}
console.log(`  [${label}] commit message: chore(release): ${tag}`);

if (dryRun) {
  console.log(`\n  [DRY-RUN] no files changed, no commit, no tag.`);
  process.exit(0);
}

/* ---- commit + tag (NO push) ---- */

for (const p of planned) {
  const json = JSON.parse(readFileSync(p.path, "utf8"));
  json.version = argVersion;
  writeFileSync(p.path, `${JSON.stringify(json, null, 2)}\n`, "utf8");
}
for (const f of fallbacks) {
  writeFileSync(
    f.path,
    f.src.replace(fallbackRe, (_m, q) => `export const FALLBACK_VERSION = ${q}${argVersion}${q}`),
    "utf8",
  );
}

if (releaseNotes) writeFileSync(releaseNotesPath, releaseNotes.src, "utf8");

git("add", "-A");
git("commit", "-m", `chore(release): ${tag}`);
git("tag", tag);

console.log(
  `\n下一步(需手动执行): git push origin main ${tag} —— 推送后 tag 触发 publish.yml 自动发布`,
);
}

