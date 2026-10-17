/**
 * Artifact binding (design docs/plans/2026-10-16-vwa-evidence-argument.md
 * §10.5 `bind-artifact`): occurrence/outline validation against the actual
 * artifact text, one artifact per path project-wide, restricted paths.
 *
 * Split out of graph.ts for the repo file-size cap; the behavior is the
 * §10.5 contract verbatim.
 *
 * @module @dsh-cc/vwa-argument/artifact
 */

import { createHash } from 'node:crypto'
import { randomUUID } from 'node:crypto'
import { spanError } from './schema.ts'
import { VwaFail, fail } from './store.ts'
import type { GraphContext, Mutation } from './graph.ts'

/** Throw a uniform failure out of an apply function (no partial commit). */
function reject(code: import('./store.ts').Fail['code'], message: string): never {
  throw new VwaFail(fail(code, message))
}

/** Create or update the bound Artifact after full occurrence/outline validation (§10.5). */
export function applyBindArtifact(graph: GraphContext, mutation: Extract<Mutation, { op: 'bind-artifact' }>): void {
  validateArtifactPath(mutation.path)
  const text = graph.artifactText(mutation.path)
  const contentHash = createHash('sha256').update(text, 'utf8').digest('hex')
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
  const existing = graph.snapshot.artifacts.find((artifact) => artifact.path === mutation.path)
  if (mutation.artifactId !== undefined && existing === undefined) {
    reject('REFERENCE_INVALID', `unknown artifactId ${mutation.artifactId}`)
  }
  if (existing !== undefined && mutation.artifactId !== undefined && existing.id !== mutation.artifactId) {
    reject('REFERENCE_INVALID', `artifactId ${mutation.artifactId} does not match the bound artifact for this path`)
  }
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

/** Artifact path rules (§10.5): .md/.mdx only; never .dsh/vwa/**, snapshots, or reports. */
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
