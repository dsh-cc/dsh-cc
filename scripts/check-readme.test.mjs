#!/usr/bin/env node
/**
 * check-readme.test.mjs — self-running test harness (mirrors the
 * check-publish-manifests.test.mjs idiom: node:assert/strict + check()/fail
 * counters, NOT vitest — the vitest config only covers packages/<c>/<p>/tests).
 *
 * Fixtures are tmp dirs simulating a repo root with
 * packages/<group>/<pkg>/package.json + README files; each fixture runs
 * `git init -q` because the checker shells out to `git hash-object`, which
 * needs a repo (files on disk suffice — no commits needed).
 *
 * Exemptions are injectable: collectProblems(root, { exemptions }) defaults
 * to the exported EXEMPTIONS, so tests fixture their own pinned-hash package.
 */
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { collectProblems, writeRecords, EXEMPTIONS } from "./check-readme.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
// referenced by the writeRecords default-exemptions test below
void EXEMPTIONS;

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

function makePkg(root, rel, files = {}) {
  const pkgDir = join(root, rel);
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, "package.json"), '{"name":"x"}\n');
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(pkgDir, name), content);
  }
  return pkgDir;
}

// Injection note: the real EXEMPTIONS pin can't be reproduced by a fixture
// (it would require a preimage), so tests 6 inject an exemption whose pin is
// the hash of the fixture content itself; EXEMPTIONS stays the default.
function exemptionFor(root, rel) {
  const hash = (f) =>
    spawnSync("git", ["hash-object", join(root, rel, f)], { cwd: root, encoding: "utf8" }).stdout.trim();
  return new Map([["packages/ui/pi-tui", { reason: "fixture", readmeHash: hash("README.md") }]]);
}

function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), "check-readme-test-"));
  spawnSync("git", ["init", "-q"], { cwd: root });
  return root;
}

function recordFor(root, rel) {
  const pkgDir = join(root, rel);
  const hash = (f) =>
    spawnSync("git", ["hash-object", join(pkgDir, f)], { cwd: root, encoding: "utf8" }).stdout.trim();
  return `README.md: ${hash("README.md")}\nREADME.zh.md: ${hash("README.zh.md")}\n`;
}

const EN = "# hello\nenglish side\n";
const ZH = "# 你好\nchinese side\n";

/* 1. complete trio passes */
check("complete trio passes", () => {
  const root = makeRepo();
  try {
    const pkgDir = makePkg(root, "packages/a/good", { "README.md": EN, "README.zh.md": ZH });
    writeFileSync(join(pkgDir, "README.i18n.yaml"), recordFor(root, "packages/a/good"));
    assert.deepEqual(collectProblems(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* 2. missing README.zh.md fails with presence diagnostic */
check("missing README.zh.md fails", () => {
  const root = makeRepo();
  try {
    makePkg(root, "packages/a/partial", {
      "README.md": EN,
      "README.i18n.yaml": "README.md: " + "a".repeat(40) + "\n",
    });
    const problems = collectProblems(root);
    assert.equal(problems.length, 1);
    assert.match(problems[0].problem, /missing README\.zh\.md$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* 3. missing README.i18n.yaml fails */
check("missing README.i18n.yaml fails", () => {
  const root = makeRepo();
  try {
    makePkg(root, "packages/a/norecord", { "README.md": EN, "README.zh.md": ZH });
    const problems = collectProblems(root);
    assert.match(problems[0].problem, /missing README\.i18n\.yaml$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* 4. stale hash fails */
check("stale hash fails after README.md edit", () => {
  const root = makeRepo();
  try {
    const pkgDir = makePkg(root, "packages/a/stale", { "README.md": EN, "README.zh.md": ZH });
    writeFileSync(join(pkgDir, "README.i18n.yaml"), recordFor(root, "packages/a/stale"));
    writeFileSync(join(pkgDir, "README.md"), "# edited\nnow different\n");
    const problems = collectProblems(root);
    assert.equal(problems.length, 1);
    assert.match(problems[0].problem, /hash recorded [0-9a-f]{40} but current is [0-9a-f]{40} — pair changed without re-recording/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* 5. record shape violations */
check("record shape: extra key fails", () => {
  const root = makeRepo();
  try {
    const pkgDir = makePkg(root, "packages/a/extra", { "README.md": EN, "README.zh.md": ZH });
    writeFileSync(
      join(pkgDir, "README.i18n.yaml"),
      recordFor(root, "packages/a/extra") + "README.fr.md: " + "a".repeat(40) + "\n",
    );
    assert.match(collectProblems(root)[0].problem, /unexpected key README\.fr\.md/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
check("record shape: missing key fails", () => {
  const root = makeRepo();
  try {
    makePkg(root, "packages/a/half", { "README.md": EN, "README.zh.md": ZH });
    const rec = recordFor(root, "packages/a/half");
    const pkgDir = join(root, "packages/a/half");
    writeFileSync(join(pkgDir, "README.i18n.yaml"), rec.split("\n").filter((l) => !l.startsWith("README.zh")).join("\n"));
    assert.match(collectProblems(root)[0].problem, /missing key README\.zh\.md/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
check("record shape: non-40-hex value fails", () => {
  const root = makeRepo();
  try {
    makePkg(root, "packages/a/badhex", {
      "README.md": EN,
      "README.zh.md": ZH,
      "README.i18n.yaml": "README.md: nothex\nREADME.zh.md: " + "b".repeat(40) + "\n",
    });
    assert.match(collectProblems(root)[0].problem, /non-40-hex value/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* 6. exempted package: matching pin passes; drifted README fails */
check("exempted package with matching pin passes", () => {
  const root = makeRepo();
  try {
    makePkg(root, "packages/ui/pi-tui", { "README.md": EN });
    const exemptions = exemptionFor(root, "packages/ui/pi-tui");
    assert.deepEqual(collectProblems(root, { exemptions }), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
check("exempted package with drifted README.md fails", () => {
  const root = makeRepo();
  try {
    makePkg(root, "packages/ui/pi-tui", { "README.md": EN });
    const exemptions = exemptionFor(root, "packages/ui/pi-tui");
    writeFileSync(join(root, "packages/ui/pi-tui/README.md"), "# locally edited\nnope\n");
    const problems = collectProblems(root, { exemptions });
    assert.equal(problems.length, 1);
    assert.match(problems[0].problem, /exempted package README\.md drifted from pinned hash/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* 7. --write round-trip */
check("--write round-trip: clean after write, header present", () => {
  const root = makeRepo();
  try {
    makePkg(root, "packages/a/written", { "README.md": EN, "README.zh.md": ZH });
    const res = writeRecords(root);
    assert.equal(res.ok, true);
    assert.equal(res.written, 1);
    assert.equal(res.created, 1);
    assert.deepEqual(collectProblems(root), []);
    const text = readFileSync(join(root, "packages/a/written/README.i18n.yaml"), "utf8");
    assert.ok(text.includes("pnpm check:readme --write"));
    assert.ok(text.endsWith("\n") && !text.endsWith("\n\n"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* 8. --write atomicity: nothing written when any pair incomplete */
check("--write atomicity: no records written when a pair is incomplete", () => {
  const root = makeRepo();
  try {
    makePkg(root, "packages/a/complete", { "README.md": EN, "README.zh.md": ZH });
    makePkg(root, "packages/a/incomplete", { "README.md": EN }); // no zh
    const res = writeRecords(root);
    assert.equal(res.ok, false);
    assert.match(res.problems[0], /missing README\.zh\.md/);
    assert.equal(existsSync(join(root, "packages/a/complete/README.i18n.yaml")), false);
    assert.equal(existsSync(join(root, "packages/a/incomplete/README.i18n.yaml")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* 9. exempted package never written under --write */
check("--write never writes exempted packages", () => {
  const root = makeRepo();
  try {
    makePkg(root, "packages/ui/pi-tui", { "README.md": EN });
    const res = writeRecords(root, { exemptions: EXEMPTIONS });
    assert.equal(res.ok, true);
    assert.equal(res.written, 0);
    assert.equal(existsSync(join(root, "packages/ui/pi-tui/README.i18n.yaml")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

if (failures) process.exitCode = 1;
