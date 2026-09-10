#!/usr/bin/env node
/**
 * generate-parity-matrix.mjs — renders docs/cc-parity-matrix.md (whole file)
 * and the marked README block from docs/claude-code-capabilities.yaml.
 * Spec: docs/plans/2026-09-03-claude-code-capability-manifest.md §5.1, §4.6.
 *
 *   node scripts/generate-parity-matrix.mjs            # write (default)
 *   node scripts/generate-parity-matrix.mjs --check    # compare, exit 1 if stale
 *
 * Output is byte-stable for identical manifest input (no wall-clock dates).
 * Exit 0/1 only. Paths resolve against --root (default: the repo root, i.e.
 * the parent of this script's directory) so paired tests can use fixture trees.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, dirname, join, resolve } from "node:path";
import { loadManifest, validateManifest, normalizeDimension } from "./lib/capability-manifest.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HEADER =
  "<!-- GENERATED from docs/claude-code-capabilities.yaml — do not edit; run pnpm docs:parity -->";
const MATRIX_START = "<!-- parity:matrix:start -->";
const MATRIX_END = "<!-- parity:matrix:end -->";
const BEHAVIOR_LABEL = { full: "Full", partial: "Partial", divergent: "Divergent", missing: "Missing" };
const UX_LABEL = { full: "Full", partial: "Partial", missing: "Missing" };
const TYPE_INITIAL = { test: "t", source: "s", script: "c", doc: "d" };

function esc(text) {
  return String(text ?? "").replace(/\|/g, "\\|").replace(/\n+/g, " ").trim();
}

/** §4.6 roll-up mapping — evaluated top to bottom. */
export function rollupSymbol(cap) {
  const d = cap.dimensions ?? {};
  const dev = cap.deviation ?? {};
  const kind = dev.kind ?? "none";
  const dims = {
    recognized: normalizeDimension(d.recognized).status,
    mounted: normalizeDimension(d.mounted).status,
    behavioral: normalizeDimension(d.behavioral).status,
    ux: normalizeDimension(d.ux).status,
  };
  if (kind === "non-goal") return "🚫";
  const allNonPositive =
    dims.recognized !== true &&
    dims.mounted !== true &&
    !["full", "partial", "divergent"].includes(dims.behavioral) &&
    !["full", "partial"].includes(dims.ux);
  if (allNonPositive) return "❌";
  if (dims.behavioral === "full" && dims.mounted === true && dims.ux === "full" && kind === "none")
    return "✅";
  return "🔶";
}

function evidenceCell(cap) {
  const list = Array.isArray(cap.evidence) ? cap.evidence : [];
  const counters = { test: 0, source: 0, script: 0, doc: 0 };
  const parts = [];
  for (const ev of list) {
    if (!ev || !TYPE_INITIAL[ev.type] || typeof ev.path !== "string") continue;
    counters[ev.type] += 1;
    parts.push(`[${TYPE_INITIAL[ev.type]}${counters[ev.type]}](${ev.path})`);
  }
  return parts.length ? parts.join(" ") : "—";
}

function notesCell(cap) {
  const d = cap.dimensions ?? {};
  const parts = [];
  for (const dim of ["recognized", "mounted", "behavioral", "ux"]) {
    const notes = normalizeDimension(d[dim]).notes;
    if (notes) parts.push(`${dim}: ${esc(notes)}`);
  }
  return parts.length ? parts.join("; ") : "—";
}

function deviationCell(cap) {
  const dev = cap.deviation ?? {};
  const kind = dev.kind ?? "none";
  if (kind === "none") return "—";
  return dev.summary ? `${kind} — ${esc(dev.summary)}` : kind;
}

function isLive(cap) {
  return cap?.deprecated !== true;
}

function renderCapabilityRow(cap, id) {
  const d = cap.dimensions ?? {};
  const dim = (v) => normalizeDimension(v).status;
  const cells = [
    rollupSymbol(cap),
    `<a id="cap-${id}"></a>${esc(cap.title ?? id)}`,
    dim(d.recognized) === true ? "✓" : "—",
    dim(d.mounted) === true ? "✓" : "—",
    BEHAVIOR_LABEL[dim(d.behavioral)] ?? "—",
    UX_LABEL[dim(d.ux)] ?? "—",
    evidenceCell(cap),
    deviationCell(cap),
    notesCell(cap),
  ];
  return `| ${cells.join(" | ")} |`;
}

function newestRetrieval(manifest) {
  let newest = null;
  for (const cap of Object.values(manifest.capabilities ?? {})) {
    for (const ref of cap?.upstream?.refs ?? []) {
      const t = Date.parse(ref?.retrieved);
      if (!Number.isNaN(t) && (newest === null || t > newest)) newest = t;
    }
  }
  return newest === null ? null : new Date(newest).toISOString().slice(0, 10);
}

export function renderMatrix(manifest) {
  const out = [];
  out.push(HEADER, "", "# Claude Code parity matrix", "");
  out.push(
    "Generated from the machine-readable capability manifest. One symbol per capability,",
    "derived from four orthogonal dimensions (`recognized` / `mounted` / `behavioral` / `ux`):",
    "",
    "- ✅ full parity: behavior matches upstream, mounted by default, complete UX",
    "- 🔶 partial: usable with known differences (see Deviation/Notes)",
    "- ❌ missing: absent today",
    "- 🚫 not a parity port — may exist as a dsh-native equivalent (see Deviations)",
    "",
  );
  const categories = manifest.categories ?? [];
  const byCategory = new Map(categories.map((c) => [c.id, []]));
  for (const [id, cap] of Object.entries(manifest.capabilities ?? {})) {
    if (!isLive(cap)) continue; // §4.5: stubs excluded from tables/rollups
    (byCategory.get(cap.category) ?? byCategory.get(undefined)).push([id, cap]);
  }
  for (const cat of categories) {
    out.push(`## ${cat.title}`, "");
    out.push("| Status | Capability | Recognized | Mounted | Behavior | UX | Evidence | Deviation | Notes |");
    out.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    const rows = byCategory.get(cat.id) ?? [];
    if (rows.length === 0) out.push("_(no capabilities)_");
    for (const [id, cap] of rows) out.push(renderCapabilityRow(cap, id));
    out.push("");
  }

  // Deviations and known limits
  out.push("## Deviations and known limits", "");
  let any = false;
  for (const [id, cap] of Object.entries(manifest.capabilities ?? {})) {
    if (!isLive(cap)) continue;
    const dev = cap.deviation ?? {};
    const kind = dev.kind ?? "none";
    if (kind === "none") continue;
    any = true;
    const dep = kind === "upstream-blocked" && dev.upstream_dependency
      ? ` (upstream_dependency: ${dev.upstream_dependency})`
      : "";
    out.push(`- <a id="dev-${id}"></a>\`${id}\` — ${kind}${dep}: ${esc(dev.summary ?? "")}`);
  }
  if (!any) out.push("_None — every capability is at full parity or listed above._");
  out.push("");

  // Upstream dependencies registry
  out.push("## Upstream dependencies", "");
  const deps = manifest.upstream_dependencies ?? {};
  const depIds = Object.keys(deps);
  if (depIds.length === 0) out.push("_No registered upstream dependencies._");
  for (const depId of depIds) {
    const dep = deps[depId] ?? {};
    out.push(`### ${depId} — ${esc(dep.title ?? depId)}`, "");
    if (dep.problem) out.push(`**Problem:** ${esc(dep.problem)}`, "");
    if (dep.cc_contract) out.push(`**Claude Code contract:** ${esc(dep.cc_contract)}`, "");
    const refs = Array.isArray(dep.refs) ? dep.refs : [];
    if (refs.length) {
      out.push("**Refs:**");
      for (const ref of refs) out.push(`- ${ref}`);
      out.push("");
    }
  }

  // Renamed capabilities (§4.5)
  out.push("## Renamed capabilities", "");
  const stubs = Object.entries(manifest.capabilities ?? {}).filter(([, c]) => !isLive(c));
  if (stubs.length === 0) {
    out.push("_None._");
  } else {
    out.push("| Old id | Replaced by |");
    out.push("| --- | --- |");
    for (const [id, cap] of stubs) out.push(`| \`${id}\` | \`${cap.replaced_by ?? "—"}\` |`);
  }
  out.push("");

  // Footer: baseline provenance
  const sources = manifest.baseline?.sources ?? [];
  const newest = newestRetrieval(manifest);
  const threshold = manifest.baseline?.freshness_threshold_days;
  out.push("---", "");
  out.push(
    `Baseline sources: ${sources.map((s) => `${s?.id} (${s?.url ?? s?.ref ?? ""})`).join(", ")}.`,
  );
  if (newest) out.push(`Newest upstream retrieval: ${newest}.`);
  if (typeof threshold === "number")
    out.push(`Freshness threshold: ${threshold} days — re-verify refs older than that before trusting a row.`);
  out.push("");
  return out.join("\n");
}

function categoryRollupRow(manifest, cat) {
  const counts = { "✅": 0, "🔶": 0, "❌": 0, "🚫": 0 };
  for (const cap of Object.values(manifest.capabilities ?? {})) {
    if (!isLive(cap) || cap.category !== cat.id) continue;
    counts[rollupSymbol(cap)] += 1;
  }
  return `| ${cat.title} | ${counts["✅"]} | ${counts["🔶"]} | ${counts["❌"]} | ${counts["🚫"]} |`;
}

export function renderReadmeBlock(manifest, { readmeDir = "." } = {}) {
  const out = [];
  const categories = manifest.categories ?? [];
  out.push(
    "| Category | Full | Partial | Missing | Non-goal |",
    "| --- | --- | --- | --- | --- |",
  );
  for (const cat of categories) out.push(categoryRollupRow(manifest, cat));
  // Deliberately NO "Known deviations" list here: the README block stays
  // lean (rollup table + freshness + link); per-cap deviation detail lives
  // only in docs/cc-parity-matrix.md, which the link below points at.
  // Hand-deleting this section from README.md instead was rejected by
  // --check (generated-block drift, the #108 incident).
  const newest = newestRetrieval(manifest);
  const threshold = manifest.baseline?.freshness_threshold_days;
  if (newest)
    out.push(
      // Blank line above: without it, renderers absorb this sentence into
      // the table as a trailing row (GFM tables swallow adjacent paragraphs).
      "",
      `Statuses were verified against upstream documentation retrieved as of ${newest}` +
        (typeof threshold === "number" ? ` (freshness threshold: ${threshold} days).` : "."),
    );
  const matrixRel = readmeDir === "." ? "docs/cc-parity-matrix.md" : "docs/cc-parity-matrix.md";
  out.push(
    "",
    `For the exact feature-by-feature status and known gaps, see the **[Claude Code parity matrix](${matrixRel})**.`,
    "",
  );
  return out.join("\n");
}

export function replaceReadmeBlock(readmeText, block) {
  const s = readmeText.indexOf(MATRIX_START);
  const e = readmeText.indexOf(MATRIX_END);
  if (s === -1 || e === -1 || e < s) {
    const err = new Error(
      `README.md is missing the parity block markers — insert "${MATRIX_START}" and "${MATRIX_END}" ` +
        `around the generated region (inside "## What you get") and re-run.`,
    );
    err.code = "README_MARKERS_MISSING";
    throw err;
  }
  const start = s + MATRIX_START.length;
  return readmeText.slice(0, start) + "\n" + block + readmeText.slice(e);
}

/**
 * Unit B (§9 O1, decided in Phase 2): normalized manifest JSON for
 * programmatic consumers. Dimensions go through the lib's normalizer so they
 * are always in object form; everything else is the parsed manifest as-is.
 * Rendered with JSON.stringify(obj, null, 2) + a trailing newline — key order
 * follows loadManifest's parse order, hence byte-stable for identical input.
 */
export function renderManifestJson(manifest) {
  const normalized = JSON.parse(JSON.stringify(manifest));
  for (const cap of Object.values(normalized.capabilities ?? {})) {
    cap.dimensions = {
      recognized: normalizeDimension(cap.dimensions?.recognized),
      mounted: normalizeDimension(cap.dimensions?.mounted),
      behavioral: normalizeDimension(cap.dimensions?.behavioral),
      ux: normalizeDimension(cap.dimensions?.ux),
    };
  }
  return JSON.stringify(normalized, null, 2) + "\n";
}

/** JSON lands next to the manifest (docs/claude-code-capabilities.json by default). */
function jsonRelFor(manifestRel) {
  return join(dirname(manifestRel), basename(manifestRel).replace(/\.ya?ml$/, ".json"));
}

function parseArgs(argv) {
  const args = { check: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--check") args.check = true;
    else if (a === "--root") args.root = argv[++i];
    else if (a === "--manifest") args.manifest = argv[++i];
    else if (a === "--readme") args.readme = argv[++i];
    else if (a === "--matrix") args.matrix = argv[++i];
    else {
      console.error(`unknown argument: ${a}`);
      process.exit(1);
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = resolve(args.root ?? join(__dirname, ".."));
  const manifestRel = args.manifest ?? "docs/claude-code-capabilities.yaml";
  const readmeRel = args.readme ?? "README.md";
  const matrixRel = args.matrix ?? "docs/cc-parity-matrix.md";
  const jsonRel = jsonRelFor(manifestRel);

  let manifest;
  try {
    manifest = loadManifest(root, manifestRel);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  const diags = validateManifest(manifest, root).filter((d) => d.level === "error");
  if (diags.length) {
    console.error(`manifest has ${diags.length} validation error(s) — fix docs/claude-code-capabilities.yaml first:`);
    for (const d of diags) console.error(`  [${d.rule}] ${d.capability ?? "(manifest)"}: ${d.message}`);
    process.exit(1);
  }

  const matrixOut = renderMatrix(manifest);
  const readmeText = readFileSync(join(root, readmeRel), "utf8");
  let readmeOut;
  try {
    readmeOut = replaceReadmeBlock(readmeText, renderReadmeBlock(manifest, { readmeDir: dirname(readmeRel) }));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }

  const jsonOut = renderManifestJson(manifest);

  if (args.check) {
    const stale = [];
    if (readFileSync(join(root, matrixRel), "utf8") !== matrixOut) stale.push(matrixRel);
    if (readmeText !== readmeOut) stale.push(readmeRel);
    if (!existsSync(join(root, jsonRel)) || readFileSync(join(root, jsonRel), "utf8") !== jsonOut)
      stale.push(jsonRel);
    if (stale.length) {
      console.error(`stale generated output in: ${stale.join(", ")}`);
      console.error("run pnpm docs:parity");
      process.exit(1);
    }
    console.log("parity docs up to date.");
    process.exit(0);
  }

  writeFileSync(join(root, matrixRel), matrixOut);
  writeFileSync(join(root, readmeRel), readmeOut);
  writeFileSync(join(root, jsonRel), jsonOut);
  console.log(`wrote ${matrixRel}, the marked block in ${readmeRel}, and ${jsonRel}.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
