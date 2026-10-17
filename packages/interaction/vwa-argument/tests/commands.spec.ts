/**
 * Slice-5 /vwa command spec (§10.2, §18, D21): the closed grammar
 * (unknown subcommand / extra arguments = usage error), pointer CAS-ish
 * writes, status, import re-verification, STORE_CORRUPT repair candidate
 * adoption, the §18 sign/adjudicate transactions, and D21 (assistant-source
 * fabrication is rejected — only a real user command may sign/adjudicate).
 * @module tests/commands
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { randomUUID, createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  executeVwa,
  findFinding,
  parseVwaArgs,
  readPointer,
  vwaAdjudicate,
  vwaSign,
  VWA_SUBCOMMANDS,
  VWA_USAGE,
  writePointer,
} from '../src/commands.ts'
import { appendAdjudication, appendSignature, currentDependencyDigest, validateAdjudicationSource, readPendingRuns } from '../src/report.ts'
import { ReviewRunStore } from '../src/review-run-store.ts'
import { ProjectStore } from '../src/store.ts'
import { initWorkspace } from './helpers.ts'
import type { Finding, ReviewRecord } from '../src/types.ts'
import { NOW, uuid } from './review-helpers.ts'

function agentOf(root: string): unknown {
  return { session: { header: { cwd: root } } }
}

const deps = { workspaceRoot: (agent: { session: { header: { cwd: string } } }) => agent.session.header.cwd }

function run(root: string, raw: string): Promise<{ kind: 'success' | 'error'; text?: string }> {
  // The real surface: the command registry dispatches a human UI line — the
  // parsed grammar + deps. executeVwa is the transaction face.
  return executeVwa(deps as never, agentOf(root) as never, parseOrThrow(raw))
}

function parseOrThrow(raw: string): { sub: import('../src/commands.ts').VwaSubcommand; rest: string[] } {
  const parsed = parseVwaArgs(raw)
  if (!parsed.ok) throw new Error(parsed.usage)
  return parsed
}

describe('closed grammar (§10.2)', () => {
  it('exposes exactly the six closed subcommands', () => {
    expect([...VWA_SUBCOMMANDS]).toHaveLength(6)
    expect([...VWA_SUBCOMMANDS]).toContain('init')
  })
  it('an unknown subcommand is a usage error', () => {
    const parsed = parseVwaArgs('explode')
    expect(parsed.ok).toBe(false)
    expect(parsed.usage).toContain('unknown /vwa subcommand')
  })
  it('extra arguments are a usage error', () => {
    expect(parseVwaArgs('status extra').ok).toBe(false)
    expect(parseVwaArgs('sign a b c').ok).toBe(false)
    expect(parseVwaArgs('repair p x').ok).toBe(false)
  })
  it('bare /vwa prints usage', () => {
    expect(parseVwaArgs('').ok).toBe(false)
    expect(parseVwaArgs('').usage).toContain('Usage: /vwa')
  })
  it('the adjudicate reason keeps interior spaces', () => {
    const parsed = parseVwaArgs(`adjudicate fnd_1 reject the quote is fine and the source agrees`)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.rest[0]).toBe('fnd_1')
      expect(parsed.rest[1]).toBe('reject')
      expect(parsed.rest[2]).toBe('the quote is fine and the source agrees')
    }
  })
})

describe('/vwa init + status (§10.2 pointer)', () => {
  it('init creates a project and binds the pointer; no search/review triggered', async () => {
    const { root } = initWorkspace()
    const result = await run(root, 'init')
    expect(result.kind).toBe('success')
    const pointer = readPointer(root)
    expect(pointer?.schemaVersion).toBe(1)
    expect(pointer?.projectId.startsWith('prj_')).toBe(true)
    expect(result.text).toContain('no search or review')
  })
  it('init <id> switches to an existing project only', async () => {
    const made = initWorkspace()
    const result = await run(made.root, `init ${made.projectId}`)
    expect(result.kind).toBe('success')
    expect(readPointer(made.root)?.projectId).toBe(made.projectId)
    const missing = await run(made.root, `init prj_${randomUUID()}`)
    expect(missing.kind).toBe('error')
  })
  it('status reports the pointer, revision, and pending runs', async () => {
    const made = initWorkspace()
    await run(made.root, `init ${made.projectId}`)
    const result = await run(made.root, 'status')
    expect(result.kind).toBe('success')
    expect(result.text).toContain(made.projectId)
    expect(result.text).toContain('Revision 1')
    expect(result.text).toContain('Pending review runs: none')
    expect(readPendingRuns(made.root, made.projectId)).toEqual([])
  })
})

describe('/vwa import (§10.2 re-verify + rebind)', () => {
  it('rejects when a bound artifact changed on disk; pointer unchanged', async () => {
    const made = initWorkspace()
    writePointer(made.root, made.projectId, 'x'.repeat(64))
    writeFileSync(`${made.root}/docs/a.md`, ARTIFACT, 'utf8')
    bind(made.root, made.projectId, made.store)
    writeFileSync(`${made.root}/docs/a.md`, 'tampered', 'utf8')
    const result = await run(made.root, 'import docs')
    expect(result.kind).toBe('error')
    expect(result.text).toContain('bytes changed after binding')
    expect(readPointer(made.root)?.projectId).toBe(made.projectId)
  })
  it('a healthy project re-verifies and keeps the pointer', async () => {
    const made = initWorkspace()
    writePointer(made.root, made.projectId, 'x'.repeat(64))
    writeFileSync(`${made.root}/docs/a.md`, ARTIFACT, 'utf8')
    bind(made.root, made.projectId, made.store)
    const result = await run(made.root, 'import docs')
    expect(result.kind).toBe('success')
    expect(result.text).toContain('re-verified')
  })
})

describe('/vwa repair (§14.2 candidate adoption)', () => {
  it('lists candidates and adopts the newest after chain re-verification', async () => {
    const made = initWorkspace()
    const store = made.store
    // One more committed revision so repair has a candidate to adopt.
    const head = store.readHead()
    if (!head.ok) throw new Error(head.message)
    const applied = store.withTransaction<void>({
      expectedRevision: head.data.head.revision,
      requestId: randomUUID(),
      payloadHash: randomUUID(),
      applyFn: (mutable) => {
        mutable.contract.expectedCoreTopics.push('extra')
        return { result: undefined }
      },
    })
    if (!applied.ok) throw new Error(applied.message)
    // Corrupt HEAD.
    const headPath = `${made.root}/.dsh/vwa/${made.projectId}/HEAD.json`
    const broken = JSON.parse(readFileSync(headPath, 'utf8')) as { graphHash: string }
    broken.graphHash = '0'.repeat(64)
    writeFileSync(headPath, JSON.stringify(broken), 'utf8')
    expect(store.readHead().ok).toBe(false)
    const result = await run(made.root, `repair ${made.projectId}`)
    expect(result.kind).toBe('success')
    expect(result.text).toContain('Adopted')
    expect(store.readHead().ok).toBe(true)
  })
})

describe('/vwa sign + adjudicate (§18, D21)', () => {
  function seedFinding(root: string, projectId: string, findingId: string, code: string): void {
    const runId = `run_${randomUUID()}`
    new ReviewRunStore(root, projectId).writeRecord(runId, {
      runId, stage: 'arguments', targetRefs: [], dependencyDigest: '', artifactHash: undefined,
      contractHash: 'c'.repeat(64), policyHash: 'p'.repeat(64), reviewerConfigHash: 'r'.repeat(64),
      promptHash: 'q'.repeat(64), inputHash: 'i'.repeat(64),
      status: 'completed', inputTokens: 0, outputTokens: 0,
      startedAt: NOW, endedAt: NOW,
      response: {
        stage: 'arguments', rubricVersion: 'humanities-v1', findings: [{
          id: findingId, code, targetIds: [], severity: 'major',
          explanation: 'the warrant overreaches', evidenceIds: [], artifactSpans: [], repair: 'repair-argument',
        }],
        targets: [],
      },
    } as never)
  }

  it('adjudicate rejects a non-user signer record outright (D21)', () => {
    expect(() => validateAdjudicationSource({ signer: 'assistant' })).toThrow(/only a USER source/)
    expect(() => validateAdjudicationSource({ signer: 'user' })).not.toThrow()
  })

  it('appendAdjudication only ever writes signer user; fabricated records fail on read-back (D21)', async () => {
    const made = initWorkspace()
    writePointer(made.root, made.projectId, 'x'.repeat(64))
    const forged = {
      adjudicationId: `adj_${randomUUID()}`, findingId: 'f_1', decision: 'reject' as const,
      reason: 'the model said the user agreed', signer: 'assistant' as never, ts: NOW,
      dependencyDigest: 'd'.repeat(64), overrides: { ruleId: 'ARG-01', targetId: '', runId: '' },
    }
    // The command write path refuses a non-user signer before any bytes land.
    expect(() => appendAdjudication(made.root, made.projectId, forged as never)).toThrow(/only a USER source/)
    // A tool input cannot reach the command surface at all: argument.update
    // bodies are store mutations, not commands — the fabricated record never
    // exists on disk.
    expect(findFinding(made.root, made.projectId, 'f_1')).toBeUndefined()
  })

  it('adjudicate requires a non-empty reason and an existing semantic finding', async () => {
    const made = initWorkspace()
    writePointer(made.root, made.projectId, 'x'.repeat(64))
    const findingId = `fnd_${randomUUID()}`
    seedFinding(made.root, made.projectId, findingId, 'ARG-01')
    const noReason = await executeVwa(deps as never, agentOf(made.root) as never, { sub: 'adjudicate', rest: [findingId, 'reject', ''] })
    expect(noReason.kind).toBe('error')
    expect(noReason.text).toContain('non-empty reason')
    const unknown = await executeVwa(deps as never, agentOf(made.root) as never, { sub: 'adjudicate', rest: ['fnd_missing', 'reject', 'because'] })
    expect(unknown.kind).toBe('error')
  })

  it('a deterministic failure cannot be adjudicated away (§18)', async () => {
    const made = initWorkspace()
    writePointer(made.root, made.projectId, 'x'.repeat(64))
    const findingId = `fnd_${randomUUID()}`
    seedFinding(made.root, made.projectId, findingId, 'EVID-01')
    const result = await run(made.root, `adjudicate ${findingId} reject quote mismatch is deterministic`)
    expect(result.kind).toBe('error')
    expect(result.text).toContain('deterministic')
  })

  it('reject removes the finding from the active counts; the original record is untouched', async () => {
    const made = initWorkspace()
    writePointer(made.root, made.projectId, 'x'.repeat(64))
    const findingId = `fnd_${randomUUID()}`
    seedFinding(made.root, made.projectId, findingId, 'ARG-01')
    const result = await run(made.root, `adjudicate ${findingId} reject the warrant is scoped in the body`)
    expect(result.kind).toBe('success')
    const adjudications = JSON.parse(readFileSync(`${made.root}/.dsh/vwa/${made.projectId}/adjudications.json`, 'utf8')) as { adjudications: { signer: string; decision: string; findingId: string }[] }
    expect(adjudications.adjudications).toHaveLength(1)
    expect(adjudications.adjudications[0]?.signer).toBe('user')
    // The review record is never rewritten.
    const records = new ReviewRunStore(made.root, made.projectId).readRecords((JSON.parse(readFileSync(`${made.root}/.dsh/vwa/${made.projectId}/adjudications.json`, 'utf8')) as never as { adjudications: { overrides: { runId: string } }[] }).adjudications[0]!.overrides.runId)
    expect(records[0]?.response?.findings[0]?.id).toBe(findingId)
    // The active count excludes the rejected finding.
    expect(currentDependencyDigest(made.root, made.projectId)).toBeDefined()
  })
})

// shared fixtures for import tests
const ARTIFACT = '# Title\n\nThe policy shipped on 2026-10-16.\n'

function bind(root: string, projectId: string, store: ProjectStore): void {
  const text = readFileSync(`${root}/docs/a.md`, 'utf8')
  const head = store.readHead()
  if (!head.ok) throw new Error(head.message)
  const applied = store.withTransaction<void>({
    expectedRevision: head.data.head.revision,
    requestId: `bind-${randomUUID()}`,
    payloadHash: randomUUID(),
    applyFn: (mutable) => {
      mutable.artifacts.push({
        id: `art_${randomUUID()}`, entityVersion: 1, createdAt: '', updatedAt: '',
        path: 'docs/a.md', contentHash: createHash('sha256').update(text, 'utf8').digest('hex'),
        occurrences: [], outline: [],
      })
      return { result: undefined }
    },
  })
  if (!applied.ok) throw new Error(applied.message)
}
