#!/usr/bin/env node
/**
 * check-publish-manifests.mjs — presubmit invariant gate over every
 * publishable package manifest.
 *
 * For every package manifest WITHOUT "private": true (scanning
 * packages/<group>/<pkg>/package.json) it asserts:
 *   1. publishConfig.access === "public"
 *   2. no dependency value starts with "link:"
 *   3. repository.url, normalized, names this repo — npm's sigstore
 *      provenance check rejects any publish whose manifest does not
 *      declare the repo it was built from (v0.1.1 pi-tui incident).
 *   4. license matches the project license, except for explicit vendored
 *      packages that must preserve their upstream license.
 *   5. (only when a sibling checkout <repoRoot>/../deepseek-harness exists)
 *      every dependency/devDependency/peerDependency key matching
 *      /^@deepseek-ai\/dsh-/ carries a range that the harness version
 *      satisfies. Skipped silently (with a note line) when the sibling
 *      checkout is absent.
 *
 * Range support is intentionally minimal — only the shapes the repo
 * actually uses: single-floor `>=X.Y.Z[-prerelease]`, caret `^X.Y.Z`,
 * and an exact bare version. Anything else fails loudly (range shapes
 * must be extended here before they are used).
 *
 * Exit 0 when clean (one-line summary); print every violation and
 * process.exitCode = 1 otherwise. No external dependencies.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

/* ---- minimal semver-compatible primitives (NO semver dependency) ---- */

const IDENT_RE = /^[0-9A-Za-z-]+$/;

/**
 * Parse a version string "M[.m[.p]][-pre[.ident]*]" into
 * { release: [int,int,int], prerelease: string[] }.
 * Returns null on malformed input.
 */
export function parseVersion(str) {
  if (typeof str !== "string" || str.length === 0) return null;
  const [core, ...preParts] = str.split("-");
  const pre = preParts.join("-");
  const nums = core.split(".");
  if (nums.length > 3) return null;
  const release = [];
  for (const n of nums) {
    if (!/^\d+$/.test(n) || (n.length > 1 && n.startsWith("0"))) return null;
    release.push(Number(n));
  }
  while (release.length < 3) release.push(0);
  let prerelease = [];
  if (pre !== "") {
    prerelease = pre.split(".");
    for (const id of prerelease) {
      if (!IDENT_RE.test(id) || (id.length > 1 && id.startsWith("0")))
        return null;
    }
  }
  return { release, prerelease };
}

/**
 * Compare two parsed versions. -1 / 0 / 1.
 * A release with no prerelease sorts ABOVE the same release with a
 * prerelease; prerelease dot-idents compare numerically when both
 * numeric, otherwise lexically, shorter-prefix sorts lower.
 */
export function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a.release[i] !== b.release[i]) return a.release[i] < b.release[i] ? -1 : 1;
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;
  const len = Math.min(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < len; i++) {
    const x = a.prerelease[i];
    const y = b.prerelease[i];
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1;
    } else if (xn !== yn) {
      return xn ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  if (a.prerelease.length === b.prerelease.length) return 0;
  return a.prerelease.length < b.prerelease.length ? -1 : 1;
}

function sameRelease(a, b) {
  return (
    a.release[0] === b.release[0] &&
    a.release[1] === b.release[1] &&
    a.release[2] === b.release[2]
  );
}

/**
 * Does `range` satisfy when the installed/expected version is `version`?
 * Supported shapes: `>=FLOOR`, `^X.Y.Z[-pre]`, and bare exact `X.Y.Z`.
 */
export function rangeSatisfiedBy(range, version) {
  if (typeof range !== "string") return false;
  if (/\s/.test(range)) {
    throw new Error(
      `check-publish-manifests: unrecognized range shape '${range}' — ` +
        `extend the checker's range support before this shape is used`,
    );
  }
  const v = parseVersion(version);
  if (!v) throw new Error(`check-publish-manifests: cannot parse version '${version}'`);

  const matchGe = /^>=\s*(.+)$/.exec(range);
  if (matchGe) {
    const floor = parseVersion(matchGe[1]);
    if (!floor)
      throw new Error(
        `check-publish-manifests: malformed '>=' range '${range}' (extend the checker for new shapes)`,
      );
    if (v.prerelease.length > 0 && !sameRelease(v, floor)) return false;
    return compareVersions(v, floor) >= 0;
  }

  const matchCaret = /^\^\s*(.+)$/.exec(range);
  if (matchCaret) {
    const base = parseVersion(matchCaret[1]);
    if (!base)
      throw new Error(
        `check-publish-manifests: malformed '^' range '${range}' (extend the checker for new shapes)`,
      );
    const [major, minor, patch] = base.release;
    let upper;
    if (major > 0) upper = { release: [major + 1, 0, 0], prerelease: [] };
    else if (minor > 0) upper = { release: [0, minor + 1, 0], prerelease: [] };
    else upper = { release: [0, 0, patch + 1], prerelease: [] };
    return (
      compareVersions(v, base) >= 0 &&
      compareVersions(v, upper) < 0 &&
      // node-semver's prerelease-tuple rule: a version carrying a prerelease
      // only satisfies a range whose comparator shares its release tuple, so
      // `^0.1.2-rc.1` admits 0.1.2-rc.2 but refuses 0.1.3-alpha.2.
      (v.prerelease.length === 0 || sameRelease(v, base))
    );
  }

  const exact = parseVersion(range);
  if (exact) return compareVersions(v, exact) === 0;

  throw new Error(
    `check-publish-manifests: unrecognized range shape '${range}' — ` +
      `extend the checker's range support before this shape is used`,
  );
}

/* ---- manifest scanning ---- */

function* eachPkgJson(dir) {
  const packagesDir = join(dir, "packages");
  if (!existsSync(packagesDir)) return;
  for (const group of readdirSync(packagesDir)) {
    const groupDir = join(packagesDir, group);
    if (!statSync(groupDir).isDirectory()) continue;
    for (const pkgName of readdirSync(groupDir)) {
      const pkgDir = join(groupDir, pkgName);
      if (!statSync(pkgDir).isDirectory()) continue;
      const path = join(pkgDir, "package.json");
      if (!existsSync(path)) continue;
      yield { pkgName, path, json: JSON.parse(readFileSync(path, "utf8")) };
    }
  }
}

function harnessVersion(root) {
  const path = join(root, "..", "deepseek-harness", "package.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")).version ?? null;
  } catch {
    return null;
  }
}

/* ---- repository provenance gate ---- */

/** The repo every publishable package must declare as its provenance. */
export const EXPECTED_REPOSITORY = "dsh-cc/dsh-cc";
export const EXPECTED_LICENSE = "Apache-2.0";
export const LICENSE_EXCEPTIONS = new Map([
  ["@dsh-cc/pi-tui", "MIT"],
]);

/**
 * Normalize a repository declaration to the bare `owner/repo` slug so the
 * equivalent spellings compare equal. Accepts the object form
 * ({ type, url, directory }) and the shorthand string form; strips the
 * `git+` prefix and a trailing `.git`. Returns null when the declaration is
 * absent or not a non-empty string after extraction.
 */
export function normalizeRepoSlug(repository) {
  if (repository == null) return null;
  const url =
    typeof repository === "string"
      ? repository
      : typeof repository.url === "string"
        ? repository.url
        : null;
  if (!url) return null;
  return url
    .replace(/^git\+/, "")
    .replace(/\.git$/, "")
    .replace(/^https?:\/\/(www\.)?github\.com\//, "")
    .replace(/^git@github\.com:/, "")
    .replace(/\/$/, "");
}

/** True when `repository` names the expected provenance repo. */
export function repositoryMatchesExpected(repository) {
  return normalizeRepoSlug(repository) === EXPECTED_REPOSITORY;
}

/** Returns [{ pkg, reason }] — all invariant violations across the repo. */
export function findManifestViolations(root = ROOT) {
  const problems = [];
  const hasHarness = Boolean(harnessVersion(root));
  if (!hasHarness) {
    console.log(
      `  note: sibling checkout '${join(
        root,
        "..",
        "deepseek-harness",
      )}' not found — skipping @deepseek-ai/dsh-* range checks`,
    );
  }
  for (const { pkgName, path, json } of eachPkgJson(root)) {
    if (json.private === true) continue;
    if (json.publishConfig?.access !== "public") {
      problems.push({
        pkg: pkgName,
        reason: `publishConfig.access is '${json.publishConfig?.access}' (expected 'public')`,
      });
    }
    for (const key of Object.keys(json.dependencies ?? {})) {
      const value = json.dependencies[key];
      if (typeof value === "string" && value.startsWith("link:")) {
        problems.push({ pkg: pkgName, reason: `dependency '${key}' is a link: value` });
      }
    }
    // link: dev/peer deps must resolve to a real directory relative to the
    // manifest. A dangling link: (wrong relative path) makes pnpm install a
    // broken symlink, and `pnpm publish` then fails with
    // ERR_PNPM_CANNOT_RESOLVE_WORKSPACE_PROTOCOL on the workspace: peer
    // (the v0.4.1 permission-rules → session-cwd incident). Targets that
    // escape the repo root are sibling-checkout links (deepseek-harness);
    // their existence depends on the checkout layout, so they are skipped.
    for (const section of ["devDependencies", "peerDependencies"]) {
      for (const key of Object.keys(json[section] ?? {})) {
        const value = json[section][key];
        if (typeof value !== "string" || !value.startsWith("link:")) continue;
        const target = join(dirname(path), value.slice("link:".length));
        const rel = relative(root, target);
        if (rel.startsWith("..")) continue;
        if (!existsSync(target)) {
          problems.push({
            pkg: pkgName,
            reason:
              `${section} '${key}' link: target '${value}' does not resolve ` +
              `(expected ${rel} to exist) — pnpm would install a dangling symlink`,
          });
        }
      }
    }
    if (!repositoryMatchesExpected(json.repository)) {
      problems.push({
        pkg: pkgName,
        reason:
          `repository.url '${json.repository?.url ?? "<missing>"}' does not name ` +
          `${EXPECTED_REPOSITORY} — npm sigstore provenance will reject the publish`,
      });
    }
    const expectedLicense = LICENSE_EXCEPTIONS.get(json.name) ?? EXPECTED_LICENSE;
    if (json.license !== expectedLicense) {
      problems.push({
        pkg: pkgName,
        reason: `license is '${json.license ?? "<missing>"}' (expected '${expectedLicense}')`,
      });
    }
    if (hasHarness) {
      const hv = harnessVersion(root);
      for (const section of ["dependencies", "devDependencies", "peerDependencies"]) {
        for (const key of Object.keys(json[section] ?? {})) {
          if (!/^@deepseek-ai\/dsh-/.test(key)) continue;
          const range = json[section][key];
          if (typeof range !== "string") continue;
          if (range.startsWith("link:")) continue;
          let ok;
          try {
            ok = rangeSatisfiedBy(range, hv);
          } catch (e) {
            problems.push({ pkg: pkgName, reason: e.message });
            continue;
          }
          if (!ok) {
            problems.push({
              pkg: pkgName,
              reason: `${key} '${range}' is not satisfied by deepseek-harness v${hv}`,
            });
          }
        }
      }
    }
  }
  return problems;
}

/* c8 ignores below: CLI entry */
const isDirectRun =
  process.argv[1] && process.argv[1].endsWith("check-publish-manifests.mjs");
if (isDirectRun) {
  const scanRoot = process.argv[2] ?? ROOT;
  const problems = findManifestViolations(scanRoot);
  if (problems.length) {
    console.error("check:publish — manifest violations found:\n");
    for (const p of problems) {
      console.error(`  ${p.pkg}\n    ${p.reason}`);
    }
    process.exitCode = 1;
  } else {
    console.log("check:publish OK — all publishable manifests valid");
  }
}
