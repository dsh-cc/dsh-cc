/**
 * capability-manifest.mjs — loader + validator for
 * docs/claude-code-capabilities.yaml, shared by
 * scripts/check-capability-evidence.mjs and scripts/generate-parity-matrix.mjs
 * (spec: docs/plans/2026-09-03-claude-code-capability-manifest.md §4, §5.2).
 *
 * Responsibilities:
 *   - YAML load (js-yaml) with a fail-loud error when the module is missing;
 *   - scalar→object dimension normalization (§4.1);
 *   - schema-shape validation and consistency invariants I1–I11 (§4.4),
 *     evidence path existence (§4.2), anchor enforcement (mandatory for
 *     citations of packages/preset/cc/agent.cordis.yml; rejected on URLs),
 *     id ordering/uniqueness (I7) and freshness warnings (I8).
 *
 * All path checks resolve against an injected rootDir so paired tests can
 * run against fixture trees. Diagnostics are structured:
 *   { level: "error" | "warning", rule: "I4" | "schema" | ..., capability, message }
 * Severity follows §4.4: I8 is warning; everything else error.
 * Exit codes are the CLI's job; this module never calls process.exit.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, isAbsolute } from "node:path";
import { createRequire } from "node:module";

const PRESET_YML = "packages/preset/cc/agent.cordis.yml";
const INCLUDE_PLUGIN_NAME = "@deepseek-ai/cordis-plugin-include";

/**
 * Text the I10 literal-anchor check reads for an evidence path. For
 * PRESET_YML — a thin include wrapper since the VWA split
 * (docs/plans/2026-10-12-verifiable-workspace-agent.md §3.2c) — this is the
 * include-closure expansion: include rows' `config.path` resolved relative to
 * the INCLUDING file, nested includes recursively, cycle-guarded; only
 * explicitly referenced files, no wildcards. A referenced file that is
 * missing or unparseable degrades to being skipped, so the check behaves
 * exactly as before the split for anything it can read.
 */
export function presetEvidenceText(rootDir, relPath) {
  const yaml = loadYaml();
  // The preset yml carries `!!js` expressions that must NOT evaluate here;
  // stub the tag so parsing stays side-effect-free.
  const jsStub = new yaml.Type("tag:yaml.org,2002:js", {
    kind: "scalar",
    resolve: () => true,
    construct: () => "",
  });
  const schema = yaml.DEFAULT_SCHEMA.extend([jsStub]);

  const collectIncludePaths = (node, out) => {
    if (Array.isArray(node)) {
      for (const child of node) collectIncludePaths(child, out);
    } else if (node && typeof node === "object") {
      if (node.name === INCLUDE_PLUGIN_NAME && typeof node.config?.path === "string")
        out.push(node.config.path);
      for (const value of Object.values(node)) collectIncludePaths(value, out);
    }
  };

  const parts = [];
  const seen = new Set();
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      return;
    }
    parts.push(text);
    let doc;
    try {
      doc = yaml.load(text, { schema });
    } catch {
      return;
    }
    const includePaths = [];
    collectIncludePaths(doc, includePaths);
    for (const p of includePaths) walk(join(dirname(file), p));
  };
  walk(join(rootDir, relPath));
  return parts.join("\n");
}
const BEHAVIORAL = new Set(["full", "partial", "divergent", "missing"]);
const UX = new Set(["full", "partial", "missing"]);
const DEVIATIONS = new Set(["none", "downgrade", "divergent", "upstream-blocked", "non-goal"]);
const PLANES = new Set(["host", "preset", "mixed"]);
const EVIDENCE_TYPES = new Set(["test", "source", "script", "doc"]);
const ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*\.[a-z0-9]+(-[a-z0-9]+)*$/;

function loadYaml() {
  try {
    return createRequire(import.meta.url)("js-yaml");
  } catch {
    throw new Error("js-yaml module missing — run pnpm install");
  }
}

/** Load + parse the manifest YAML at <rootDir>/<relPath>. Throws on unreadable/invalid. */
export function loadManifest(rootDir, relPath) {
  const yaml = loadYaml();
  const abs = isAbsolute(relPath) ? relPath : join(rootDir, relPath);
  if (!existsSync(abs)) {
    const err = new Error(`manifest not found: ${abs} — expected docs/claude-code-capabilities.yaml at the repo root (see docs/plans/2026-09-03-claude-code-capability-manifest.md §4)`);
    err.code = "MANIFEST_NOT_FOUND";
    throw err;
  }
  try {
    return yaml.load(readFileSync(abs, "utf8"));
  } catch (e) {
    const err = new Error(`manifest is not valid YAML (${abs}): ${e.message}`);
    err.code = "MANIFEST_INVALID_YAML";
    throw err;
  }
}

/** §4.1: scalar shorthand → {status, notes}; object form passes through. */
export function normalizeDimension(value) {
  if (value === null || typeof value !== "object") return { status: value, notes: undefined };
  return { status: value.status, notes: value.notes };
}

function diag(list, level, rule, capability, message) {
  list.push({ level, rule, capability, message });
}

const positiveBehavioral = (s) => s === "full" || s === "partial" || s === "divergent";
const positiveUx = (s) => s === "full" || s === "partial";

function checkSchemaShape(manifest, diags) {
  const push = (msg) => diag(diags, "error", "schema", undefined, msg);
  if (!manifest || typeof manifest !== "object") return push("manifest must be a mapping");
  if (manifest.manifest_version !== 1) push("manifest_version must be 1");
  const b = manifest.baseline;
  if (!b || typeof b !== "object") push("baseline is required (§3)");
  else if (!Array.isArray(b.sources)) push("baseline.sources must be a list");
  else if (b.sources.some((s) => !s || typeof s.id !== "string" || !s.id))
    push("every baseline.sources[] entry needs a non-empty id");
  if (!Array.isArray(manifest.categories) || manifest.categories.length === 0)
    push("categories must be a non-empty ordered list");
  else if (manifest.categories.some((c) => !c || typeof c.id !== "string" || !c.id))
    push("every category needs a non-empty id");
  if (manifest.capabilities === null || typeof manifest.capabilities !== "object" ||
      Array.isArray(manifest.capabilities) || Object.keys(manifest.capabilities ?? {}).length === 0)
    push("capabilities must be a non-empty mapping of id → capability");
  if (manifest.upstream_dependencies !== undefined &&
      (manifest.upstream_dependencies === null || typeof manifest.upstream_dependencies !== "object" ||
       Array.isArray(manifest.upstream_dependencies)))
    push("upstream_dependencies must be a mapping of id → entry");
  return typeof manifest.capabilities === "object" && manifest.capabilities !== null &&
    !Array.isArray(manifest.capabilities)
    ? manifest.capabilities
    : {};
}

function checkEvidence(manifest, id, cap, dims, diags, rootDir) {
  const list = Array.isArray(cap.evidence) ? cap.evidence : null;
  if (list === null) {
    diag(diags, "error", "schema", id, "evidence must be a list (use [] for none)");
    return;
  }
  for (const [i, ev] of list.entries()) {
    const at = `evidence[${i}]`;
    if (!ev || typeof ev !== "object") {
      diag(diags, "error", "schema", id, `${at}: must be a mapping`);
      continue;
    }
    if (!EVIDENCE_TYPES.has(ev.type)) {
      diag(diags, "error", "schema", id, `${at}: type must be one of test|source|script|doc`);
      continue;
    }
    if (typeof ev.path !== "string" || !ev.path) {
      diag(diags, "error", "schema", id, `${at}: path is required`);
      continue;
    }
    const isUrl = ev.path.startsWith("https://");
    if (isUrl && ev.type !== "doc") {
      diag(diags, "error", "schema", id, `${at}: https:// URLs are only allowed for type: doc`);
    }
    if (ev.anchor !== undefined && isUrl) {
      diag(diags, "error", "schema", id, `${at}: anchor is not allowed on URL evidence (§4.2)`);
      continue;
    }
    if (ev.anchor !== undefined && typeof ev.anchor !== "string") {
      diag(diags, "error", "schema", id, `${at}: anchor must be a string`);
      continue;
    }
    if (isUrl) continue; // never fetched in CI
    const abs = join(rootDir, ev.path);
    if (!existsSync(abs)) {
      diag(diags, "error", "evidence", id, `${at}: cited file does not exist: ${ev.path}`);
      continue;
    }
    if (ev.anchor !== undefined) {
      // I10: literal substring occurrence in the cited repo file.
      let content = "";
      try {
        content = ev.path === PRESET_YML
          ? presetEvidenceText(rootDir, ev.path)
          : readFileSync(abs, "utf8");
      } catch {
        diag(diags, "error", "evidence", id, `${at}: cannot read ${ev.path}`);
        continue;
      }
      if (!content.includes(ev.anchor)) {
        diag(diags, "error", "I10", id, `${at}: anchor "${ev.anchor}" does not occur in ${ev.path}`);
      }
    }
    // §4.2: citations of the preset monolith must carry an anchor.
    if (ev.path === PRESET_YML && ev.anchor === undefined) {
      diag(diags, "error", "I4", id, `${at}: evidence citing ${PRESET_YML} requires an anchor (§4.2)`);
    }
  }
}

function checkInvariants(manifest, id, cap, dims, diags, rootDir) {
  const d = cap.dimensions ?? {};
  const dev = cap.deviation ?? {};
  const kind = dev?.kind ?? "none";
  const deps = manifest.upstream_dependencies ?? {};

  // I1/I2: mounted and behavioral imply recognized.
  if (dims.mounted.status === true && dims.recognized.status !== true)
    diag(diags, "error", "I1", id, "mounted: true requires recognized: true");
  if (positiveBehavioral(dims.behavioral.status) && dims.recognized.status !== true)
    diag(diags, "error", "I2", id, `behavioral: ${dims.behavioral.status} requires recognized: true`);
  // I3: ux strength bounded by behavioral.
  if (dims.ux.status === "full" && dims.behavioral.status !== "full")
    diag(diags, "error", "I3", id, "ux: full requires behavioral: full");
  if (dims.ux.status === "partial" && !positiveBehavioral(dims.behavioral.status))
    diag(diags, "error", "I3", id, "ux: partial requires behavioral ∈ {full, partial, divergent}");

  // I4: positive dimension ⇒ existing test/source/script evidence;
  // mounted ⇒ anchored evidence per plane.
  const anyPositive =
    dims.recognized.status === true ||
    dims.mounted.status === true ||
    positiveBehavioral(dims.behavioral.status) ||
    positiveUx(dims.ux.status);
  const evidence = Array.isArray(cap.evidence) ? cap.evidence : [];
  const existsOnDisk = (ev) =>
    typeof ev?.path === "string" && !ev.path.startsWith("https://") && existsSync(join(rootDir, ev.path));
  const anchored = (ev) => existsOnDisk(ev) && typeof ev.anchor === "string" && ev.anchor;
  const hasBody = evidence.some(
    (ev) => ["test", "source", "script"].includes(ev?.type) && existsOnDisk(ev),
  );
  if (anyPositive && !hasBody)
    diag(diags, "error", "I4", id, "a positive dimension requires ≥1 existing evidence of type test/source/script (§4.2)");
  if (dims.mounted.status === true) {
    const plane = PLANES.has(cap.plane) ? cap.plane : "preset";
    const inPreset = evidence.some((ev) => anchored(ev) && ev.path === PRESET_YML);
    const inHost = evidence.some((ev) => anchored(ev) && ev.path !== PRESET_YML);
    if ((plane === "preset" || plane === "mixed") && !inPreset)
      diag(diags, "error", "I4", id, `mounted: true with plane: ${plane} requires anchored evidence in ${PRESET_YML}`);
    if ((plane === "host" || plane === "mixed") && !inHost)
      diag(diags, "error", "I4", id, `mounted: true with plane: ${plane} requires anchored evidence in the owning host package`);
  }

  // I5: upstream-blocked resolves; registry needed_for back-references exist.
  if (kind === "upstream-blocked") {
    const dep = dev.upstream_dependency;
    if (typeof dep !== "string" || !deps[dep])
      diag(diags, "error", "I5", id, `deviation.kind: upstream-blocked requires upstream_dependency resolving in upstream_dependencies (got: ${JSON.stringify(dep)})`);
  }
  for (const [depId, entry] of Object.entries(deps)) {
    for (const capId of entry?.needed_for ?? []) {
      if (!(capId in manifest.capabilities))
        diag(diags, "error", "I5", id, `upstream_dependencies.${depId}.needed_for references unknown capability "${capId}"`);
    }
  }

  // I6: non-goal dimension rules.
  if (kind === "non-goal") {
    if (!["missing", "divergent"].includes(dims.behavioral.status) || dims.ux.status !== "missing")
      diag(diags, "error", "I6", id, "deviation.kind: non-goal requires behavioral ∈ {missing, divergent} and ux: missing");
    else if (dims.behavioral.status === "divergent" && !dev.summary)
      diag(diags, "error", "I6", id, "non-goal with behavioral: divergent must name the dsh-native equivalent in deviation.summary");
  }

  // I9: deprecated stubs must point at a live capability (§4.5).
  if (cap.deprecated === true) {
    const target = cap.replaced_by;
    const tcap = typeof target === "string" ? manifest.capabilities[target] : undefined;
    if (!tcap)
      diag(diags, "error", "I9", id, `deprecated: true requires replaced_by resolving to an existing capability id (got: ${JSON.stringify(target)})`);
    else if (tcap.deprecated === true)
      diag(diags, "error", "I9", id, `replaced_by points at another deprecated capability: ${target}`);
  }

  // I11: deviation.kind binds to dimensions.
  if (kind !== "none" && !dev.summary)
    diag(diags, "error", "I11", id, `deviation.kind: ${kind} requires a non-empty deviation.summary`);
  if (kind === "none" && !(dims.behavioral.status === "full" && dims.ux.status === "full"))
    diag(diags, "error", "I11", id, "deviation.kind: none requires behavioral: full and ux: full");
}

/**
 * Phase 2 freshness math, shared by I8 above and the freshness report CLI
 * (scripts/report-capability-freshness.mjs). One capability at a time:
 * `newest` is the newest *valid* ISO `retrieved` across upstream.refs (ms,
 * or null when there are no valid refs — empty-refs capabilities are the
 * Phase 2 backfill queue, §3), `ageDays` its floor against today, `stale`
 * true when ageDays exceeds baseline.freshness_threshold_days.
 */
export function capabilityFreshness(manifest, id, cap) {
  const refs = cap?.upstream?.refs ?? [];
  const thresholdDays = manifest.baseline?.freshness_threshold_days;
  let newest = null;
  for (const ref of refs) {
    const s = String(ref?.retrieved ?? "");
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      const t = Date.parse(ref.retrieved);
      if (!Number.isNaN(t) && (newest === null || t > newest)) newest = t;
    }
  }
  const ageDays = newest === null ? null : Math.floor((Date.now() - newest) / 86_400_000);
  return {
    id,
    refs,
    newest,
    ageDays,
    stale:
      newest !== null &&
      typeof thresholdDays === "number" &&
      (Date.now() - newest) / 86_400_000 > thresholdDays,
  };
}

function checkFreshness(manifest, id, cap, diags) {
  const f = capabilityFreshness(manifest, id, cap);
  const sources = new Set((manifest.baseline?.sources ?? []).map((s) => s?.id));
  for (const ref of f.refs) {
    if (!sources.has(ref?.source))
      diag(diags, "warning", "I8", id, `upstream.refs source "${ref?.source}" not present in baseline.sources`);
    const t = Date.parse(ref?.retrieved);
    if (Number.isNaN(t) || !/^\d{4}-\d{2}-\d{2}$/.test(String(ref?.retrieved ?? "")))
      diag(diags, "warning", "I8", id, `upstream.refs retrieved "${ref?.retrieved}" is not an ISO date`);
  }
  if (f.stale) {
    const thresholdDays = manifest.baseline?.freshness_threshold_days;
    diag(diags, "warning", "I8", id, `upstream refs are stale: newest retrieval ${new Date(f.newest).toISOString().slice(0, 10)} is ${f.ageDays} days old (threshold: ${thresholdDays}) — re-verify against upstream docs`);
  }
  // Empty refs are exempt from I8; the Phase 2 freshness report surfaces them
  // in its backfill queue instead (§3).
}

function checkPerCapability(manifest, id, cap, diags, rootDir) {
  const dims = {
    recognized: normalizeDimension(cap.dimensions?.recognized),
    mounted: normalizeDimension(cap.dimensions?.mounted),
    behavioral: normalizeDimension(cap.dimensions?.behavioral),
    ux: normalizeDimension(cap.dimensions?.ux),
  };
  if (typeof cap.category !== "string" || !cap.category)
    diag(diags, "error", "schema", id, "category is required");
  if (cap.plane !== undefined && !PLANES.has(cap.plane))
    diag(diags, "error", "schema", id, `plane must be one of host|preset|mixed (got: ${JSON.stringify(cap.plane)})`);
  if (!BEHAVIORAL.has(dims.behavioral.status))
    diag(diags, "error", "schema", id, `dimensions.behavioral must be one of full|partial|divergent|missing (got: ${JSON.stringify(dims.behavioral.status)})`);
  if (!UX.has(dims.ux.status))
    diag(diags, "error", "schema", id, `dimensions.ux must be one of full|partial|missing (got: ${JSON.stringify(dims.ux.status)})`);
  const rec = dims.recognized.status;
  const mnt = dims.mounted.status;
  if (rec !== undefined && typeof rec !== "boolean")
    diag(diags, "error", "schema", id, "dimensions.recognized must be a boolean");
  if (mnt !== undefined && typeof mnt !== "boolean")
    diag(diags, "error", "schema", id, "dimensions.mounted must be a boolean");
  const dev = cap.deviation ?? { kind: "none" };
  if (!DEVIATIONS.has(dev.kind ?? "none"))
    diag(diags, "error", "schema", id, `deviation.kind must be one of none|downgrade|divergent|upstream-blocked|non-goal (got: ${JSON.stringify(dev.kind)})`);

  checkEvidence(manifest, id, cap, dims, diags, rootDir);
  checkInvariants(manifest, id, cap, dims, diags, rootDir);
  checkFreshness(manifest, id, cap, diags);
}

function checkIdsAndOrdering(manifest, diags) {
  const catIndex = new Map((manifest.categories ?? []).map((c, i) => [c?.id, i]));
  const seen = new Set();
  let prev = null; // [catIdx, id] of previous capability, in manifest order
  for (const [id, cap] of Object.entries(manifest.capabilities ?? {})) {
    if (!ID_RE.test(id)) {
      diag(diags, "error", "I7", id, `capability id must be dotted kebab-case <category>.<slug> (got: "${id}")`);
    } else if (id.split(".")[0] !== cap?.category) {
      diag(diags, "error", "I7", id, `capability id prefix must equal its category (${cap?.category})`);
    }
    if (seen.has(id)) diag(diags, "error", "I7", id, `duplicate capability id: ${id}`);
    seen.add(id);
    const cur = [catIndex.get(cap?.category) ?? -1, id];
    if (prev && (cur[0] < prev[0] || (cur[0] === prev[0] && cur[1] < prev[1]))) {
      diag(diags, "error", "I7", id, `capabilities must be ordered by category order then id (misplaced after ${prev[1]})`);
    }
    prev = cur;
  }
}

/**
 * Validate a parsed manifest against §4. Returns a structured diagnostics
 * list; an empty list means the manifest is clean.
 */
export function validateManifest(manifest, rootDir) {
  const diags = [];
  const capabilities = checkSchemaShape(manifest, diags);
  for (const [id, cap] of Object.entries(capabilities)) {
    if (cap && typeof cap === "object" && !Array.isArray(cap))
      checkPerCapability(manifest, id, cap, diags, rootDir);
    else diag(diags, "error", "schema", id, "capability must be a mapping");
  }
  checkIdsAndOrdering(manifest, diags);
  return diags;
}

/**
 * Convenience for scripts: load <rootDir>/<relPath> and validate it.
 * Load/parse failures come back as a single error-level diagnostic.
 */
export function checkCapabilityManifest(rootDir, relPath = "docs/claude-code-capabilities.yaml") {
  let manifest;
  try {
    manifest = loadManifest(rootDir, relPath);
  } catch (e) {
    if (/js-yaml module missing/.test(e.message)) throw e;
    return [{ level: "error", rule: "manifest", capability: undefined, message: e.message }];
  }
  return validateManifest(manifest, rootDir);
}
