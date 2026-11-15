/**
 * Artifact binding (design docs/plans/2026-10-16-vwa-evidence-argument.md
 * §10.5 `bind-artifact`, and the render pipeline
 * docs/plans/2026-11-15-vwa-autonomous-render-pipeline.md §4.1–§4.3).
 *
 * `mode` is REQUIRED and selected before any text is read (§4.1):
 * - `inline` — the v1 behavior verbatim: the deliverable text is validated
 *   and nothing is written. Inline on a draft-backed artifact is rejected;
 *   converting an artifact is only ever explicit, through `draft`.
 * - `draft` — the bind transaction renders the draft itself (§4.2): the
 *   draft path and ownership are validated, occurrences are checked against
 *   the DRAFT text (and stay in draft coordinates, §4.4), the deliverable
 *   = `stripMarkers(draft)` is staged along with the §7.1 render intent, and
 *   the contentHash is over the rendered bytes.
 *
 * Split out of graph.ts for the repo file-size cap.
 *
 * @module @dsh-cc/vwa-argument/artifact
 */

import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { DRAFT_FILE_RE, vwaProjectIdOfDraft } from '@dsh-cc/vwa-evidence'
import { sha256Hex, spanError, stableJson } from './schema.ts'
import { VwaFail, fail, type StagedFile } from './store.ts'
import { canonicalTree, isWithin, LEGACY_REPORTS_ROOT, LEGACY_SOURCES_ROOT } from './paths.ts'
import { intersectsRemoved, stripMarkers } from './render.ts'
import { readRenderIntents, renderIntentFile } from './render-state.ts'
import type { GraphContext, Mutation } from './graph.ts'
import type { Artifact } from './types.ts'

/** Throw a uniform failure out of an apply function (no partial commit). */
function reject(code: import('./store.ts').Fail['code'], message: string): never {
  throw new VwaFail(fail(code, message))
}

/** Transaction context a `draft` bind needs beyond the graph (§4.2). */
export interface BindDeps {
  /** Session workspace root (draft/deliverable realpath checks, intent staging). */
  root?: string
  /** The transaction's request id — the render-intent file name (§7.1). */
  requestId?: string
  /** Staging sink: deliverable writes ride the same commit as the snapshot. */
  staged?: StagedFile[]
}

/** Create or update the bound Artifact after full validation (mode selected first, §4.1). */
export function applyBindArtifact(
  graph: GraphContext,
  mutation: Extract<Mutation, { op: 'bind-artifact' }>,
  deps: BindDeps = {},
): void {
  if (mutation.mode !== 'inline' && mutation.mode !== 'draft') {
    reject('SCHEMA_INVALID', 'bind-artifact requires mode: "draft" or "inline"')
  }
  if (mutation.mode === 'inline') bindInline(graph, mutation)
  else bindDraft(graph, mutation, deps)
}

function artifactIdChecks(mutation: Extract<Mutation, { op: 'bind-artifact' }>, existing: Artifact | undefined): void {
  if (mutation.artifactId !== undefined && existing === undefined) {
    reject('REFERENCE_INVALID', `unknown artifactId ${mutation.artifactId}`)
  }
  if (existing !== undefined && mutation.artifactId !== undefined && existing.id !== mutation.artifactId) {
    reject('REFERENCE_INVALID', `artifactId ${mutation.artifactId} does not match the bound artifact for this path`)
  }
}

/** mode 'inline' — the v1 §10.5 behavior verbatim (the deliverable as-is; nothing written). */
function bindInline(graph: GraphContext, mutation: Extract<Mutation, { op: 'bind-artifact' }>): void {
  validateArtifactPath(mutation.path)
  // §4.1: a draft-backed artifact converts only through mode 'draft' (never
  // implicitly). This is the one gate that precedes the v1 text read — it can
  // only fire for artifacts the v1 world never had (draft is a new field).
  if (graph.snapshot.artifacts.some((artifact) => artifact.path === mutation.path && artifact.draft !== undefined)) {
    reject('SCHEMA_INVALID', 'artifact is draft-backed; bind with mode:"draft"')
  }
  const text = graph.artifactText(mutation.path)
  const contentHash = sha256Hex(text)
  const now = graph.now()
  for (const occurrence of mutation.occurrences) {
    if (!graph.snapshot.claims.some((claim) => claim.id === occurrence.claimId)) {
      reject('REFERENCE_INVALID', `occurrence references unknown claim ${occurrence.claimId}`)
    }
    const problem = spanError(occurrence.span, text)
    if (problem !== '') reject('SCHEMA_INVALID', `occurrence span invalid: ${problem}`)
    if (text.slice(occurrence.span.start, occurrence.span.end) !== occurrence.exactText) {
      reject('SCHEMA_INVALID', 'occurrence exactText does not match the artifact slice')
    }
  }
  validateOutlineRefs(graph, mutation)
  const existing = graph.snapshot.artifacts.find((artifact) => artifact.path === mutation.path)
  artifactIdChecks(mutation, existing)
  if (existing !== undefined) {
    existing.contentHash = contentHash
    existing.occurrences = mutation.occurrences
    existing.outline = mutation.outline
    existing.entityVersion += 1
    existing.updatedAt = now
  } else {
    graph.snapshot.artifacts.push({
      id: `art_${randomUUID()}`, entityVersion: 1, createdAt: now, updatedAt: now,
      path: mutation.path, contentHash, occurrences: mutation.occurrences, outline: mutation.outline,
    })
  }
}

/**
 * mode 'draft' — the §4.2 bind-v2 algorithm: the deliverable is the render
 * of the current draft, compiled inside this transaction (steps 2–11; the
 * step-12 intent clear is the store's commit).
 */
function bindDraft(
  graph: GraphContext,
  mutation: Extract<Mutation, { op: 'bind-artifact' }>,
  deps: BindDeps,
): void {
  if (deps.root === undefined || deps.requestId === undefined || deps.staged === undefined) {
    reject('STORE_IO_FAILED', 'draft binding requires the transaction workspace context')
  }
  const root = deps.root
  const projectId = graph.snapshot.projectId
  const existing = graph.snapshot.artifacts.find((artifact) => artifact.path === mutation.path)
  artifactIdChecks(mutation, existing)
  // Step 2: draft-path shape, ownership, realpath containment; then the §3.1
  // unique-draft rule (the foundation of §5.5's one-route-per-draft).
  const draftPath = mutation.draftPath
  if (draftPath === undefined || !DRAFT_FILE_RE.test(draftPath) || vwaProjectIdOfDraft(draftPath) !== projectId) {
    reject('PATH_OUT_OF_BOUNDS', `draft path is not a draft file of this project: ${String(draftPath)}`)
  }
  for (const artifact of graph.snapshot.artifacts) {
    if (artifact.id !== existing?.id && artifact.draft?.path === draftPath) {
      reject('SCHEMA_INVALID', 'draft already bound to another artifact')
    }
  }
  let fileReal: string
  try {
    fileReal = realpathSync(resolve(root, ...draftPath.split('/')))
  } catch {
    reject('NOT_FOUND', 'draft text unavailable')
  }
  let draftsReal = ''
  try {
    draftsReal = realpathSync(join(root, '.dsh', 'vwa', projectId, 'drafts'))
  } catch {
    // The drafts dir cannot contain a realpath that does not exist.
  }
  // Safe only as a file directly inside the canonical drafts dir — a
  // symlink into (or out of) the drafts tree never classifies as a draft.
  if (draftsReal === '' || dirname(fileReal) !== draftsReal) {
    reject('PATH_OUT_OF_BOUNDS', `draft path escapes this project's draft directory: ${draftPath}`)
  }
  const absoluteDraft = fileReal
  let draftText: string | undefined = graph.artifactTexts.get(draftPath)
  if (draftText === undefined) {
    let bytes: Buffer
    try {
      bytes = readFileSync(absoluteDraft)
    } catch {
      reject('NOT_FOUND', 'draft text unavailable')
    }
    draftText = bytes.toString('utf8')
    if (bytes.includes(0) || !Buffer.from(draftText, 'utf8').equals(bytes)) {
      reject('INVALID_ENCODING', `draft is not lossless UTF-8: ${draftPath}`)
    }
  }
  // Step 3: every occurrence validates against the DRAFT text.
  validateOccurrenceRefs(graph, mutation)
  for (const occurrence of mutation.occurrences) {
    const problem = spanError(occurrence.span, draftText)
    if (problem !== '') reject('SCHEMA_INVALID', `occurrence span invalid: ${problem}`)
    if (draftText.slice(occurrence.span.start, occurrence.span.end) !== occurrence.exactText) {
      reject('SCHEMA_INVALID', 'occurrence exactText does not match the artifact slice')
    }
  }
  validateOutlineRefs(graph, mutation)
  // Step 4–5: render; an occurrence intersecting a removed marker range is rejected.
  const render = stripMarkers(draftText)
  for (const occurrence of mutation.occurrences) {
    if (intersectsRemoved(occurrence.span, render.removed)) {
      reject('SCHEMA_INVALID', 'occurrence overlaps a stripped marker')
    }
  }
  // Step 6: identity splits (§4.4) — contentHash over the render, draftHash over the draft.
  const contentHash = sha256Hex(render.text)
  const draftHash = sha256Hex(draftText)
  // Step 7: canonical deliverable destination (replaces the lexical check).
  const absoluteDeliverable = resolveDeliverable(root, mutation.path)
  // Step 8: the §4.3 first-bind overwrite gate, incl. our own provisional renders (§7).
  enforceOverwriteGate(graph, mutation, existing, absoluteDeliverable, contentHash, root)
  // Steps 9–10: the render intent is staged BEFORE the deliverable bytes (§7.1).
  const now = graph.now()
  const artifactId = existing?.id ?? `art_${randomUUID()}`
  deps.staged.push({
    path: renderIntentFile(root, projectId, deps.requestId),
    bytes: Buffer.from(
      stableJson({
        requestId: deps.requestId, projectId, artifactId, draftPath, draftHash,
        renderedHash: contentHash, target: mutation.path, at: now,
      }),
      'utf8',
    ),
  })
  deps.staged.push({
    path: absoluteDeliverable, bytes: Buffer.from(render.text, 'utf8'),
    kind: 'deliverable', expectedHash: contentHash,
  })
  // Step 11: the artifact — occurrences keep DRAFT coordinates (§4.4), no remap is persisted.
  if (existing !== undefined) {
    existing.contentHash = contentHash
    existing.occurrences = mutation.occurrences
    existing.outline = mutation.outline
    existing.draft = { path: draftPath, draftHash }
    existing.entityVersion += 1
    existing.updatedAt = now
  } else {
    graph.snapshot.artifacts.push({
      id: artifactId, entityVersion: 1, createdAt: now, updatedAt: now, path: mutation.path,
      contentHash, occurrences: mutation.occurrences, outline: mutation.outline,
      draft: { path: draftPath, draftHash },
    })
  }
}

/**
 * §4.2 step 7: canonical deliverable destination. The deliverable's parent
 * must realpath INSIDE the workspace (a symlinked parent resolving into a
 * restricted tree fails), and the canonical target must not lie under
 * `.dsh/**`, `docs/vwa-sources/**` or `docs/vwa-reports/**`.
 */
function resolveDeliverable(root: string, deliverablePath: string): string {
  const rootReal = realpathSync(root)
  const abs = resolve(rootReal, ...deliverablePath.split('/'))
  let parentReal: string
  try {
    parentReal = realpathSync(dirname(abs))
  } catch {
    reject('PATH_OUT_OF_BOUNDS', `deliverable parent directory does not exist: ${deliverablePath}`)
  }
  if (parentReal !== rootReal && !parentReal.startsWith(rootReal + sep)) {
    reject('PATH_OUT_OF_BOUNDS', `deliverable parent escapes the workspace: ${deliverablePath}`)
  }
  const canonical = join(parentReal, basename(abs))
  const restricted = [canonicalTree(root, '.dsh'), canonicalTree(root, LEGACY_SOURCES_ROOT), canonicalTree(root, LEGACY_REPORTS_ROOT)]
  if (restricted.some((tree) => isWithin(canonical, tree))) {
    reject('PATH_OUT_OF_BOUNDS', `artifact path is restricted: ${deliverablePath}`)
  }
  return canonical
}

/**
 * §4.3: a non-owned deliverable demands `overwrite: true`. Ownership =
 * "the bytes are our previous adopted render, this bind's own render, or a
 * provisional render an unadopted intent recorded" (the crashed bind's
 * roll-forward, TLA I6 `NoLostUserFile`, probe `strict-overwrite-foreign`).
 */
function enforceOverwriteGate(
  graph: GraphContext,
  mutation: Extract<Mutation, { op: 'bind-artifact' }>,
  existing: Artifact | undefined,
  absoluteDeliverable: string,
  newRenderHash: string,
  root: string,
): void {
  let current: string | undefined = graph.artifactTexts.get(mutation.path)
  if (current === undefined && existsSync(absoluteDeliverable)) {
    try {
      current = readFileSync(absoluteDeliverable, 'utf8')
    } catch {
      current = undefined
    }
  }
  if (current === undefined) return
  const currentHash = sha256Hex(current)
  if (currentHash === newRenderHash || currentHash === existing?.contentHash) return
  const intents = readRenderIntents(root, graph.snapshot.projectId)
  if (intents.some((intent) => intent.target === mutation.path && intent.renderedHash === currentHash)) return
  if (mutation.overwrite === true) return
  reject('SCHEMA_INVALID', 'deliverable exists and is not owned by this artifact; pass overwrite:true to take ownership')
}

/** Claim referents of the occurrences (§10.5). */
function validateOccurrenceRefs(graph: GraphContext, mutation: Extract<Mutation, { op: 'bind-artifact' }>): void {
  for (const occurrence of mutation.occurrences) {
    if (!graph.snapshot.claims.some((claim) => claim.id === occurrence.claimId)) {
      reject('REFERENCE_INVALID', `occurrence references unknown claim ${occurrence.claimId}`)
    }
  }
}

/** Claim/argument referents of the outline sections (§10.5). */
function validateOutlineRefs(graph: GraphContext, mutation: Extract<Mutation, { op: 'bind-artifact' }>): void {
  for (const section of mutation.outline) {
    for (const claimId of section.claimIds) {
      if (!graph.snapshot.claims.some((claim) => claim.id === claimId)) {
        reject('REFERENCE_INVALID', `outline references unknown claim ${claimId}`)
      }
    }
    for (const argumentId of section.argumentIds) {
      if (!graph.snapshot.arguments.some((argument) => argument.id === argumentId)) {
        reject('REFERENCE_INVALID', `outline references unknown argument ${argumentId}`)
      }
    }
  }
}

/** Artifact path rules (§10.5), the inline mode's lexical check: .md/.mdx only; never .dsh/vwa/**, snapshots, or reports. */
export function validateArtifactPath(path: string): void {
  if (!path.endsWith('.md') && !path.endsWith('.mdx')) {
    reject('PATH_OUT_OF_BOUNDS', `artifact path must be .md/.mdx: ${path}`)
  }
  const segments = path.split('/')
  if (path.startsWith('/') || segments.includes('..')
    || (segments[0] === '.dsh' && segments[1] === 'vwa')
    || (segments[0] === 'docs' && segments[1] === 'vwa-sources')
    || (segments[0] === 'docs' && segments[1] === 'vwa-reports')) {
    reject('PATH_OUT_OF_BOUNDS', `artifact path is restricted: ${path}`)
  }
}
