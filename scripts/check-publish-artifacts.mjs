#!/usr/bin/env node
/**
 * check-publish-artifacts.mjs — presubmit gate verifying that every packed
 * artifact can actually resolve its own imports (issue #249 class: a source
 * file importing `../data/x.json` outside `src/` compiles fine but the
 * published tarball is missing the file → runtime ERR_MODULE_NOT_FOUND for
 * every consumer).
 *
 * For every publishable package (packages/<group>/<pkg>, no "private": true):
 *   1. `npm pack --json` (ONE batched invocation for all packages, real
 *      tarballs — no dry run) and untar each tarball into its own tmp dir.
 *   2. For every packed .js/.mjs/.cjs file: strip `//` and `/* * /` comments,
 *      extract static relative specifiers (`./` / `../`) from import /
 *      import() / export-from / require / require.resolve, and resolve each
 *      inside the unpacked tree with Node extension semantics (exact,
 *      .js/.cjs/.mjs/.json/.node, index.* , directory with package.json main).
 *   3. Verify every manifest `bin` entry path exists in the packed file list.
 *
 * Not checked (accepted limitations): computed dynamic imports, and
 * subpath-exports targets (e.g. retry-attendant's "./src/*") pointing at
 * never-packed files.
 *
 * Exit 0 when clean (one-line summary); print every violation and
 * process.exitCode = 1 otherwise. No external dependencies.
 *
 * npm note: `npm_config_cache` is pointed at a tmpdir because the local
 * `~/.npm` cache may not be writable (root-owned on some machines).
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

/* ---- pure core: import-specifier extraction ---- */

/** Strip `//` line comments and `/* ... *​/` block comments (build outputs —
 * simple regex strip is fine; string literals may lose `//` inside URLs, but
 * such lines still yield no false relative specifiers). */
export function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const SPEC_PATTERNS = [
  /\bimport\s+[^'"]*?from\s*['"]([^'"]+)['"]/g,
  /\bimport\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\bexport\s+[^'"]*?from\s*['"]([^'"]+)['"]/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\.resolve\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

/** All static relative (`./`/`../`) import specifiers in `source`, deduped. */
export function collectRelativeImports(source) {
  const stripped = stripComments(source);
  const found = new Set();
  for (const re of SPEC_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(stripped)) !== null) {
      const spec = m[1];
      if (spec.startsWith("./") || spec.startsWith("../")) found.add(spec);
    }
  }
  return [...found];
}

/* ---- pure core: specifier resolution ---- */

const CANDIDATE_SUFFIXES = [
  "",
  ".js",
  ".cjs",
  ".mjs",
  ".json",
  ".node",
  "/index.js",
  "/index.cjs",
  "/index.mjs",
  "/index.json",
];

/** Resolve `spec` relative to `fromFile` inside `rootDir`. Absolute path of
 * the resolved file, or null when unresolvable. */
export function resolveSpecifier(rootDir, fromFile, spec) {
  const base = resolve(dirname(fromFile), spec);
  if (!base.startsWith(resolve(rootDir))) return null;
  for (const suffix of CANDIDATE_SUFFIXES) {
    const candidate = base + suffix;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  // directory with package.json "main"
  const pkg = join(base, "package.json");
  if (existsSync(pkg) && statSync(pkg).isFile()) {
    try {
      const main = JSON.parse(readFileSync(pkg, "utf8")).main;
      if (typeof main === "string") {
        const target = resolve(base, main);
        if (existsSync(target) && statSync(target).isFile()) return target;
        for (const ext of [".js", ".cjs", ".mjs", ".json"]) {
          if (existsSync(target + ext)) return target + ext;
        }
      }
    } catch {
      /* malformed package.json → fall through to unresolvable */
    }
  }
  return null;
}

/* ---- package discovery ---- */

function* eachPkgDir(root) {
  const packagesDir = join(root, "packages");
  for (const group of readdirSync(packagesDir)) {
    const groupDir = join(packagesDir, group);
    if (!statSync(groupDir).isDirectory()) continue;
    for (const pkgName of readdirSync(groupDir)) {
      const pkgDir = join(groupDir, pkgName);
      const manifest = join(pkgDir, "package.json");
      if (!existsSync(manifest)) continue;
      if (JSON.parse(readFileSync(manifest, "utf8")).private === true) continue;
      yield pkgDir;
    }
  }
}

function walkJsFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walkJsFiles(p, out);
    else if (/\.(js|mjs|cjs)$/.test(entry)) out.push(p);
  }
  return out;
}

/* ---- main ---- */

export async function main(root = ROOT) {
  const pkgDirs = [...eachPkgDir(root)];
  if (pkgDirs.length === 0) {
    console.log("check-publish-artifacts: ok (0 packages, 0 files checked)");
    return 0;
  }

  const tmpBase = join(tmpdir(), `check-publish-artifacts-${process.pid}`);
  rmSync(tmpBase, { recursive: true, force: true });
  mkdirSync(join(tmpBase, "pack"), { recursive: true });

  // ONE batched pack for all publishable packages (npm accepts multiple dirs).
  const res = spawnSync(
    "npm",
    ["pack", "--json", `--pack-destination=${join(tmpBase, "pack")}`, ...pkgDirs],
    {
      encoding: "utf-8",
      cwd: root,
      env: { ...process.env, npm_config_cache: join(tmpBase, "npm-cache") },
    },
  );
  if (res.status !== 0) {
    console.error(`check-publish-artifacts: npm pack failed (exit ${res.status})`);
    if (res.stderr) console.error(res.stderr);
    rmSync(tmpBase, { recursive: true, force: true });
    return 1;
  }
  let packed;
  try {
    packed = JSON.parse(res.stdout);
  } catch {
    console.error("check-publish-artifacts: npm pack --json produced unparseable output");
    if (res.stdout) console.error(res.stdout.slice(0, 2000));
    rmSync(tmpBase, { recursive: true, force: true });
    return 1;
  }
  if (!Array.isArray(packed) || packed.length !== pkgDirs.length) {
    console.error(
      `check-publish-artifacts: npm pack returned ${Array.isArray(packed) ? packed.length : "non-array"} ` +
        `entries for ${pkgDirs.length} packages — falling back is required`,
    );
    rmSync(tmpBase, { recursive: true, force: true });
    return 1;
  }

  const failures = [];
  let filesChecked = 0;

  // Align pack results to source dirs by package NAME — npm does not
  // document that the JSON output preserves input order.
  const dirByName = new Map(
    pkgDirs.map((d) => {
      const m = JSON.parse(readFileSync(join(d, "package.json"), "utf8"));
      return [m.name ?? d, { dir: d, manifest: m }];
    }),
  );

  for (const entry of packed) {
    const matched = dirByName.get(entry.name);
    if (!matched) {
      failures.push(`${entry.name ?? entry.id ?? "?"}: unexpected npm pack entry (no matching source dir)`);
      continue;
    }
    const { dir: pkgDir, manifest } = matched;
    const pkgName = manifest.name ?? pkgDir;
    const unpackDir = join(tmpBase, `unpacked-${entry.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`);
    mkdirSync(unpackDir, { recursive: true });
    const tarball = join(tmpBase, "pack", entry.filename);
    const untar = spawnSync("tar", ["-xzf", tarball, "-C", unpackDir], {
      encoding: "utf-8",
    });
    if (untar.status !== 0) {
      failures.push(`${pkgName}: untar failed — ${untar.stderr || "unknown error"}`);
      continue;
    }

    const packedFiles = new Set(
      (entry.files ?? []).map((f) => normalize(f.path).replace(/^package\//, "")),
    );

    // bin entries must exist in the packed file list
    const bins =
      typeof manifest.bin === "string"
        ? { [manifest.name]: manifest.bin }
        : manifest.bin ?? {};
    for (const [binName, binPath] of Object.entries(bins)) {
      const rel = normalize(binPath).replace(/^\.?\//, "");
      if (!packedFiles.has(rel)) {
        failures.push(
          `${pkgName}: bin '${binName}' points at '${binPath}' — not in published files`,
        );
      }
    }

    for (const jsFile of walkJsFiles(unpackDir)) {
      filesChecked++;
      const source = readFileSync(jsFile, "utf8");
      for (const spec of collectRelativeImports(source)) {
        if (resolveSpecifier(unpackDir, jsFile, spec) === null) {
          const rel = jsFile.slice(unpackDir.length + 1).replace(/^package\//, "");
          failures.push(`${pkgName}: ${rel} imports '${spec}' — not in published files`);
        }
      }
    }
  }

  rmSync(tmpBase, { recursive: true, force: true });

  if (failures.length) {
    console.error("check-publish-artifacts — artifact violations found:\n");
    for (const f of failures) console.error(`  ${f}`);
    return 1;
  }
  console.log(
    `check-publish-artifacts: ok (${pkgDirs.length} packages, ${filesChecked} files checked)`,
  );
  return 0;
}

/* c8 ignore below: CLI entry */
const isDirectRun =
  process.argv[1] && process.argv[1].endsWith("check-publish-artifacts.mjs");
if (isDirectRun) {
  process.exit(await main(process.argv[2] ?? ROOT));
}
