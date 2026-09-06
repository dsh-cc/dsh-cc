#!/usr/bin/env node
/**
 * check-publish-manifests.test.mjs — self-running test harness.
 *
 * Uses node:assert/strict + node:child_process (NOT vitest; the repo vitest
 * config only includes spec files under packages/<category>/<pkg>/tests).
 *
 * Covers: the minimal semver comparator's prerelease/release edge cases,
 * loud failure on unrecognized range shapes, and fixture-based happy /
 * violation paths through the manifest scanner. One smoke assertion runs
 * the scanner over the REAL repo's publishConfig + no-link rules — that
 * assertion will only pass once the parallel manifest remediation lands.
 */
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseVersion,
  compareVersions,
  rangeSatisfiedBy,
  findManifestViolations,
  normalizeRepoSlug,
  repositoryMatchesExpected,
  EXPECTED_REPOSITORY,
} from "./check-publish-manifests.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const SCRIPT = join(__dirname, "check-publish-manifests.mjs");

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
function runScript(args, cwd) {
  const res = spawnSync("node", [SCRIPT, cwd], { encoding: "utf-8" });
  return { stdout: res.stdout ?? "", stderr: res.stderr ?? "", status: res.status };
}

/* ---- semver comparator: prerelease edge cases ---- */

check("parseVersion: 0.1.1-rc.2", () => {
  assert.deepEqual(parseVersion("0.1.1-rc.2").release, [0, 1, 1]);
  assert.deepEqual(parseVersion("0.1.1-rc.2").prerelease, ["rc", "2"]);
});
check("parseVersion: bare 0.1.1 has empty prerelease", () => {
  assert.deepEqual(parseVersion("0.1.1").prerelease, []);
});
check("compareVersions: final > same-tuple prerelease", () => {
  assert.equal(compareVersions(parseVersion("0.1.1"), parseVersion("0.1.1-rc.2")), 1);
});
check("compareVersions: 0.2.0 > 0.1.1-rc.2", () => {
  assert.equal(compareVersions(parseVersion("0.2.0"), parseVersion("0.1.1-rc.2")), 1);
});

/* 0.2.0-rc.1 vs >=0.1.1-rc.2 → NOT satisfied (pre-release of higher tuple) */
check("0.2.0-rc.1 NOT satisfied by >=0.1.1-rc.2", () => {
  assert.equal(rangeSatisfiedBy(">=0.1.1-rc.2", "0.2.0-rc.1"), false);
});
/* 0.1.1-rc.3 satisfied by >=0.1.1-rc.2 */
check("0.1.1-rc.3 satisfied by >=0.1.1-rc.2", () => {
  assert.equal(rangeSatisfiedBy(">=0.1.1-rc.2", "0.1.1-rc.3"), true);
});
/* 0.1.1 (final) satisfied by >=0.1.1-rc.2 */
check("0.1.1 satisfied by >=0.1.1-rc.2", () => {
  assert.equal(rangeSatisfiedBy(">=0.1.1-rc.2", "0.1.1"), true);
});
/* exact floor boundary satisfied */
check("0.1.1-rc.2 satisfies its own >= floor", () => {
  assert.equal(rangeSatisfiedBy(">=0.1.1-rc.2", "0.1.1-rc.2"), true);
});
/* caret: ^3.18.1 — 3.18.1 yes, 4.0.0 no */
check("^3.18.1 satisfied by 3.18.1", () => {
  assert.equal(rangeSatisfiedBy("^3.18.1", "3.18.1"), true);
});
check("^3.18.1 NOT satisfied by 4.0.0", () => {
  assert.equal(rangeSatisfiedBy("^3.18.1", "4.0.0"), false);
});
/* bare exact */
check("exact 3.18.1 satisfied by 3.18.1, not 3.18.2", () => {
  assert.equal(rangeSatisfiedBy("3.18.1", "3.18.1"), true);
  assert.equal(rangeSatisfiedBy("3.18.1", "3.18.2"), false);
});
/* unrecognized range shapes fail loudly */
for (const bad of ["~3.18.1", ">=0.1.1 <0.2.0", "1.2.x", "*"]) {
  check(`unrecognized range '${bad}' throws`, () => {
    assert.throws(
      () => rangeSatisfiedBy(bad, "3.18.1"),
      /unrecognized range shape/,
    );
  });
}
check("malformed >= floor throws", () => {
  assert.throws(() => rangeSatisfiedBy(">=not-a-version", "0.1.0"), /malformed '>=' range/);
});

/* ---- repository provenance normalization ---- */

const GOOD_REPO = {
  type: "git",
  url: "git+https://github.com/dsh-cc/dsh-cc.git",
  directory: "packages/a/public-pkg",
};
check("normalizeRepoSlug: git+https + .git + directory", () => {
  assert.equal(normalizeRepoSlug(GOOD_REPO), EXPECTED_REPOSITORY);
});
check("normalizeRepoSlug: plain https url, no .git", () => {
  assert.equal(
    normalizeRepoSlug({ url: "https://github.com/dsh-cc/dsh-cc" }),
    EXPECTED_REPOSITORY,
  );
});
check("normalizeRepoSlug: ssh scp-like form", () => {
  assert.equal(
    normalizeRepoSlug({ url: "git@github.com:dsh-cc/dsh-cc.git" }),
    EXPECTED_REPOSITORY,
  );
});
check("normalizeRepoSlug: shorthand string", () => {
  assert.equal(normalizeRepoSlug("dsh-cc/dsh-cc"), EXPECTED_REPOSITORY);
});
check("normalizeRepoSlug: missing / empty / wrong repo", () => {
  assert.equal(normalizeRepoSlug(undefined), null);
  assert.equal(normalizeRepoSlug({}), null);
  assert.equal(normalizeRepoSlug({ url: "" }), null);
  assert.notEqual(
    normalizeRepoSlug({ url: "git+https://github.com/other/repo.git" }),
    EXPECTED_REPOSITORY,
  );
});
check("repositoryMatchesExpected: the pi-tui incident shape", () => {
  assert.equal(repositoryMatchesExpected(GOOD_REPO), true);
  assert.equal(repositoryMatchesExpected(undefined), false); // the v0.1.1 bug
  assert.equal(repositoryMatchesExpected({ url: "" }), false);
});

const BAD_DANGLING_LINK = {
  // mimics the v0.4.1 incident: devDependencies link: path points at a
  // directory that does not exist (packages/interaction/session-cwd),
  // so pnpm installs a dangling symlink and `pnpm publish` later dies
  // with ERR_PNPM_CANNOT_RESOLVE_WORKSPACE_PROTOCOL on the workspace: peer.
  "packages/a/dangling-link-pkg/package.json": JSON.stringify(
    {
      name: "@dsh-cc/dangling-link-pkg",
      version: "0.1.0",
      publishConfig: { access: "public" },
      license: "Apache-2.0",
      repository: {
        type: "git",
        url: "git+https://github.com/dsh-cc/dsh-cc.git",
        directory: "packages/a/dangling-link-pkg",
      },
      peerDependencies: { "@dsh-cc/session-cwd": "workspace:^" },
      devDependencies: { "@dsh-cc/session-cwd": "link:../session-cwd" },
    },
    null,
    2,
  ),
};
const BAD_RESOLVED_LINK = {
  // devDeps link: values that DO resolve to real workspace dirs are fine
  "packages/a/resolved-link-pkg/package.json": JSON.stringify(
    {
      name: "@dsh-cc/resolved-link-pkg",
      version: "0.1.0",
      publishConfig: { access: "public" },
      license: "Apache-2.0",
      repository: {
        type: "git",
        url: "git+https://github.com/dsh-cc/dsh-cc.git",
        directory: "packages/a/resolved-link-pkg",
      },
      devDependencies: { "@dsh-cc/lib": "link:../lib" },
    },
    null,
    2,
  ),
  "packages/a/lib/package.json": JSON.stringify({
    name: "@dsh-cc/lib",
    version: "0.1.0",
    private: true,
  }),
};

/* ---- fixture: happy path ---- */

function makeFixture(files) {
  const dir = mkdtempSync(join(tmpdir(), "publish-manifests-"));
  for (const [rel, text] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, text);
  }
  return dir;
}
const GOOD_PUBLIC = {
  "packages/a/public-pkg/package.json": JSON.stringify(
    {
      name: "@dsh-cc/public-pkg",
      version: "0.1.0",
      publishConfig: { access: "public" },
      license: "Apache-2.0",
      repository: {
        type: "git",
        url: "git+https://github.com/dsh-cc/dsh-cc.git",
        directory: "packages/a/public-pkg",
      },
      dependencies: {},
    },
    null,
    2,
  ),
};
const BAD_NO_REPO = {
  "packages/a/norepo-pkg/package.json": JSON.stringify(
    {
      name: "@dsh-cc/norepo-pkg",
      version: "0.1.0",
      publishConfig: { access: "public" },
      dependencies: {},
    },
    null,
    2,
  ),
};
const BAD_WRONG_REPO = {
  "packages/a/wrongrepo-pkg/package.json": JSON.stringify(
    {
      name: "@dsh-cc/wrongrepo-pkg",
      version: "0.1.0",
      publishConfig: { access: "public" },
      repository: { type: "git", url: "git+https://github.com/other/repo.git" },
      dependencies: {},
    },
    null,
    2,
  ),
};
const BAD_PUBLIC = {
  "packages/a/closed-pkg/package.json": JSON.stringify(
    {
      name: "@dsh-cc/closed-pkg",
      version: "0.1.0",
      dependencies: { foo: "1.0.0" },
    },
    null,
    2,
  ),
};
const BAD_LINK = {
  "packages/a/link-pkg/package.json": JSON.stringify(
    {
      name: "@dsh-cc/link-pkg",
      version: "0.1.0",
      publishConfig: { access: "public" },
      dependencies: { "@deepseek-ai/dsh-llm": "link:../../../../somewhere" },
    },
    null,
    2,
  ),
};
const GOOD_PRIVATE = {
  "packages/a/private-pkg/package.json": JSON.stringify(
    { name: "@dsh-cc/private-pkg", version: "0.1.0", private: true },
    null,
    2,
  ),
};

// note: fixtures on tmpdir have NO sibling deepseek-harness, so the
// harness range-check block is skipped — the no-link + publishConfig rules
// are exercised directly.
{
  const dir = makeFixture({ ...GOOD_PUBLIC, ...GOOD_PRIVATE });
  try {
    check("fixture happy path: CLI exits 0", () => {
      const { status } = runScript([], dir);
      assert.equal(status, 0, `expected exit 0, got ${status}`);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
{
  const dir = makeFixture({ ...GOOD_PUBLIC, ...BAD_PUBLIC, ...BAD_LINK });
  try {
    check("fixture violation path: CLI exits 1", () => {
      const { status, stderr } = runScript([], dir);
      assert.equal(status, 1, `expected exit 1, got ${status}`);
      assert.ok(stderr.includes("closed-pkg"), `expected closed-pkg in output`);
      assert.ok(stderr.includes("link-pkg"), `expected link-pkg in output`);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
{
  const dir = makeFixture({ ...GOOD_PUBLIC, ...BAD_PUBLIC, ...BAD_LINK });
  try {
    check("fixture violation path: in-process problems listed", () => {
      const problems = findManifestViolations(dir);
      const reasons = problems.map((p) => p.reason).join("\n");
      assert.ok(problems.some((p) => p.pkg.includes("closed-pkg")), "missing access violation");
      assert.ok(problems.some((p) => p.pkg.includes("link-pkg")), "missing link violation");
      assert.ok(reasons.includes("publishConfig.access"), "access reason text");
      assert.ok(reasons.includes("link:"), "link reason text");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/* ---- repository provenance gate: fixtures ---- */
{
  const dir = makeFixture({ ...GOOD_PUBLIC, ...BAD_NO_REPO, ...BAD_WRONG_REPO });
  try {
    check("repository gate: missing + wrong repo flagged, exit 1", () => {
      const { status, stderr } = runScript([], dir);
      assert.equal(status, 1, `expected exit 1, got ${status}`);
      assert.ok(stderr.includes("norepo-pkg"), "missing-repo pkg flagged");
      assert.ok(stderr.includes("wrongrepo-pkg"), "wrong-repo pkg flagged");
      assert.ok(stderr.includes("sigstore provenance"), "reason mentions provenance");
      assert.ok(!stderr.includes("public-pkg\n"), "good pkg NOT flagged");
    });
    check("repository gate: in-process reasons", () => {
      const problems = findManifestViolations(dir);
      const repoProblems = problems.filter((p) => /provenance/.test(p.reason));
      assert.equal(repoProblems.length, 2, `expected 2 repo violations, got ${repoProblems.length}`);
      assert.ok(repoProblems.every((p) => p.reason.includes(EXPECTED_REPOSITORY)));
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/* ---- dangling link: resolution gate: fixtures ---- */
{
  const dir = makeFixture({
    ...BAD_DANGLING_LINK,
    ...BAD_RESOLVED_LINK,
  });
  try {
    check("link resolution gate: dangling devDep link flagged, resolved link OK", () => {
      const problems = findManifestViolations(dir);
      const dangling = problems.filter((p) => p.pkg.includes("dangling-link-pkg"));
      assert.equal(dangling.length, 1, `expected 1 dangling-link violation, got ${JSON.stringify(dangling)}`);
      assert.ok(
        dangling[0].reason.includes("does not resolve"),
        `reason should mention non-resolution, got: ${dangling[0].reason}`,
      );
      assert.ok(
        dangling[0].reason.includes("@dsh-cc/session-cwd"),
        "reason should name the offending dependency",
      );
      assert.ok(
        !problems.some((p) => p.pkg.includes("resolved-link-pkg")),
        `resolved link must NOT be flagged, got: ${problems.filter((p) => p.pkg.includes("resolved-link-pkg")).map((p) => p.reason).join("; ")}`,
      );
    });
    check("link resolution gate: CLI exits 1 on dangling link", () => {
      const { status, stderr } = runScript([], dir);
      assert.equal(status, 1, `expected exit 1, got ${status}`);
      assert.ok(stderr.includes("dangling-link-pkg"), "dangling pkg in CLI output");
      assert.ok(!stderr.includes("resolved-link-pkg"), "resolved pkg NOT in CLI output");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/* ---- smoke: real repo MUST pass publishConfig + no-link rules ---- */
// NOTE: this only passes once the parallel manifest remediation lands. If
// it fails here because remediation is pending, it is a known-failure, not
// a code defect — do not weaken the assertion.
{
  check("REAL repo passes publishConfig + no-link rules", () => {
    const problems = findManifestViolations(ROOT);
    const linkAccess = problems.filter((p) =>
      /publishConfig.access|link: value/.test(p.reason),
    );
    assert.equal(
      linkAccess.length,
      0,
      `expected zero publishConfig/no-link violations, got ${
        linkAccess.length
      }: ${linkAccess.map((p) => `${p.pkg} (${p.reason})`).join("; ")}`,
    );
  });
  check("REAL repo: every publishable package declares provenance repository", () => {
    const problems = findManifestViolations(ROOT).filter((p) => /provenance/.test(p.reason));
    assert.equal(
      problems.length,
      0,
      `expected zero repository-provenance violations, got: ${problems
        .map((p) => `${p.pkg} (${p.reason})`)
        .join("; ")}`,
    );
  });
  check("REAL repo: every link: dependency resolves to an existing directory", () => {
    const problems = findManifestViolations(ROOT).filter((p) =>
      /does not resolve/.test(p.reason),
    );
    assert.equal(
      problems.length,
      0,
      `expected zero dangling link: violations, got: ${problems
        .map((p) => `${p.pkg} (${p.reason})`)
        .join("; ")}`,
    );
  });
}

if (failures > 0) {
  console.error(`\n${failures} case(s) failed.`);
  process.exit(1);
}
console.log("publish-manifests check passed.");
