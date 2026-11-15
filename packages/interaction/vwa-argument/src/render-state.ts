/**
 * Render intents, the §7.2 three-state crash classifier, and draft reads
 * (design `docs/plans/2026-11-15-vwa-autonomous-render-pipeline.md` §7.1,
 * §7.2, §7.3).
 *
 * A bind whose mode is `draft` stages `renders/<requestId>.json` BEFORE the
 * deliverable body (§7.1) and HEAD adoption deletes it; an intent the HEAD
 * never adopted is inert evidence — the only proof that the runtime, rather
 * than a human edit, produced the bytes currently at the deliverable path.
 * Classification NEVER consults `artifact.draft.draftHash`: that hash is
 * computed by the same bind that produced the current contentHash, so a
 * roll-forward crash could never be told apart by it (the r2 defect). The
 * live inputs are the deliverable bytes, the CURRENT draft bytes, and the
 * intent records (§7.2).
 *
 * This module deliberately imports nothing from the store: the store calls
 * INTO it (temp sweep, intent path), and the report/tools/commands callers
 * map its outcomes onto their own failure shapes.
 *
 * @module @dsh-cc/vwa-argument/render-state
 */

import { readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { DRAFT_FILE_RE, vwaProjectIdOfDraft } from '@dsh-cc/vwa-evidence'
import { projectRendersDir } from './paths.ts'
import { sha256Hex } from './schema.ts'
import { stripMarkers } from './render.ts'
import type { Artifact } from './types.ts'

/**
 * A stale-handle / changed-input condition (Appendix A). `STALE_RENDER`
 * (§7.2) is the provisional-render crash state: the bytes are a render this
 * runtime produced and never adopted — retryable by re-running the bind,
 * never a user-drift verdict.
 */
export class InputChangedError extends Error {
  readonly code: 'INPUT_CHANGED' | 'STALE_RENDER'
  constructor(message: string, code: 'INPUT_CHANGED' | 'STALE_RENDER' = 'INPUT_CHANGED') {
    super(message)
    this.name = 'InputChangedError'
    this.code = code
  }
}

/** The §7.2 stale-render message; the remedy is a normal bind re-run (§7.4). */
export const STALE_RENDER_MESSAGE = 'deliverable is a provisional render from an unadopted bind; re-run the bind for this artifact'

/** Durable render-intent record staged by a draft bind (§7.1). */
export interface RenderIntent {
  requestId: string
  projectId: string
  artifactId?: string
  draftPath: string
  draftHash: string
  renderedHash: string
  /** Workspace-relative deliverable path the intent published bytes to. */
  target: string
  at: string
}

/** `renders/<requestId>.json` for one project (§3.1). */
export function renderIntentFile(root: string, projectId: string, requestId: string): string {
  return join(projectRendersDir(root, projectId), `${requestId}.json`)
}

/**
 * Parse every intent currently on disk for a project. A missing directory,
 * malformed JSON, or a shape-tampered record is skipped — tampered intents
 * are inert evidence (an unmatched record simply fails to rescue the
 * classification into the stale series, §7.2 series (b)).
 */
export function readRenderIntents(root: string, projectId: string): RenderIntent[] {
  const dir = projectRendersDir(root, projectId)
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const intents: RenderIntent[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      const parsed = JSON.parse(readFileSync(join(dir, name), 'utf8')) as Partial<RenderIntent>
      if (
        typeof parsed.projectId !== 'string' || parsed.projectId !== projectId ||
        typeof parsed.draftPath !== 'string' || typeof parsed.draftHash !== 'string' ||
        typeof parsed.renderedHash !== 'string' || typeof parsed.target !== 'string' ||
        typeof parsed.at !== 'string'
      )
        continue
      intents.push({
        requestId: typeof parsed.requestId === 'string' ? parsed.requestId : name.replace(/\.json$/, ''),
        projectId,
        ...(typeof parsed.artifactId === 'string' ? { artifactId: parsed.artifactId } : {}),
        draftPath: parsed.draftPath,
        draftHash: parsed.draftHash,
        renderedHash: parsed.renderedHash,
        target: parsed.target,
        at: parsed.at,
      })
    } catch {
      continue
    }
  }
  return intents
}

/** The §7.2 three states. Legacy inline artifacts use only current/input-changed. */
export type RenderState = 'current' | 'stale-render' | 'input-changed'

/**
 * §7.2 classifier, in the doc's precedence order:
 * 1. bytes hash to the adopted `contentHash` → `current` (any intent left
 *    behind is stale bookkeeping).
 * 2. (a) the bytes are the render of the CURRENT draft, or (b) an unadopted
 *    intent for this target recorded exactly these bytes → `STALE_RENDER`
 *    (retryable; re-run the bind).
 * 3. every other case → `INPUT_CHANGED` (genuine drift).
 * Legacy inline artifacts are two-state: callers pass `draftBacked: false`
 * and neither series is consulted.
 */
export function classifyRenderState(input: {
  bytesHash: string
  contentHash: string
  draftBacked: boolean
  draftText?: string | undefined
  intents: readonly RenderIntent[]
  target: string
}): RenderState {
  if (input.bytesHash === input.contentHash) return 'current'
  if (input.draftBacked) {
    if (input.draftText !== undefined && sha256Hex(stripMarkers(input.draftText).text) === input.bytesHash)
      return 'stale-render'
    if (input.intents.some((i) => i.target === input.target && i.renderedHash === input.bytesHash))
      return 'stale-render'
  }
  return 'input-changed'
}

/**
 * Read the CURRENT draft bytes for one artifact (§4.2 step 2's predicates,
 * read-time form): the recorded path must be a well-formed draft file of
 * THIS project and its realpath must stay inside the canonical drafts
 * directory. Missing, escaping, or non-lossless-UTF-8 bytes yield
 * `undefined` (a drift condition to the caller, never a silent read).
 */
export function readDraftText(root: string, projectId: string, draftPath: string): string | undefined {
  const absolute = resolveContainedDraftFile(root, projectId, draftPath)
  if (absolute === undefined) return undefined
  try {
    const bytes = readFileSync(absolute)
    const text = bytes.toString('utf8')
    if (bytes.includes(0) || !Buffer.from(text, 'utf8').equals(bytes)) return undefined
    return text
  } catch {
    return undefined
  }
}

/**
 * Realpath of a draft file contained in its project's canonical drafts
 * directory, or `undefined`. Shape (DRAFT_FILE_RE) and the `prj_` segment
 * are checked before any filesystem touch.
 */
export function resolveContainedDraftFile(
  root: string,
  projectId: string,
  draftPath: string,
): string | undefined {
  if (!DRAFT_FILE_RE.test(draftPath) || vwaProjectIdOfDraft(draftPath) !== projectId) return undefined
  let fileReal: string
  let draftsReal: string
  try {
    fileReal = realpathSync(resolve(root, ...draftPath.split('/')))
  } catch {
    return undefined
  }
  try {
    draftsReal = realpathSync(join(root, '.dsh', 'vwa', projectId, 'drafts'))
  } catch {
    return undefined
  }
  const contained = draftsReal.endsWith(sep) ? draftsReal : `${draftsReal}${sep}`
  return fileReal.startsWith(contained) ? fileReal : undefined
}

/**
 * Sweep `*.tmp` siblings older than 24 h in a deliverable's directory
 * (§4.6): the out-of-tree staged file pattern is `<deliverable>.<uuid>.tmp`
 * and temps are cleaned opportunistically while staging the same
 * destination. Best-effort; failures are silent.
 */
export function sweepStaleTemps(dir: string, nowMs = Date.now()): void {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    if (!name.endsWith('.tmp')) continue
    try {
      const path = join(dir, name)
      if (nowMs - statSync(path).mtimeMs > 24 * 60 * 60 * 1000) rmSync(path, { force: true })
    } catch {
      continue
    }
  }
}

/**
 * §7.2 classification of the deliverable bytes at `artifact.path` for one
 * bound artifact: reads the CURRENT draft and the intent records itself.
 * `stale-render` even when the draft moved on after the crash — the intent
 * record (series (b)) is the fallback evidence then (assumption A-4).
 */
export function classifyStoredState(
  root: string,
  projectId: string,
  artifact: Artifact,
  bytesHash: string,
): RenderState {
  return classifyRenderState({
    bytesHash,
    contentHash: artifact.contentHash,
    draftBacked: artifact.draft !== undefined,
    ...(artifact.draft === undefined ? {} : { draftText: readDraftText(root, projectId, artifact.draft.path) }),
    intents: artifact.draft === undefined ? [] : readRenderIntents(root, projectId),
    target: artifact.path,
  })
}

/** Everything the delivery evaluation needs about one bound artifact's texts (§4.4). */
export interface DeliverableMaterial {
  /** The marker-free bytes at `artifact.path` (render replay). */
  renderedText: string
  /** The draft bytes (audit/assessment replay); equals `renderedText` for legacy inline artifacts. */
  semanticText: string
  /** sha256 of `renderedText` (== `artifact.contentHash` once the gate passed). */
  renderedHash: string
}

/**
 * Read the deliverable + draft of a draft-backed artifact and classify the
 * state, throwing a classified {@link InputChangedError} on mismatch
 * (§7.2/§7.3). Legacy inline artifacts keep the two-state behavior verbatim.
 * `readDeliverable` is the caller's byte seam (realpath + UTF-8 guard live
 * behind it) so this module never reaches for the delivery-check module.
 */
export function materializeDeliverable(
  root: string,
  projectId: string,
  artifact: Artifact,
  readDeliverable: () => string,
): DeliverableMaterial {
  const renderedText = readDeliverable()
  const renderedHash = sha256Hex(renderedText)
  if (artifact.draft === undefined) {
    if (renderedHash !== artifact.contentHash)
      throw new InputChangedError('artifact bytes changed after binding; re-bind and re-audit are required')
    return { renderedText, semanticText: renderedText, renderedHash }
  }
  if (renderedHash !== artifact.contentHash) {
    const state = classifyStoredState(root, projectId, artifact, renderedHash)
    if (state === 'stale-render') throw new InputChangedError(STALE_RENDER_MESSAGE, 'STALE_RENDER')
    throw new InputChangedError('artifact bytes changed after binding; re-bind and re-audit are required')
  }
  const draftText = readDraftText(root, projectId, artifact.draft.path)
  if (draftText === undefined)
    throw new InputChangedError(`draft text for ${artifact.draft.path} is unavailable`)
  return { renderedText, semanticText: draftText, renderedHash }
}
