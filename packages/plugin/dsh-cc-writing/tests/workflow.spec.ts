/** End-to-end workflow tests for the writing CLI (plan §6, §13). */
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { sha256 } from '../skills/writing-workflow/scripts/files.lib.mjs'
import { runCommand } from '../skills/writing-workflow/scripts/writing.mjs'
import {
  bodyPath,
  brief,
  call,
  contextArtifact,
  directories,
  failure,
  finding,
  initRun,
  makeWorkspace,
  ok,
  proposal,
  readBody,
  record,
  reportPath,
  review,
  runJson,
  statusOf,
  writePlan,
  descriptivePlan,
} from './workflow-fixtures'

// ------------------------------------------------------------- test cases

describe('review-only workflow', () => {
  it('keeps the input body bytes unchanged and creates findings and a report', () => {
    const workspace = makeWorkspace()
    const body = '# Cache misses\n\nThe cache may miss under load.\n'
    writeFileSync(bodyPath(workspace), body)
    const init = initRun(workspace, { operation: 'review', allowBodyChanges: false })
    expect(init.bodyHash).toBe(sha256(Buffer.from(body)))

    const snapshot = ok(call('snapshot', workspace, { runPath: init.runPath }))
    expect(snapshot.hash).toBe(init.bodyHash)
    const planned = ok(record(workspace, init.runPath, descriptivePlan(init.runId), snapshot.hash, null))
    expect(planned.phase).toBe('initialized')
    const planHash = statusOf(workspace, init.runPath).planHash
    expect(planHash).toBeTypeOf('string')

    const structure = review(init.runId, body, 'structure', { findings: [finding(body, 'may miss')] })
    ok(record(workspace, init.runPath, structure, snapshot.hash, planHash))
    const language = review(init.runId, body, 'language')
    const languageResult = ok(record(workspace, init.runPath, language, snapshot.hash, planHash))
    expect(languageResult.phase).toBe('language-revised')

    const finalized = ok(call('finalize', workspace, { runPath: init.runPath, expectedBodyHash: snapshot.hash }))
    expect(finalized.editorialOutcome).toBe('checked-no-major-findings')
    expect(readBody(workspace)).toBe(body)
    expect(existsSync(reportPath(workspace, init.runPath))).toBe(true)
    expect(readFileSync(reportPath(workspace, init.runPath), 'utf8')).toContain('may miss')
    expect(runJson(workspace, init.runPath).outcome).toBe('completed')
    expect(runJson(workspace, init.runPath).phase).toBe('finalized')
  })
})

describe('permission boundary', () => {
  it('rejects apply in review mode and unauthorized replacement at init', () => {
    const workspace = makeWorkspace()
    const body = 'The cache may miss.\n\nIt is slow.\n'
    writeFileSync(bodyPath(workspace), body)
    const init = initRun(workspace, { operation: 'review', allowBodyChanges: false })
    const snapshot = ok(call('snapshot', workspace, { runPath: init.runPath }))
    const planned = ok(record(workspace, init.runPath, descriptivePlan(init.runId), snapshot.hash, null))
    expect(planned.ok).toBeUndefined()
    const planHash = statusOf(workspace, init.runPath).planHash
    const languageFinding = finding(body, 'may')
    const language = review(init.runId, body, 'language', { findings: [languageFinding] })
    ok(record(workspace, init.runPath, language, snapshot.hash, planHash))
    const proposed = proposal(init.runId, [{ start: languageFinding.start, end: languageFinding.end, before: 'may', after: 'can', reason: 'clarity' }], [languageFinding.id], 'clarity')
    ok(record(workspace, init.runPath, proposed, snapshot.hash, planHash))
    const denied = failure(
      call('apply', workspace, { runPath: init.runPath, proposalId: proposed.id, expectedBodyHash: snapshot.hash }),
      'PERMISSION_REQUIRED',
      4,
    )
    expect(denied.details).toBeTypeOf('object')
    expect(readBody(workspace)).toBe(body)

    const replacing = call('init', workspace, {
      brief: brief(workspace, { operation: 'write', companionPath: 'docs/articles/b.writing' }),
      replaceExisting: false,
    })
    failure(replacing, 'INVALID_INPUT', 2)
  })
})

function editRun(workspace: string, specification = { allowBodyChanges: true, repairRounds: 0 }) {
  const body = 'The cache may miss.\n\nIt is slow.\n'
  writeFileSync(bodyPath(workspace), body)
  const init = initRun(workspace, { operation: 'edit', ...specification })
  const snapshot = ok(call('snapshot', workspace, { runPath: init.runPath }))
  return { init, snapshot, body }
}

describe('stale proposal', () => {
  it('returns STALE_BODY and preserves an external body edit', () => {
    const workspace = makeWorkspace()
    const { init, snapshot, body } = editRun(workspace)
    const languageFindings = [finding(body, 'may'), finding(body, 'slow')]
    ok(record(workspace, init.runPath, review(init.runId, body, 'language', { findings: languageFindings }), snapshot.hash, null))
    const proposed = proposal(init.runId, [{ start: languageFindings[0].start, end: languageFindings[0].end, before: 'may', after: 'can', reason: 'clarity' }], [languageFindings[0].id], 'clarity')
    ok(record(workspace, init.runPath, proposed, snapshot.hash, null))
    const external = `${body}\nExternal edit.\n`
    writeFileSync(bodyPath(workspace), external)
    failure(
      call('apply', workspace, { runPath: init.runPath, proposalId: proposed.id, expectedBodyHash: snapshot.hash }),
      'STALE_BODY',
      3,
    )
    expect(readBody(workspace)).toBe(external)
  })
})

describe('stale plan', () => {
  it('does not let a prior structure review satisfy finalization', () => {
    const workspace = makeWorkspace()
    const init = initRun(workspace, {})
    const body = '# Cause\n\nKeys expire early.\n'
    writeFileSync(bodyPath(workspace), body)
    const snapshot = ok(call('snapshot', workspace, { runPath: init.runPath }))
    ok(record(workspace, init.runPath, writePlan(init.runId), snapshot.hash, null))
    const planHash = statusOf(workspace, init.runPath).planHash
    ok(record(workspace, init.runPath, contextArtifact(init.runId), snapshot.hash, planHash))
    ok(record(workspace, init.runPath, review(init.runId, body, 'structure'), snapshot.hash, planHash))

    const revised = writePlan(init.runId, { thesis: 'The cache misses because the eviction policy is wrong.' })
    const revisedResult = ok(record(workspace, init.runPath, revised, snapshot.hash, planHash))
    expect(revisedResult.phase).toBe('diagnosed')
    const failed = failure(
      call('finalize', workspace, { runPath: init.runPath, expectedBodyHash: snapshot.hash }),
      'REVIEW_INCOMPLETE',
      4,
    )
    expect(failed.details.reportPath).toBeTypeOf('string')
    expect(failed.details.missing).toContain('structure-review')
    expect(existsSync(reportPath(workspace, init.runPath))).toBe(true)
  })
})

describe('malformed proposal', () => {
  it('rejects overlap, wrong quote, and duplicate insertion before any write', () => {
    const workspace = makeWorkspace()
    const { init, snapshot, body } = editRun(workspace)
    const findings = [finding(body, 'may'), finding(body, 'slow')]
    ok(record(workspace, init.runPath, review(init.runId, body, 'language', { findings }), snapshot.hash, null))
    const anchor = findings[0].start
    const candidates = [
      proposal(
        init.runId,
        [
          { start: anchor, end: anchor + 3, before: 'may', after: 'can', reason: 'a' },
          { start: anchor + 1, end: anchor + 4, before: 'ay ', after: 'ould ', reason: 'b' },
        ],
        [findings[0].id],
        'clarity',
      ),
      proposal(init.runId, [{ start: anchor, end: anchor + 3, before: 'nay', after: 'can', reason: 'wrong' }], [findings[0].id], 'clarity'),
      proposal(
        init.runId,
        [
          { start: anchor, end: anchor, before: '', after: 'very ', reason: 'insert' },
          { start: anchor, end: anchor, before: '', after: 'quite ', reason: 'insert' },
        ],
        [findings[0].id],
        'clarity',
      ),
    ]
    for (const candidate of candidates) {
      failure(record(workspace, init.runPath, candidate, snapshot.hash, null), 'INVALID_INPUT', 2)
    }
    expect(readBody(workspace)).toBe(body)
    expect(readdirSync(join(workspace, init.runPath, 'proposals'))).toEqual([])
  })
})

describe('budget limits', () => {
  it('rejects a second structural cycle after repairRounds', () => {
    const workspace = makeWorkspace()
    const init = initRun(workspace, { repairRounds: 0 })
    writeFileSync(bodyPath(workspace), '# Cause\n\nKeys expire early.\n')
    const body = readBody(workspace)
    const snapshot = ok(call('snapshot', workspace, { runPath: init.runPath }))
    ok(record(workspace, init.runPath, writePlan(init.runId), snapshot.hash, null))
    const planHash = statusOf(workspace, init.runPath).planHash
    const structural = finding(body, 'Keys expire early.', { category: 'order', severity: 'major' })
    ok(record(workspace, init.runPath, review(init.runId, body, 'structure', { findings: [structural] }), snapshot.hash, planHash))
    const proposed = proposal(
      init.runId,
      [{ start: structural.start, end: structural.end, before: 'Keys expire early.', after: 'Keys expire.', reason: 'order' }],
      [structural.id],
      'structure',
    )
    ok(record(workspace, init.runPath, proposed, snapshot.hash, planHash))
    failure(
      call('apply', workspace, { runPath: init.runPath, proposalId: proposed.id, expectedBodyHash: snapshot.hash }),
      'BUDGET_EXHAUSTED',
      4,
    )
    expect(readBody(workspace)).toBe(body)
    const status = statusOf(workspace, init.runPath)
    // No extra structural cycle consumed; the finding stays visible as open.
    expect(status.structuralRound).toBe(0)
    expect(status.nextStage).not.toBe('finalize')
  })

  it('rejects a second clarity pass and keeps unresolved work visible', () => {
    const workspace = makeWorkspace()
    const { init, snapshot } = editRun(workspace)
    const original = readBody(workspace)
    const clarityFinding = finding(original, 'may')
    ok(record(workspace, init.runPath, review(init.runId, original, 'language', { findings: [clarityFinding] }), snapshot.hash, null))
    const first = proposal(init.runId, [{ start: clarityFinding.start, end: clarityFinding.end, before: 'may', after: 'can', reason: 'clarity' }], [clarityFinding.id], 'clarity')
    ok(record(workspace, init.runPath, first, snapshot.hash, null))
    const applied = ok(call('apply', workspace, { runPath: init.runPath, proposalId: first.id, expectedBodyHash: snapshot.hash }))
    const updated = readBody(workspace)
    ok(record(workspace, init.runPath, review(init.runId, updated, 'language'), applied.afterHash, null))
    const secondFinding = finding(updated, 'slow')
    ok(record(workspace, init.runPath, review(init.runId, updated, 'language', { findings: [secondFinding] }), applied.afterHash, null))
    const second = proposal(init.runId, [{ start: secondFinding.start, end: secondFinding.end, before: 'slow', after: 'sluggish', reason: 'clarity' }], [secondFinding.id], 'clarity')
    ok(record(workspace, init.runPath, second, applied.afterHash, null))
    failure(
      call('apply', workspace, { runPath: init.runPath, proposalId: second.id, expectedBodyHash: applied.afterHash }),
      'BUDGET_EXHAUSTED',
      4,
    )
    const status = statusOf(workspace, init.runPath)
    expect(status.languagePass).toBe(1)
    expect(status.languageIntentsUsed).toEqual(['clarity'])
  })
})

describe('crash recovery', () => {
  it('ignores an orphan artifact and keeps the lock blocking another writer', () => {
    const workspace = makeWorkspace()
    const { init, snapshot, body } = editRun(workspace)
    const orphan = review(init.runId, body, 'language')
    writeFileSync(join(workspace, init.runPath, 'reviews', `${orphan.id}.json`), `${JSON.stringify(orphan, null, 2)}\n`)
    const status = statusOf(workspace, init.runPath)
    expect(status.phase).toBe('initialized')
    expect(status.orphanArtifacts.map((entry: any) => entry.path)).toContain(`${init.runPath}/reviews/${orphan.id}.json`)

    writeFileSync(join(workspace, init.runPath, 'lock'), `${JSON.stringify({ pid: 999999, createdAt: new Date().toISOString() })}\n`)
    const locked = failure(call('snapshot', workspace, { runPath: init.runPath }), 'LOCKED', 3)
    expect(locked.details.lockPath).toContain('lock')
    expect(existsSync(join(workspace, init.runPath, 'lock'))).toBe(true)
    expect(statusOf(workspace, init.runPath).phase).toBe('initialized')
    expect(readBody(workspace)).toBe(body)
    rmSync(join(workspace, init.runPath, 'lock'))
    ok(call('snapshot', workspace, { runPath: init.runPath }))
    expect(snapshot.hash).toBeTypeOf('string')
  })

  it('keeps the reservation and the body when the rename cannot complete', () => {
    const workspace = makeWorkspace()
    const { init, snapshot, body } = editRun(workspace)
    const clarityFinding = finding(body, 'may')
    ok(record(workspace, init.runPath, review(init.runId, body, 'language', { findings: [clarityFinding] }), snapshot.hash, null))
    const proposed = proposal(init.runId, [{ start: clarityFinding.start, end: clarityFinding.end, before: 'may', after: 'can', reason: 'clarity' }], [clarityFinding.id], 'clarity')
    ok(record(workspace, init.runPath, proposed, snapshot.hash, null))
    chmodSync(join(workspace, 'docs/articles'), 0o500)
    const crashed = call('apply', workspace, { runPath: init.runPath, proposalId: proposed.id, expectedBodyHash: snapshot.hash })
    chmodSync(join(workspace, 'docs/articles'), 0o700)
    failure(crashed, 'IO_ERROR', 5)
    expect(readBody(workspace)).toBe(body)
    const run = runJson(workspace, init.runPath)
    expect(run.languagePass).toBe(1)
    expect(run.appliedProposals).toHaveLength(1)
  })
})

describe('counter refunds', () => {
  it('never decrements on restore and consumes nothing for unapplied proposals', () => {
    const workspace = makeWorkspace()
    const { init, snapshot, body } = editRun(workspace)
    const findings = [finding(body, 'may'), finding(body, 'slow')]
    ok(record(workspace, init.runPath, review(init.runId, body, 'language', { findings }), snapshot.hash, null))
    const proposed = proposal(init.runId, [{ start: findings[0].start, end: findings[0].end, before: 'may', after: 'can', reason: 'clarity' }], [findings[0].id], 'clarity')
    ok(record(workspace, init.runPath, proposed, snapshot.hash, null))
    // Recorded but unapplied: no counter moved.
    expect(statusOf(workspace, init.runPath).languagePass).toBe(0)

    const applied = ok(call('apply', workspace, { runPath: init.runPath, proposalId: proposed.id, expectedBodyHash: snapshot.hash }))
    expect(applied.languagePass).toBe(1)
    // The rejected candidate snapshot stays; restore returns to the accepted baseline.
    expect(existsSync(join(workspace, init.runPath, 'snapshots', `${applied.afterHash}.md`))).toBe(true)
    const restored = ok(call('restore', workspace, {
      runPath: init.runPath,
      snapshotHash: snapshot.hash,
      expectedBodyHash: applied.afterHash,
    }))
    expect(restored.languagePass).toBe(1)
    expect(readBody(workspace)).toBe(body)
    expect(statusOf(workspace, init.runPath).languagePass).toBe(1)
    expect(existsSync(join(workspace, init.runPath, 'snapshots', `${applied.afterHash}.md`))).toBe(true)
  })
})

describe('filesystem safety', () => {
  it('rejects traversal, escaping symlinks, unsupported schemas, and invalid UTF-8', () => {
    const workspace = makeWorkspace()
    const { init, snapshot } = editRun(workspace)
    failure(call('status', workspace, { runPath: '../escape' }), 'PATH_OUTSIDE_WORKSPACE', 2)
    failure(call('status', workspace, { runPath: '/etc' }), 'PATH_OUTSIDE_WORKSPACE', 2)

    failure(record(workspace, init.runPath, { ...writePlan(init.runId), schemaVersion: 2 }, snapshot.hash, null), 'INVALID_INPUT', 2)

    const body = readBody(workspace)
    const invalid = Buffer.from([0xff, 0xfe, 0x00, 0x41])
    writeFileSync(bodyPath(workspace), invalid)
    failure(call('snapshot', workspace, { runPath: init.runPath }), 'INVALID_INPUT', 2)
    expect(readFileSync(bodyPath(workspace))).toEqual(invalid)

    writeFileSync(bodyPath(workspace), body)

    const outside = mkdtempSync(join(tmpdir(), 'writing-outside-'))
    directories.push(outside)
    const link = join(workspace, 'docs/articles/escaped.writing')
    symlinkSync(outside, link)
    const linked = call('init', workspace, {
      brief: brief(workspace, { companionPath: 'docs/articles/escaped.writing' }),
      replaceExisting: false,
    })
    failure(linked, 'PATH_OUTSIDE_WORKSPACE', 2)
    expect(readBody(workspace)).toBe(body)
  })
})

describe('resume and brief immutability', () => {
  it('resumes matching versions and reports a changed brief as STALE_BRIEF', () => {
    const workspace = makeWorkspace()
    const init = initRun(workspace, {})
    const body = '# Cause\n\nKeys expire early.\n'
    writeFileSync(bodyPath(workspace), body)
    const snapshot = ok(call('snapshot', workspace, { runPath: init.runPath }))
    ok(record(workspace, init.runPath, writePlan(init.runId), snapshot.hash, null))
    const resumed = statusOf(workspace, init.runPath)
    expect(resumed.nextStage).toBe('context')
    expect(resumed.stale.brief).toBe(false)

    const briefFile = join(workspace, init.runPath, 'brief.json')
    const stored = JSON.parse(readFileSync(briefFile, 'utf8'))
    writeFileSync(briefFile, `${JSON.stringify({ ...stored, audience: 'Changed audience' }, null, 2)}\n`)
    failure(record(workspace, init.runPath, contextArtifact(init.runId), snapshot.hash, resumed.planHash), 'STALE_BRIEF', 3)
    expect(statusOf(workspace, init.runPath).stale.brief).toBe(true)
  })
})

function completeEdit(workspace: string) {
  const original = 'The cache may miss under load.\n\nIt is slow.\n'
  writeFileSync(bodyPath(workspace), original)
  const init = initRun(workspace, { operation: 'edit', repairRounds: 0 })
  const snapshot = ok(call('snapshot', workspace, { runPath: init.runPath }))
  const clarityFinding = finding(original, 'may')
  ok(record(workspace, init.runPath, review(init.runId, original, 'language', { findings: [clarityFinding] }), snapshot.hash, null))
  const proposed = proposal(init.runId, [{ start: clarityFinding.start, end: clarityFinding.end, before: 'may', after: 'can', reason: 'clarity' }], [clarityFinding.id], 'clarity')
  ok(record(workspace, init.runPath, proposed, snapshot.hash, null))
  const applied = ok(call('apply', workspace, { runPath: init.runPath, proposalId: proposed.id, expectedBodyHash: snapshot.hash }))
  const finalText = readBody(workspace)
  ok(record(workspace, init.runPath, review(init.runId, finalText, 'language'), applied.afterHash, null))
  const compared = ok(call('compare', workspace, { runPath: init.runPath, beforeHash: snapshot.hash, afterHash: applied.afterHash }))
  const semantics = review(init.runId, finalText, 'semantics')
  ok(record(workspace, init.runPath, semantics, applied.afterHash, null))
  ok(record(workspace, init.runPath, {
    schemaVersion: 1,
    kind: 'check',
    id: randomUUID(),
    runId: init.runId,
    mechanicalStatus: compared.mechanicalStatus,
    semanticStatus: 'no-issue-found',
    changes: compared.changes,
    semanticReviewId: semantics.id,
  }, applied.afterHash, null))
  return { init, snapshot, applied, finalText }
}

describe('link and report metadata', () => {
  it('persists host metadata and includes it in the report', () => {
    const workspace = makeWorkspace()
    const { init, applied } = completeEdit(workspace)
    const linked = ok(call('link', workspace, {
      runPath: init.runPath,
      model: 'deepseek-test-model',
      usage: { inputTokens: 12, outputTokens: 34 },
      vwa: { projectId: 'proj-1', authorRevision: 2, artifactId: null, runId: null, taskId: null, reportPath: 'vwa-report.md' },
    }))
    expect(linked.model).toBe('deepseek-test-model')
    const finalized = ok(call('finalize', workspace, { runPath: init.runPath, expectedBodyHash: applied.afterHash }))
    expect(finalized.editorialOutcome).toBe('checked-no-major-findings')
    const report = readFileSync(reportPath(workspace, init.runPath), 'utf8')
    expect(report).toContain('deepseek-test-model')
    expect(report).toContain('vwa-report.md')
    expect(report).toContain('inputTokens')
    const run = runJson(workspace, init.runPath)
    expect(run.model).toBe('deepseek-test-model')
    expect(run.usage).toEqual({ inputTokens: 12, outputTokens: 34 })
  })

  it('records cancellation without claiming checked completion', () => {
    const workspace = makeWorkspace()
    const { init, snapshot } = editRun(workspace)
    const cancelled = ok(call('finalize', workspace, { runPath: init.runPath, expectedBodyHash: snapshot.hash, cancelled: true }))
    expect(cancelled.outcome).toBe('cancelled')
    expect(runJson(workspace, init.runPath).outcome).toBe('cancelled')
    expect(existsSync(reportPath(workspace, init.runPath))).toBe(true)
    expect(readFileSync(reportPath(workspace, init.runPath), 'utf8')).toContain('incomplete')
  })
})

describe('CLI process boundary', () => {
  const script = fileURLToPath(new URL('../skills/writing-workflow/scripts/writing.mjs', import.meta.url))

  function spawnCli(workspace: string, command: string, input: unknown, extra: string[] = []) {
    const inputFile = join(workspace, '.input.json')
    writeFileSync(inputFile, `${JSON.stringify(input, null, 2)}\n`)
    return spawnSync(process.execPath, [script, command, '--workspace', workspace, '--input', inputFile, ...extra], {
      encoding: 'utf8',
    })
  }

  it('maps exit codes and prints one JSON object', () => {
    const workspace = makeWorkspace()
    writeFileSync(bodyPath(workspace), 'Body text.\n')
    const init = initRun(workspace, { operation: 'review', allowBodyChanges: false })

    const invalid = spawnCli(workspace, 'nope', { runPath: init.runPath })
    expect(invalid.status).toBe(2)
    expect(JSON.parse(invalid.stdout).code).toBe('INVALID_INPUT')

    const badOption = spawnSync(process.execPath, [script, 'status', '--workspace', workspace, '--input', 'x', '--bogus', 'y'], {
      encoding: 'utf8',
    })
    expect(badOption.status).toBe(2)

    writeFileSync(join(workspace, init.runPath, 'lock'), '{}\n')
    const locked = spawnCli(workspace, 'snapshot', { runPath: init.runPath })
    expect(locked.status).toBe(3)
    expect(JSON.parse(locked.stdout).code).toBe('LOCKED')
    rmSync(join(workspace, init.runPath, 'lock'))

    const incomplete = spawnCli(workspace, 'finalize', { runPath: init.runPath, expectedBodyHash: init.bodyHash })
    expect(incomplete.status).toBe(4)
    const envelope = JSON.parse(incomplete.stdout)
    expect(envelope.code).toBe('REVIEW_INCOMPLETE')
    expect(envelope.details.reportPath).toBeTypeOf('string')
  })
})
