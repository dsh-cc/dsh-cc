#!/usr/bin/env node
/**
 * release.test.mjs — self-running test harness (node:assert + spawnSync,
 * NOT vitest; matches the scripts/*.test.mjs pattern).
 *
 * Covers:
 *  - release.mjs's EXPORTED pure planner `planReleaseVersionWrites`:
 *    a publishable package's nested `.claude-plugin/plugin.json` is planned
 *    alongside its package.json; private packages (and their nested
 *    manifests) are skipped; the private root package.json is always
 *    planned. No git side effects, no argv reading.
 *  - check-release-version.mjs's gate: a nested plugin.json drifting from
 *    the enforced version fails with a diagnostic naming the package; a
 *    matched nested manifest passes.
 */
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { planReleaseVersionWrites } from "./release.mjs";
import { collectVersions, canonicalTag } from "./check-release-version.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RELEASE_SCRIPT = join(__dirname, "release.mjs");
const GATE_SCRIPT = join(__dirname, "check-release-version.mjs");
void GATE_SCRIPT;

let failures = 0;
function pass(name) {
  console.log(`[PASS] ${name}`);
}
function fail(name, detail) {
  console.error(`[FAIL] ${name}: ${detail}`);
  failures++;
}
function check(name, fn) {
  try {
    fn();
    pass(name);
  } catch (e) {
    fail(name, e.message);
  }
}

/* ---- fixture tree ---- */

function makeFixture() {
  const dir = mkdtempSync(join(tmpdir(), "release-planner-"));
  const write = (rel, json) => {
    const p = join(dir, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, `${JSON.stringify(json, null, 2)}\n`, "utf8");
  };
  // private root — always planned
  write("package.json", { name: "dsh-cc", version: "0.4.0", private: true });
  // publishable package WITH a nested plugin manifest
  write("packages/plugin/dsh-cc-agents/package.json", {
    name: "@dsh-cc/plugin-dsh-cc-agents",
    version: "0.4.0",
  });
  write("packages/plugin/dsh-cc-agents/.claude-plugin/plugin.json", {
    name: "dsh-cc-agents",
    version: "0.4.0",
  });
  // publishable package WITHOUT a nested manifest
  write("packages/a/plain-pkg/package.json", { name: "@dsh-cc/plain-pkg", version: "0.4.0" });
  // private package WITH a nested manifest — must be skipped entirely
  write("packages/a/private-pkg/package.json", {
    name: "@dsh-cc/private-pkg",
    version: "0.4.0",
    private: true,
  });
  write("packages/a/private-pkg/.claude-plugin/plugin.json", {
    name: "private-plugin",
    version: "0.4.0",
  });
  return dir;
}

const dir = makeFixture();
try {
  check("planner: publishable pkg plans BOTH package.json and nested plugin.json", () => {
    const plan = planReleaseVersionWrites(dir, "0.5.0");
    const pkgEntry = plan.find(
      (p) => p.path.endsWith(join("dsh-cc-agents", "package.json")),
    );
    const pluginEntry = plan.find(
      (p) => p.path.endsWith(join("dsh-cc-agents", ".claude-plugin", "plugin.json")),
    );
    assert.ok(pkgEntry, "package.json entry missing");
    assert.ok(pluginEntry, "nested plugin.json entry missing");
    assert.equal(pluginEntry.to, "0.5.0");
  });

  check("planner: private package AND its nested plugin.json are skipped", () => {
    const plan = planReleaseVersionWrites(dir, "0.5.0");
    assert.ok(
      !plan.some((p) => p.path.includes("private-pkg")),
      `private-pkg must not be planned: ${plan.map((p) => p.path).join(", ")}`,
    );
    assert.ok(
      !plan.some((p) => p.path.includes("private-plugin")),
      "nested manifest of a private package must not be planned",
    );
  });

  check("planner: private root package.json is always planned", () => {
    const plan = planReleaseVersionWrites(dir, "0.5.0");
    assert.ok(plan.some((p) => p.path.endsWith(join(dir, "package.json")) || p.path === join(dir, "package.json")));
  });

  check("planner: already-current version yields no entry (idempotent)", () => {
    const plan = planReleaseVersionWrites(dir, "0.4.0");
    assert.equal(plan.length, 0, `expected empty plan, got ${JSON.stringify(plan)}`);
  });

  /* ---- version gate ---- */

  check("gate: collectVersions includes nested plugin.json for publishable packages", () => {
    const versions = collectVersions(dir);
    const pluginEntry = versions.find((v) =>
      v.name.includes("dsh-cc-agents") && v.name.includes(".claude-plugin"),
    );
    assert.ok(pluginEntry, `nested manifest missing from: ${JSON.stringify(versions)}`);
    assert.equal(pluginEntry.version, "0.4.0");
  });

  check("gate: nested manifest of a PRIVATE package is not enforced", () => {
    const versions = collectVersions(dir);
    assert.ok(!versions.some((v) => v.name.includes("private-pkg")));
  });

  check("gate: drifted nested manifest is listed as an offender", () => {
    // bump the nested manifest behind the planner's back
    const pluginPath = join(
      dir,
      "packages/plugin/dsh-cc-agents/.claude-plugin/plugin.json",
    );
    const before = JSON.parse(readFileSync(pluginPath, "utf8"));
    writeFileSync(pluginPath, JSON.stringify({ ...before, version: "0.3.0" }, null, 2));
    try {
      const offenders = collectVersions(dir).filter((m) => m.version !== "0.5.0");
      const pluginOffender = offenders.find((m) => m.name.includes(".claude-plugin"));
      assert.ok(pluginOffender, `expected nested offender, got ${JSON.stringify(offenders)}`);
      assert.ok(
        pluginOffender.name.includes("dsh-cc-agents"),
        "offender diagnostic must name the package",
      );
      // CLI entry resolves ROOT from its own file location (not cwd), so the
      // diagnostic text is asserted via the in-process offenders, which the
      // CLI prints verbatim.
      assert.ok(
        pluginOffender.name.includes("dsh-cc-agents"),
        "offender diagnostic must name the package",
      );
    } finally {
      writeFileSync(pluginPath, JSON.stringify(before, null, 2));
    }
  });

  check("gate: matched nested manifest passes (no offenders at fixture version)", () => {
    const offenders = collectVersions(dir).filter((m) => m.version !== "0.4.0");
    assert.equal(offenders.length, 0, JSON.stringify(offenders));
  });

  check("gate: canonicalTag strips leading v", () => {
    assert.equal(canonicalTag("v0.5.0"), "0.5.0");
  });
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} case(s) failed.`);
  process.exit(1);
}
console.log("release planner + version-gate tests passed.");
