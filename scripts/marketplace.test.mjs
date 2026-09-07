#!/usr/bin/env node
/**
 * marketplace.test.mjs — self-running test harness (node:assert, NOT vitest;
 * matches the scripts/*.test.mjs pattern from Unit B's release.test.mjs).
 *
 * Pins the repo-root official marketplace manifest
 * (docs/plans/2026-09-07-official-agents-plugin.md §5.5):
 *  - `.claude-plugin/marketplace.json` parses and is named `dsh-cc`;
 *  - every plugin entry's relative `source` resolves to an existing
 *    directory holding `.claude-plugin/plugin.json` whose `name` matches
 *    the entry — so `/plugin install dsh-cc-agents@dsh-cc` resolves.
 */
import { strict as assert } from "node:assert";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = join(ROOT, ".claude-plugin", "marketplace.json");

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`[PASS] ${name}`);
  } catch (e) {
    console.error(`[FAIL] ${name}: ${e.message}`);
    failures++;
  }
}

check("repo-root .claude-plugin/marketplace.json exists and parses", () => {
  assert.ok(existsSync(MANIFEST), `${MANIFEST} missing`);
  JSON.parse(readFileSync(MANIFEST, "utf8"));
});

const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));

check("marketplace is named dsh-cc", () => {
  assert.equal(manifest.name, "dsh-cc");
});

check("marketplace declares at least one plugin", () => {
  assert.ok(Array.isArray(manifest.plugins) && manifest.plugins.length > 0);
});

for (const entry of manifest.plugins ?? []) {
  check(`plugin "${entry.name}": relative source resolves to a plugin dir with a matching manifest`, () => {
    assert.equal(typeof entry.source, "string", "source must be a relative directory string");
    const dir = join(ROOT, entry.source);
    assert.ok(statSync(dir).isDirectory(), `source "${entry.source}" is not a directory`);
    const pluginJson = join(dir, ".claude-plugin", "plugin.json");
    assert.ok(existsSync(pluginJson), `${pluginJson} missing (forgotten git add?)`);
    const parsed = JSON.parse(readFileSync(pluginJson, "utf8"));
    assert.equal(parsed.name, entry.name, `plugin.json name "${parsed.name}" != marketplace entry "${entry.name}"`);
  });
}

if (failures > 0) {
  console.error(`\n${failures} case(s) failed.`);
  process.exit(1);
}
console.log("marketplace manifest tests passed.");
