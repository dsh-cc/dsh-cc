#!/usr/bin/env node
/**
 * Test fixtures for check-capability-evidence.mjs: a synthetic manifest
 * (one minimal fixture per invariant I1–I11) plus normalization / anchor /
 * freshness cases. Follows the pattern of check-spec-deps.test.mjs: plain
 * node + assert, rootDir injected via a temp dir, no test framework.
 */
import { checkCapabilityManifest } from "./lib/capability-manifest.mjs";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";

const root = mkdtempSync(join(tmpdir(), "cap-manifest-"));
const today = new Date().toISOString().slice(0, 10);
const OLD = "2020-01-01";
const PRESET = "packages/preset/cc/agent.cordis.yml";

const errorsOf = (diags) => diags.filter((d) => d.level === "error");
const warningsOf = (diags) => diags.filter((d) => d.level === "warning");

// Minimal valid skeleton; overrides are not deep-merged here — the
// capabilities / baseline blocks are replaced wholesale instead.
function baseManifest() {
  return {
    manifest_version: 1,
    baseline: {
      upstream: "claude-code",
      sources: [
        {
          id: "cc-docs",
          kind: "context7",
          ref: "/websites/code_claude",
          url: "https://code.claude.com/docs",
          retrieved: today,
        },
      ],
      freshness_threshold_days: 120,
    },
    categories: [{ id: "sessions", title: "Sessions and context" }],
    upstream_dependencies: {
      "session-file-snapshot-seam": {
        title: "Session file-snapshot seam",
        problem: "no snapshot store",
        cc_contract: "per-prompt checkpoints",
        refs: ["https://code.claude.com/docs/en/checkpointing"],
      },
    },
    capabilities: {
      "sessions.checkpointing": {
        title: "File checkpointing and rewind",
        category: "sessions",
        plane: "preset",
        upstream: { summary: "Per-prompt snapshots.", refs: [] },
        dimensions: {
          recognized: false,
          mounted: false,
          behavioral: "missing",
          ux: "missing",
        },
        evidence: [],
        deviation: {
          kind: "upstream-blocked",
          summary: "Requires a snapshot seam.",
          upstream_dependency: "session-file-snapshot-seam",
        },
      },
      "sessions.resume": {
        title: "Resume",
        category: "sessions",
        plane: "preset",
        upstream: {
          summary: "Resume a session.",
          refs: [{ source: "cc-docs", path: "/docs/en/resume", retrieved: today }],
        },
        dimensions: {
          recognized: true,
          mounted: true,
          behavioral: "full",
          ux: "full",
        },
        evidence: [
          { type: "test", path: "packages/sessions/tests/resume.spec.ts" },
          { type: "source", path: PRESET, anchor: "-sessions-resume" },
        ],
        deviation: { kind: "none" },
      },
    },
  };
}

function writeFixture(yamlText, extraFiles = []) {
  const dir = mkdtempSync(join(tmpdir(), "cap-fixture-"));
  writeFileSync(join(dir, "docs.yaml"), yamlText);
  for (const [rel, content] of extraFiles) {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  return dir;
}

// js-yaml serializes objects to YAML; the test does its own dump rather
// than trusting hand-written YAML strings.
import yaml from "js-yaml";
const dump = (m) => yaml.dump(m, { lineWidth: -1 });

const PRESET_BODY = "# preset\n  -sessions-resume:\n    cmd: resume\n";
const GOOD_FILES = [
  ["packages/sessions/tests/resume.spec.ts", "test {}\n"],
  [PRESET, PRESET_BODY],
];

try {
  // 1) Fully valid fixture: zero diagnostics (one capability with positive
  // grades + one all-negative).
  {
    const dir = writeFixture(dump(baseManifest()), GOOD_FILES);
    const diags = checkCapabilityManifest(dir, "docs.yaml");
    assert.deepEqual(diags, [], JSON.stringify(diags, null, 2));
    console.log("valid fixture OK (0 diagnostics)");
  }

  // Scalar shorthand vs. object form: identical diagnostics after
  // normalization.
  {
    const m = baseManifest();
    m.capabilities["sessions.resume"].dimensions = {
      recognized: { status: true },
      mounted: { status: true, notes: "preset row" },
      behavioral: { status: "full" },
      ux: { status: "full" },
    };
    const dir = writeFixture(dump(m), GOOD_FILES);
    const diags = checkCapabilityManifest(dir, "docs.yaml");
    assert.deepEqual(diags, [], JSON.stringify(diags, null, 2));
    console.log("object-form normalization OK (0 diagnostics)");
  }

  // 2) One minimal fixture per invariant.
  const violates = (name, mutate, rule) => {
    const m = baseManifest();
    mutate(m);
    const dir = writeFixture(dump(m), GOOD_FILES);
    const diags = checkCapabilityManifest(dir, "docs.yaml");
    const errs = errorsOf(diags);
    assert.equal(errs.length, 1, `${name}: ${JSON.stringify(diags, null, 2)}`);
    assert.equal(errs[0].rule, rule, `${name}: ${JSON.stringify(errs, null, 2)}`);
    assert.equal(errs[0].level, "error");
    console.log(`${name} OK (rule ${rule} named)`);
  };

  violates(
    "I1",
    (m) => {
      m.capabilities["sessions.resume"].dimensions = {
        recognized: false,
        mounted: true,
        behavioral: "missing",
        ux: "missing",
      };
      m.capabilities["sessions.resume"].deviation = {
        kind: "downgrade",
        summary: "mounted but unrecognized",
      };
    },
    "I1",
  );
  violates(
    "I2",
    (m) => {
      m.capabilities["sessions.resume"].dimensions = {
        recognized: false,
        mounted: false,
        behavioral: "full",
        ux: "missing",
      };
      m.capabilities["sessions.resume"].deviation = {
        kind: "downgrade",
        summary: "engine only",
      };
      m.capabilities["sessions.resume"].evidence = [
        { type: "test", path: "packages/sessions/tests/resume.spec.ts" },
      ];
    },
    "I2",
  );
  violates(
    "I3",
    (m) => {
      m.capabilities["sessions.resume"].dimensions.ux = "full";
      m.capabilities["sessions.resume"].dimensions.behavioral = "partial";
      m.capabilities["sessions.resume"].dimensions.mounted = false;
      m.capabilities["sessions.resume"].deviation = {
        kind: "downgrade",
        summary: "partial",
      };
m.capabilities["sessions.resume"].evidence = [
        { type: "test", path: "packages/sessions/tests/resume.spec.ts" },
      ];
    },
    "I3",
  );
  violates(
    "I4",
    (m) => {
      m.capabilities["sessions.resume"].dimensions = {
        recognized: true,
        mounted: false,
        behavioral: "partial",
        ux: "missing",
      };
      m.capabilities["sessions.resume"].deviation = {
        kind: "downgrade",
        summary: "partial",
      };
      m.capabilities["sessions.resume"].evidence = [];
    },
    "I4",
  );
  violates(
    "I5",
    (m) => {
      m.capabilities["sessions.checkpointing"].deviation.upstream_dependency =
        "no-such-seam";
    },
    "I5",
  );
  violates(
    "I6",
    (m) => {
      m.capabilities["sessions.resume"].deviation = {
        kind: "non-goal",
        summary: "not porting",
      };
      m.capabilities["sessions.resume"].dimensions = {
        recognized: true,
        mounted: false,
        behavioral: "partial",
        ux: "partial",
      };
      m.capabilities["sessions.resume"].evidence = [
        { type: "test", path: "packages/sessions/tests/resume.spec.ts" },
      ];
    },
    "I6",
  );
  violates(
    "I7-format",
    (m) => {
      const cap = m.capabilities["sessions.checkpointing"];
      delete m.capabilities["sessions.checkpointing"];
      m.capabilities["sessions.resume_X"] = cap;
    },
    "I7",
  );
  violates(
    "I7-order",
    (m) => {
      m.categories = [
        { id: "memory", title: "Memory" },
        { id: "sessions", title: "Sessions" },
      ];
      const cap = m.capabilities["sessions.checkpointing"];
      cap.category = "memory";
      delete m.capabilities["sessions.checkpointing"];
      m.capabilities["memory.snapshot"] = cap;
      // memory.snapshot placed after sessions.resume → violates category
      // ordering
    },
    "I7",
  );
  violates(
    "I9",
    (m) => {
      m.capabilities["sessions.rw-deprecated"] = {
        title: "Old",
        category: "sessions",
        plane: "preset",
        upstream: { summary: "old", refs: [] },
        dimensions: {
          recognized: false,
          mounted: false,
          behavioral: "missing",
          ux: "missing",
        },
        evidence: [],
        deprecated: true,
        replaced_by: "sessions.nope",
        deviation: { kind: "downgrade", summary: "stub" },
      };
    },
    "I9",
  );
  violates(
    "I10",
    (m) => {
      m.capabilities["sessions.resume"].evidence[1].anchor = "absent-anchor";
    },
    "I10",
  );
  violates(
    "I11",
    (m) => {
      m.capabilities["sessions.resume"].deviation = { kind: "none" };
      m.capabilities["sessions.resume"].dimensions.behavioral = "partial";
      m.capabilities["sessions.resume"].dimensions.ux = "missing";
    },
    "I11",
  );

  // I7 duplicate id: js-yaml rejects duplicate keys at parse time; the
  // loader surfaces one manifest diagnostic.
  {
    const dumped = dump(baseManifest());
    const dup = dumped.replace(
      /^(\s*)sessions\.resume:/m,
      "$1sessions.resume:\n$1  title: Resume again\n$1sessions.resume:",
    );
    assert.ok(dup !== dumped, "fixture rewrite failed");
    const dir = writeFixture(dup, GOOD_FILES);
    const errs = errorsOf(checkCapabilityManifest(dir, "docs.yaml"));
    assert.equal(errs.length, 1, JSON.stringify(errs, null, 2));
    assert.equal(errs[0].rule, "manifest");
    assert.ok(/duplicated mapping key/i.test(errs[0].message));
    console.log("I7-duplicate OK (rejected at YAML parse)");
  }

  // 3) Evidence path existence: a missing file → error (rule "evidence").
  {
    const dir = writeFixture(dump(baseManifest()), [[PRESET, PRESET_BODY]]);
    const errs = errorsOf(checkCapabilityManifest(dir, "docs.yaml"));
    assert.equal(errs.length, 1, JSON.stringify(errs, null, 2));
    assert.equal(errs[0].rule, "evidence");
    assert.ok(errs[0].message.includes("resume.spec.ts"));
    console.log("evidence-exists OK (missing file named)");
  }

  // 4) Anchor rules: URL evidence must not carry an anchor (schema error);
  // an anchor must match a literal substring.
  {
    const m = baseManifest();
    m.capabilities["sessions.resume"].evidence = [
      { type: "doc", path: "https://code.claude.com/docs/en/resume", anchor: "x" },
      { type: "source", path: PRESET, anchor: "-sessions-resume" },
    ];
    const dir = writeFixture(dump(m), GOOD_FILES);
    const errs = errorsOf(checkCapabilityManifest(dir, "docs.yaml"));
    assert.equal(errs.length, 1, JSON.stringify(errs, null, 2));
    assert.equal(errs[0].rule, "schema");
    console.log("anchor-on-url OK (rejected)");
  }

  // 5) Freshness (I8): a stale retrieved date → WARNING, never an error.
  {
    const m = baseManifest();
    m.capabilities["sessions.resume"].upstream.refs[0].retrieved = OLD;
    const dir = writeFixture(dump(m), GOOD_FILES);
    const diags = checkCapabilityManifest(dir, "docs.yaml");
    assert.deepEqual(errorsOf(diags), [], JSON.stringify(diags, null, 2));
    const warns = warningsOf(diags);
    assert.equal(warns.length, 1, JSON.stringify(diags, null, 2));
    assert.equal(warns[0].rule, "I8");
    assert.equal(warns[0].capability, "sessions.resume");
    assert.ok(warns[0].message.includes("2020-01-01"));
    console.log("freshness WARNING OK (run stays green)");
  }

  // 6) Manifest file missing → actionable error.
  {
    const diags = checkCapabilityManifest(root, "does-not-exist.yaml");
    assert.equal(diags.length, 1);
    assert.equal(diags[0].level, "error");
    assert.ok(/not found/i.test(diags[0].message));
    console.log("missing-manifest OK (actionable message)");
  }

  // 7) CLI: missing manifest → exit 1 + message.
  {
    const script = join(dirname(fileURLToPath(import.meta.url)), "check-capability-evidence.mjs");
    const r = spawnSync(process.execPath, [script, join(root, "nope.yaml")], {
      encoding: "utf8",
    });
    assert.equal(r.status, 1, `exit ${r.status}: ${r.stderr}`);
    assert.ok(/not found/i.test(r.stdout + r.stderr));
    console.log("CLI missing-manifest OK (exit 1)");
  }

  console.log("\nALL CAPABILITY-MANIFEST TESTS PASSED");
} finally {
  rmSync(root, { recursive: true, force: true });
}
