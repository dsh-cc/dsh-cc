#!/usr/bin/env node
/**
 * check-release-version.mjs <tag> — CI gate.
 *
 * The arg is a semver-tagged release name like `v0.1.0` or `0.1.0-rc.1`
 * (a leading 'v' is stripped). Asserts that the root package.json version
 * and every non-private package manifest's version (scanning
 * packages/<group>/<pkg>/package.json) are EXACTLY equal to it. Any
 * mismatch → list all offenders, suggest `pnpm release <version>`
 * and exit 1. Clean → one-line success.
 *
 * No external dependencies.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/* c8 ignores below: helpers */
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

/** Resolve a CLI <tag> to a canonical version string, or null if invalid. */
export function canonicalTag(tag) {
  if (typeof tag !== "string") return null;
  const v = tag.startsWith("v") ? tag.slice(1) : tag;
  return isValidVersionShape(v) ? v : null;
}

export function isValidVersionShape(str) {
  return typeof str === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(str);
}

/** [{ name, version }] for the root + every non-private package manifest. */
export function collectVersions(root = ROOT) {
  const out = [];
  const rootJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  out.push({ name: rootJson.name, version: rootJson.version });
  const packagesDir = join(root, "packages");
  if (existsSync(packagesDir)) {
    for (const group of readdirSync(packagesDir)) {
      const groupDir = join(packagesDir, group);
      if (!statSync(groupDir).isDirectory()) continue;
      for (const pkgName of readdirSync(groupDir)) {
        const pkgDir = join(groupDir, pkgName);
        if (!statSync(pkgDir).isDirectory()) continue;
        const path = join(pkgDir, "package.json");
        if (!existsSync(path)) continue;
        const json = JSON.parse(readFileSync(path, "utf8"));
        if (json.private === true) continue;
        out.push({ name: json.name, version: json.version });
        // Nested plugin manifest inherits the package's publishability: a
        // stale `.claude-plugin/plugin.json` makes `/plugin update` a
        // permanent no-op (cc-plugin-manager no-ops when the declared
        // version equals the installed entry), so its version is enforced
        // in lockstep with package.json.
        const pluginJsonPath = join(dirname(path), ".claude-plugin", "plugin.json");
        if (!existsSync(pluginJsonPath)) continue;
        const pluginJson = JSON.parse(readFileSync(pluginJsonPath, "utf8"));
        out.push({
          name: `${json.name} (.claude-plugin/plugin.json)`,
          version: pluginJson.version,
        });
      }
    }
  }
  return out;
}

/* c8 ignores below: CLI entry */
const isDirectRun =
  process.argv[1] && process.argv[1].endsWith("check-release-version.mjs");
if (isDirectRun) {
  const expected = canonicalTag(process.argv[2] ?? "");
  if (!expected) {
    console.error(
      `check:release-version — invalid tag '${
        process.argv[2] ?? ""
      }'. Expected a semver shape like v0.1.0 or 0.1.0-rc.1.`,
    );
    process.exit(1);
  }
  const offenders = collectVersions(ROOT).filter((m) => m.version !== expected);
  if (offenders.length) {
    console.error(
      `check:release-version — release '${expected}' does not match ${
        offenders.length
      } manifest(s):\n`,
    );
    for (const m of offenders) {
      console.error(`  ${m.name}: ${m.version}`);
    }
    console.error(`\nrun: pnpm release ${expected}`);
    process.exit(1);
  }
  console.log(`check:release-version OK — all manifests at ${expected}`);
}
