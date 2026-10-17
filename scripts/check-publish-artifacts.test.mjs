#!/usr/bin/env node
/**
 * check-publish-artifacts.test.mjs — self-running test harness.
 *
 * Uses node:assert/strict + node:child_process (NOT vitest; the repo vitest
 * config only includes spec files under packages/<category>/<pkg>/tests).
 *
 * Covers the pure core (comment stripping, specifier collection, resolution
 * candidates) and fixture package trees created in a tmpdir for the end-to-end
 * gate: healthy emitted JSON, missing `../data/x.json` import, index/.mjs
 * resolution, dynamic import, bare-specifier skip, missing bin, commented-out
 * import.
 */
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  collectRelativeImports,
  resolveSpecifier,
  stripComments,
  main,
} from "./check-publish-artifacts.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const SCRIPT = join(__dirname, "check-publish-artifacts.mjs");

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
async function checkAsync(name, fn) {
  try {
    await fn();
    pass(name);
  } catch (e) {
    fail(name, e.message);
  }
}

/* ---- pure core: comment stripping ---- */

check("stripComments: removes line and block comments", () => {
  const src = stripComments(
    "// import x from './gone.js'\n/* import y from '../also-gone.js' */\nimport z from './real.js'\n",
  );
  assert.ok(!src.includes("gone"));
  assert.ok(src.includes("real.js"));
});

/* ---- pure core: collectRelativeImports ---- */

check("collectRelativeImports: all six forms, relative only", () => {
  const src = `
import a from './a.js';
import './b.js';
const c = import('./c.js');
export { d } from '../d.js';
const e = require('./e.js');
const f = require.resolve('./f.js');
import g from 'bare-pkg';
import h from '@scope/pkg';
`;
  assert.deepEqual(collectRelativeImports(src).sort(), [
    "../d.js",
    "./a.js",
    "./b.js",
    "./c.js",
    "./e.js",
    "./f.js",
  ]);
});

check("collectRelativeImports: commented-out imports ignored", () => {
  const src = `// import x from './x.js'\n/* import y from '../y.js' */\nconst z = 1;\n`;
  assert.deepEqual(collectRelativeImports(src), []);
});

/* ---- pure core: resolveSpecifier ---- */

check("resolveSpecifier: full candidate ladder", () => {
  const root = mkdtempSync(join(tmpdir(), "cpa-res-"));
  try {
    for (const rel of [
      "package/lib/exact.json",
      "package/lib/plus.js",
      "package/lib/index-dir/index.mjs",
      "package/lib/main-dir/package.json",
      "package/lib/main-dir/entry.cjs",
      "package/lib/from.js",
    ]) {
      const p = join(root, rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, rel.endsWith("package.json") ? JSON.stringify({ main: "./entry.cjs" }) : "");
    }
    const from = join(root, "package/lib/from.js");
    assert.equal(resolveSpecifier(root, from, "./exact.json"), join(root, "package/lib/exact.json"));
    assert.equal(resolveSpecifier(root, from, "./plus"), join(root, "package/lib/plus.js"));
    assert.equal(resolveSpecifier(root, from, "./index-dir"), join(root, "package/lib/index-dir/index.mjs"));
    assert.equal(resolveSpecifier(root, from, "./main-dir"), join(root, "package/lib/main-dir/entry.cjs"));
    assert.equal(resolveSpecifier(root, from, "./missing"), null);
    assert.equal(resolveSpecifier(root, from, "../../outside.js"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ---- end-to-end gate over fixture packages (real npm pack) ---- */

function fixturePkg(name, libFiles, bin) {
  return {
    "package.json": JSON.stringify({
      name,
      version: "0.0.0",
      license: "Apache-2.0",
      type: "module",
      files: ["lib"],
      ...(bin ? { bin } : {}),
    }),
    ...libFiles,
  };
}

async function runGate(filesByPkg) {
  const repo = mkdtempSync(join(tmpdir(), "cpa-repo-"));
  try {
    for (const [dir, files] of Object.entries(filesByPkg)) {
      for (const [rel, content] of Object.entries(files)) {
        const p = join(repo, dir, rel);
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, content);
      }
    }
    return await main(repo);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

await checkAsync("(a) healthy package with emitted JSON passes", async () => {
  assert.equal(
    await runGate({
      "packages/g/pa": fixturePkg("@t/pa", {
        "lib/index.js": "import t from './table.json'; console.log(t);\n",
        "lib/table.json": "{}",
      }),
    }),
    0,
  );
});

await checkAsync("(b) missing ../data/x.json import fails", async () => {
  assert.equal(
    await runGate({
      "packages/g/pb": fixturePkg("@t/pb", {
        // data/ is NOT packed (files: ["lib"] semantics of npm pack: package.json only
        // packs everything here, so put the import target outside the pack scope instead:
        "lib/index.js": "import t from '../data/x.json'; console.log(t);\n",
        "data/x.json": "{}",
      }),
    }),
    1,
  );
});

await checkAsync("(c) extension-less + index + .mjs resolution passes", async () => {
  assert.equal(
    await runGate({
      "packages/g/pc": fixturePkg("@t/pc", {
        "lib/index.js": "import './helper';\nimport './idx';\nimport './mod.mjs';\n",
        "lib/helper.js": "",
        "lib/idx/index.js": "",
        "lib/mod.mjs": "",
      }),
    }),
    0,
  );
});

await checkAsync("(d) dynamic import of a missing file fails", async () => {
  assert.equal(
    await runGate({
      "packages/g/pd": fixturePkg("@t/pd", {
        "lib/index.js": "const m = await import('./gone.js');\n",
      }),
    }),
    1,
  );
});

await checkAsync("(e) bare specifiers are skipped", async () => {
  assert.equal(
    await runGate({
      "packages/g/pe": fixturePkg("@t/pe", {
        "lib/index.js": "import fs from 'node:fs'; import x from 'some-pkg';\n",
      }),
    }),
    0,
  );
});

await checkAsync("(f) bin entry missing from packed files fails", async () => {
  assert.equal(
    await runGate({
      "packages/g/pf": fixturePkg("@t/pf", { "lib/index.js": "" }, { pf: "./bin/cli.js" }),
    }),
    1,
  );
});

await checkAsync("(g) commented-out import ignored end-to-end", async () => {
  assert.equal(
    await runGate({
      "packages/g/pg": fixturePkg("@t/pg", {
        "lib/index.js": "// import g from './gone.js'\nexport {}\n",
      }),
    }),
    0,
  );
});

/* ---- REAL repo smoke: gate passes on the built tree ---- */

const isDirectRun =
  process.argv[1] && process.argv[1].endsWith("check-publish-artifacts.test.mjs");
if (isDirectRun) {
  const res = spawnSync("node", [SCRIPT], { encoding: "utf-8", cwd: ROOT });
  if (res.status === 0) pass("REAL repo: gate passes on the built tree");
  else fail("REAL repo: gate passes on the built tree", `exit ${res.status}\n${res.stderr}`);

  if (failures > 0) {
    console.error(`\n${failures} case(s) failed.`);
    process.exit(1);
  }
  console.log("check-publish-artifacts tests passed.");
}
