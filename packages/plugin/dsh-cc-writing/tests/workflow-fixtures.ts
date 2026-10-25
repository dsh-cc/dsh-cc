/** Shared fixtures for workflow.spec.ts (plan §13). */
import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect } from 'vitest'
import { scanBlocks } from '../skills/writing-workflow/scripts/markdown.lib.mjs'
import { runCommand } from '../skills/writing-workflow/scripts/writing.mjs'

// ---------------------------------------------------------------- harness

export type Envelope = {
  ok: boolean
  result?: any
  code?: string
  message?: string
  details?: any
  exitCode?: number
}

export const call = (command: string, workspace: string, input: unknown): Envelope =>
  (runCommand as unknown as (c: string, w: string, i: unknown) => Envelope)(command, workspace, input)

export const ok = (envelope: Envelope) => {
  expect(envelope.ok, envelope.message).toBe(true)
  return envelope.result as any
}

export const failure = (envelope: Envelope, code: string, exitCode: number) => {
  expect(envelope.ok).toBe(false)
  expect(envelope.code).toBe(code)
  expect(envelope.exitCode).toBe(exitCode)
  return envelope
}

export const directories: string[] = []

export function makeWorkspace() {
  const root = mkdtempSync(join(tmpdir(), 'writing-workflow-'))
  directories.push(root)
  mkdirSync(join(root, 'docs/articles'), { recursive: true })
  return root
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    try {
      chmodSync(directory, 0o700)
      chmodSync(join(directory, 'docs/articles'), 0o700)
    } catch {
      /* best effort restore */
    }
    rmSync(directory, { recursive: true, force: true })
  }
})

export const bodyPath = (workspace: string) => join(workspace, 'docs/articles/a.md')
export const readBody = (workspace: string) => readFileSync(bodyPath(workspace), 'utf8')

export function brief(workspace: string, overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    kind: 'brief',
    runId: randomUUID(),
    operation: 'write',
    question: 'Why does the cache miss?',
    audience: 'Backend engineers',
    language: 'en',
    bodyPath: 'docs/articles/a.md',
    companionPath: 'docs/articles/a.writing',
    profile: 'technical',
    targetLength: null,
    requiredQuestions: [{ id: 'q1', text: 'Why does the cache miss?' }],
    sourceScope: { localPaths: [], webAllowed: false, description: 'none' },
    evidenceMode: 'ordinary',
    allowBodyChanges: true,
    repairRounds: 1,
    protectedTerms: [],
    styleOverrides: [],
    defaultsApplied: [],
    ...overrides,
  }
}

export function initRun(workspace: string, overrides: Record<string, unknown> = {}, replaceExisting = false) {
  return ok(call('init', workspace, { brief: brief(workspace, overrides), replaceExisting }))
}

export function writePlan(runId: string, overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    kind: 'plan',
    runId,
    descriptive: false,
    thesis: 'The cache misses because keys expire early.',
    questions: ['q1'],
    sections: [
      {
        id: 's1',
        title: 'Cause',
        questionIds: ['q1'],
        purpose: 'inference',
        claim: 'Keys expire early.',
        premises: ['TTL is short.'],
        assumptions: [],
        evidenceRefs: [],
        dependsOn: [],
        readerTakeaway: 'Raise the TTL.',
        lengthWeight: 1,
      },
    ],
    ...overrides,
  }
}

export function descriptivePlan(runId: string) {
  return writePlan(runId, { descriptive: true })
}

export function contextArtifact(runId: string) {
  return {
    schemaVersion: 1,
    kind: 'context',
    runId,
    sections: [{ sectionId: 's1', actualSummary: 'Explains expiry.', establishedClaims: [], openQuestions: [] }],
  }
}

export type TextBlock = { start: number; end: number }

export const blocksOf = (text: string): TextBlock[] => scanBlocks(text).blocks as TextBlock[]

export function finding(text: string, needle: string, overrides: Record<string, unknown> = {}) {
  const start = text.indexOf(needle)
  expect(start).toBeGreaterThanOrEqual(0)
  return {
    id: randomUUID(),
    category: 'verbosity',
    severity: 'minor',
    start,
    end: start + needle.length,
    quote: needle,
    explanation: 'redundant',
    suggestedAction: 'shorten',
    protectedMeaning: [],
    status: 'open',
    resolution: null,
    ...overrides,
  }
}

export function review(runId: string, text: string, stage: string, options: { findings?: any[]; coverage?: string } = {}) {
  const blocks = blocksOf(text)
  return {
    schemaVersion: 1,
    kind: 'review',
    id: randomUUID(),
    runId,
    stage,
    coverage: options.coverage ?? 'complete',
    coverageRanges: blocks.map((block) => ({ start: block.start, end: block.end })),
    crossSectionConsistency: true,
    reverseOutline:
      stage === 'structure'
        ? blocks.map((block) => ({
            start: block.start,
            end: block.end,
            quote: text.slice(block.start, block.end),
            summary: 'paragraph',
            role: 'prose',
            sectionId: null,
          }))
        : [],
    findings: options.findings ?? [],
  }
}

export function proposal(
  runId: string,
  edits: { start: number; end: number; before: string; after: string; reason: string }[],
  findingIds: string[],
  intent: string,
) {
  return { schemaVersion: 1, kind: 'proposal', id: randomUUID(), runId, findingIds, intent, edits }
}

export function record(workspace: string, runPath: string, artifact: unknown, expectedBodyHash: string | null, expectedPlanHash: string | null) {
  return call('record', workspace, { runPath, artifact, expectedBodyHash, expectedPlanHash })
}

export function statusOf(workspace: string, runPath: string) {
  return ok(call('status', workspace, { runPath }))
}

export const reportPath = (workspace: string, runPath: string) => join(workspace, runPath, 'editorial-report.md')
export const runJson = (workspace: string, runPath: string) => JSON.parse(readFileSync(join(workspace, runPath, 'run.json'), 'utf8'))
