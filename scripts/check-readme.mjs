#!/usr/bin/env node
/**
 * check-readme.mjs — presubmit gate: every workspace package carries a
 * bilingual README trio — README.md (en), README.zh.md (zh) and
 * README.i18n.yaml, a pairing record pinning the git blob hash of each side
 * as of the last confirmed-consistent state (see docs/i18n/README.md).
 *
 * Why this gate exists: README pairs drift — one language gets edited and
 * the other silently falls behind. The record makes the drift visible: both
 * hashes must match the working tree, so any edit to either side fails the
 * gate until the pair is re-confirmed and re-recorded.
 *
 * Exempted packages (vendored upstream copies) instead pin their README.md
 * hash so local edits fail the gate.
 *
 * Modes:
 *   default   — check: exit 0 when clean, exit 1 with one diagnostic per
 *               problem (presence, record shape, stale hash);
 *   --write   — re-record hashes for every package that has both README
 *               sides; validates ALL packages first (atomic — writes
 *               nothing if any pair is incomplete).
 *
 * Pure static, node stdlib only: must run before `pnpm install`.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Vendored upstream copies — never modified locally, so instead of a trio we
// pin README.md's git blob hash; any local edit fails the gate. Extend in a PR.
export const EXEMPTIONS = new Map([
  [
    "packages/ui/pi-tui",
    {
      reason: "vendored upstream copy — modified upstream only; documented upstream",
      readmeHash: "e6848048b5a204b2f40850b4ac5164ea163128f5",
    },
  ],
]);

const RECORD_HEADER = `# Bilingual-pair consistency record (docs/i18n/README.md): the git blob hash of each
# side as of the last confirmed-consistent state. Both languages carry equal authority;
# after editing either side, bring the other along and re-record with:
#   pnpm check:readme --write
`;

function* packagesUnder(root) {
  const packagesDir = join(root, "packages");
  if (!existsSync(packagesDir)) return;
  for (const group of readdirSync(packagesDir)) {
    const groupDir = join(packagesDir, group);
    if (!statSync(groupDir).isDirectory()) continue;
    for (const pkgName of readdirSync(groupDir)) {
      const pkgDir = join(groupDir, pkgName);
      if (existsSync(join(pkgDir, "package.json"))) yield pkgDir;
    }
  }
}

function gitHash(repoRoot, file) {
  const res = spawnSync("git", ["hash-object", file], { cwd: repoRoot, encoding: "utf8" });
  if (res.status !== 0) throw new Error(`git hash-object failed for ${file}: ${res.stderr}`);
  return res.stdout.trim();
}

/** Parses a README.i18n.yaml without a YAML library. Returns { record, problems } */
function parseRecord(pkgDir) {
  const problems = [];
  const record = new Map();
  const lines = readFileSync(join(pkgDir, "README.i18n.yaml"), "utf8").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.startsWith("#")) continue;
    const kv = line.match(/^([A-Za-z][A-Za-z0-9.]*): (.*)$/);
    if (!kv) {
      problems.push(`${pkgDir}/README.i18n.yaml: line ${i + 1}: unparseable line: ${line}`);
      continue;
    }
    if (kv[1] !== "README.md" && kv[1] !== "README.zh.md") {
      problems.push(`${pkgDir}/README.i18n.yaml: line ${i + 1}: unexpected key ${kv[1]}`);
      continue;
    }
    if (!/^[0-9a-f]{40}$/.test(kv[2])) {
      problems.push(`${pkgDir}/README.i18n.yaml: line ${i + 1}: non-40-hex value for ${kv[1]}: ${kv[2]}`);
      continue;
    }
    if (record.has(kv[1])) problems.push(`${pkgDir}/README.i18n.yaml: line ${i + 1}: duplicate key ${kv[1]}`);
    record.set(kv[1], kv[2]);
  }
  for (const key of ["README.md", "README.zh.md"]) {
    if (!record.has(key)) problems.push(`${pkgDir}/README.i18n.yaml: missing key ${key}`);
  }
  for (const key of record.keys()) {
    if (key !== "README.md" && key !== "README.zh.md")
      problems.push(`${pkgDir}/README.i18n.yaml: unexpected key ${key}`);
  }
  return { record, problems };
}

/**
 * Checks all packages under `root`. Exemptions are injectable (defaults to
 * EXEMPTIONS) so tests can fixture their own pinned-hash packages.
 * Returns [{ pkgDir, problem }] — empty when clean.
 */
export function collectProblems(rootDir, { exemptions = EXEMPTIONS } = {}) {
  const problems = [];
  for (const pkgDir of packagesUnder(rootDir)) {
    const rel = pkgDir.slice(rootDir.length + 1);
    const exempt = exemptions.get(rel);
    if (exempt) {
      const readme = join(pkgDir, "README.md");
      if (existsSync(readme) && gitHash(rootDir, readme) !== exempt.readmeHash) {
        problems.push({
          pkgDir,
          problem: `exempted package README.md drifted from pinned hash ${exempt.readmeHash} — vendored upstream copy must not be modified locally`,
        });
      }
      continue;
    }
    const missing = ["README.md", "README.zh.md", "README.i18n.yaml"].filter(
      (f) => !existsSync(join(pkgDir, f)),
    );
    if (missing.length) {
      for (const f of missing) problems.push({ pkgDir, problem: `${pkgDir}: missing ${f}` });
      continue; // record/freshness checks are meaningless without the files
    }
    const { record, problems: shapeProblems } = parseRecord(pkgDir);
    problems.push(...shapeProblems.map((problem) => ({ pkgDir, problem })));
    if (shapeProblems.length) continue;
    for (const key of ["README.md", "README.zh.md"]) {
      const current = gitHash(rootDir, join(pkgDir, key));
      const recorded = record.get(key);
      if (current !== recorded) {
        problems.push({
          pkgDir,
          problem: `${pkgDir}: ${key.replace(/\.md$/, "")} hash recorded ${recorded} but current is ${current} — pair changed without re-recording`,
        });
      }
    }
  }
  return problems;
}

/**
 * --write mode. Validates every non-exempt package has both README sides
 * BEFORE writing anything (atomic). Returns { ok, written, created, repinned, problems }.
 */
export function writeRecords(rootDir, { exemptions = EXEMPTIONS } = {}) {
  const problems = [];
  const targets = [];
  for (const pkgDir of packagesUnder(rootDir)) {
    if (exemptions.has(pkgDir.slice(rootDir.length + 1))) continue;
    const missing = ["README.md", "README.zh.md"].filter((f) => !existsSync(join(pkgDir, f)));
    if (missing.length) {
      for (const f of missing) problems.push(`${pkgDir}: missing ${f}`);
      continue;
    }
    targets.push(pkgDir);
  }
  if (problems.length) return { ok: false, problems, written: 0, created: 0, repinned: 0 };

  let created = 0;
  let repinned = 0;
  for (const pkgDir of targets) {
    const recordPath = join(pkgDir, "README.i18n.yaml");
    if (existsSync(recordPath)) repinned++;
    else created++;
    const en = gitHash(rootDir, join(pkgDir, "README.md"));
    const zh = gitHash(rootDir, join(pkgDir, "README.zh.md"));
    writeFileSync(
      recordPath,
      `${RECORD_HEADER}README.md: ${en}\nREADME.zh.md: ${zh}\n`,
    );
  }
  return { ok: true, problems: [], written: targets.length, created, repinned };
}

const isDirectRun = process.argv[1] && process.argv[1].endsWith("check-readme.mjs");
if (isDirectRun) {
  const root = dirname(dirname(fileURLToPath(import.meta.url))); // parent of scripts/
  if (process.argv[2] === "--write") {
    const res = writeRecords(root);
    if (!res.ok) {
      console.error("check:readme --write — cannot re-record, incomplete pairs found:\n");
      for (const p of res.problems) console.error(`  ${p}`);
      process.exit(1);
    }
    console.log(
      `wrote ${res.written} README.i18n.yaml records (${res.created} new, ${res.repinned} re-pinned)`,
    );
  } else {
    const problems = collectProblems(root);
    if (problems.length) {
      console.error("check:readme — bilingual README trio problems found:\n");
      for (const { problem } of problems) console.error(`  ${problem}`);
      console.error(
        `\nFix: update README.md and README.zh.md together, then re-record the pair hashes:\n` +
          `  pnpm check:readme --write`,
      );
      process.exit(1);
    }
    const exempted = [...EXEMPTIONS.keys()].filter((k) => existsSync(join(root, k))).length;
    let trioCount = 0;
    for (const pkgDir of packagesUnder(root)) {
      if (!EXEMPTIONS.has(pkgDir.slice(root.length + 1))) trioCount++;
    }
    console.log(`check:readme OK — ${trioCount} packages with complete trios, ${exempted} exempted`);
  }
}
