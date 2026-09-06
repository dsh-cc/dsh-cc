#!/usr/bin/env node
/* check-spec-deps.mjs 的测试夹具:合成仓库 + 真实仓库冒烟 */
import { findSpecImportProblems } from "./check-spec-deps.mjs";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const root = mkdtempSync(join(tmpdir(), "spec-deps-"));
try {
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ devDependencies: { vitest: "4.1.8" } }),
  );
  writeFileSync(
    join(root, "tsconfig.base.json"),
    // JSONC-ish: comments + trailing comma on purpose
    `{
       // workspace aliases
       "compilerOptions": {
         "paths": {
           "@dsh-cc/ok-tools": ["./packages/core/ok-tools/src/index.ts"],
         },
       },
     }`,
  );

  const pkg = (rel, pkgJson, specText) => {
    const dir = join(root, "packages", rel);
    mkdirSync(join(dir, "tests"), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify(pkgJson));
    writeFileSync(join(dir, "tests", "x.spec.ts"), specText);
  };

  // clean: devDep exact / devDep subpath / peerDep / tsconfig paths / root devDep /
  // self-name / node: / relative — all resolvable
  pkg(
    "core/good",
    {
      name: "@t/good",
      devDependencies: {
        "@deepseek-ai/dsh-foo": "link:../foo",
      },
      peerDependencies: { "@deepseek-ai/dsh-peer": "link:../peer" },
    },
    [
      `import a from '@deepseek-ai/dsh-foo'`,
      `import b from '@deepseek-ai/dsh-foo/sub'`,
      `import c from '@deepseek-ai/dsh-peer'`,
      `import d from '@dsh-cc/ok-tools'`,
      `import { it } from 'vitest'`,
      `import self from '@t/good'`,
      `import sub from '@t/good/src/extra'`,
      `import fs from 'node:fs'`,
      `import e from './helper'`,
      `export { x } from './other'`,
      `const later = await import('@deepseek-ai/dsh-foo')`,
    ].join("\n") + "\n",
  );

  // bad: undeclared harness import
  pkg("core/bad", { name: "@t/bad" }, `import x from '@deepseek-ai/dsh-bar'\n`);

  // bad: workspace alias absent from declarations AND tsconfig paths
  pkg("core/bad2", { name: "@t/bad2" }, `import y from '@dsh-cc/unknown-x'\n`);

  const problems = findSpecImportProblems(root);
  assert.equal(problems.length, 2, JSON.stringify(problems, null, 2));
  assert.equal(problems[0].specifier, "@deepseek-ai/dsh-bar");
  assert.ok(problems[0].reason.includes("packages/core/bad/package.json"));
  assert.equal(problems[1].specifier, "@dsh-cc/unknown-x");
  console.log("fixture suite OK (2 expected problems found)");

  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const real = findSpecImportProblems(repoRoot);
  assert.deepEqual(real, [], JSON.stringify(real, null, 2));
  console.log("real-repo scan OK (0 problems)");
} finally {
  rmSync(root, { recursive: true, force: true });
}
