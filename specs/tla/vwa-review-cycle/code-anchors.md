# Code anchors: vwa-review-cycle model

Verbatim excerpts from `packages/interaction/vwa-argument/src/` at worktree commit c0224886 (base b2979b1e), captured by the read-back protocol recorded in the implementation record 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L36-L48〕. Line numbers below refer to the excerpt blocks in this file 〔src:ws:specs/tla/vwa-review-cycle/code-anchors.md#L1-L5〕.

## lock.ts — exclusive-create lock, dead-pid reclaim, torn file 〔src:ws:specs/tla/vwa-review-cycle/code-anchors.md#L7-L70〕

```ts
// lock.ts:25-38
const LOCK_WAIT_MS = 2000

/** One nonce per process stands in for the bootId (§14.2). */
const processNonce = randomUUID()

/** True when the pid is a live process (reclaim evidence). */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}
```

```ts
// lock.ts:52-95 (abridged: create window, dead-holder reclaim, torn file)
export function acquireLock(dir: string): Fail | undefined {
  const lockPath = join(dir, 'locks', 'write.lock')
  mkdirSync(dirname(lockPath), { recursive: true })
  const deadline = Date.now() + LOCK_WAIT_MS
  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx')
      try {
        const body: LockBody = { pid: process.pid, startedAt: new Date().toISOString(), nonce: processNonce }
        writeSync(fd, stableJson(body))
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      return undefined
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        return fail('STORE_IO_FAILED', `lock create failed: ${String(error)}`, true)
      }
    }
    let existing: LockBody | undefined
    try {
      existing = JSON.parse(readFileSync(lockPath, 'utf8')) as LockBody
    } catch {
      existing = undefined
    }
    // Dead holder → reclaim (never by timeout alone, §14.2).
    if (existing !== undefined && !pidAlive(existing.pid)) {
      try { unlinkSync(lockPath) } catch { /* raced; retry */ }
      continue
    }
    // Same-process holder (own nonce) → immediate self-deadlock report.
    if (existing !== undefined && existing.pid === process.pid && existing.nonce === processNonce) {
      return fail('LOCK_BUSY', 'another transaction in this process holds the write lock', true)
    }
    if (Date.now() >= deadline) {
      return fail('LOCK_BUSY', 'project write lock held', true)
    }
    // bounded spin then loop
  }
}
```

## lock.ts — best-effort release 〔src:ws:specs/tla/vwa-review-cycle/code-anchors.md#L72-L82〕

```ts
// lock.ts:97-102
/** Best-effort release (unlink the lock file). */
export function releaseLock(dir: string): void {
  try {
    unlinkSync(join(dir, 'locks', 'write.lock'))
  } catch { /* already gone */ }
}
```

## review-cycle.ts — synchronous budget lock, idempotent admission, revision conflict 〔src:ws:specs/tla/vwa-review-cycle/code-anchors.md#L84-L131〕

```ts
// review-cycle.ts:71-77
/**
 * The budget lock guards the cross-process cycle ledger. The callback
 * must be fully synchronous — no model calls or awaits while held.
 */
function withBudgetLock<T>(root: string, projectId: Id, body: () => T): T {
  const dir = join(root, '.dsh', 'vwa', projectId, 'review-budget')
  acquireLock(dir)
  try { return body() } finally { releaseLock(dir) }
}
```

```ts
// review-cycle.ts:181-227 (abridged: reserveCycleRequest)
export function reserveCycleRequest(
  root: string, projectId: Id, runId: Id, request: Request,
): CycleRequest | Fail {
  try {
    return withBudgetLock(root, projectId, () => {
      const store = new ReviewRunStore(root, projectId)
      const prior = store.readRequest(runId)
      const latest = latestCycle(requests(root, projectId))
      const identity = prior?.cycleId !== undefined
        ? { cycleId: prior.cycleId, cycleSequence: prior.cycleSequence ?? 0 }
        : request.continue === true
          ? latest
          : { cycleId: runId, cycleSequence: latest.cycleSequence + 1 }
      if (identity.cycleId === runId && request.budget !== undefined) {
        const headRevision = headRevisionOf(root, projectId)
        if (request.budgetRevision !== undefined && request.budgetRevision !== headRevision) {
          return fail('REVISION_CONFLICT', /* … */)
        }
        writeCycleBudget(root, projectId, runId, request.budget, request.budgetRevision ?? headRevision)
      }
      const { budget: _transport, budgetRevision: _source, ...record } = request
      const reserved = { ...record, ...identity, startedAt: prior?.startedAt ?? request.startedAt }
      store.reserveRequest(runId, reserved)
      return reserved
    })
  } catch (error) {
    if (error instanceof VwaFail) return error.fail
    return fail('STORE_IO_FAILED', `review cycle admission failed: ${String(error)}`, true)
  }
}
```

## review-cycle.ts — cycle spend and one-critical-section reservation 〔src:ws:specs/tla/vwa-review-cycle/code-anchors.md#L133-L162〕

```ts
// review-cycle.ts:235-245
export function cycleUsage(root: string, projectId: Id, excludeRunId?: Id, cycleId?: Id): CycleUsage {
  const all = requests(root, projectId)
  const own = all.find((r) => r.runId === excludeRunId)
  const selected = cycleId ?? (own ? own.cycleId ?? LEGACY_CYCLE : latestCycle(all).cycleId)
  return all.filter((r) => r.runId !== excludeRunId && (r.cycleId ?? LEGACY_CYCLE) === selected)
    .reduce<CycleUsage>((sum, r) => ({ calls: sum.calls + r.calls, /* …tokens… */ }), { calls: 0, /* … */ })
}
```

```ts
// review-cycle.ts:247-274 (abridged: reserveCycleCall — check and reserve in one critical section)
export function reserveCycleCall(
  root: string, projectId: Id, cycleId: Id, budget: ReviewBudget, inputTokens: number,
  reserve: () => boolean,
): boolean {
  return withBudgetLock(root, projectId, () => {
    const cycleBudget = readCycleBudget(root, projectId, cycleId) ?? budget
    const used = cycleUsage(root, projectId, undefined, cycleId)
    if (used.calls + 1 > cycleBudget.maxCallsPerRun ||
        used.inputTokens + inputTokens > cycleBudget.maxInputTokensPerRun /* …output headroom… */) {
      return false
    }
    return reserve()
  })
}
```

## review-run-store.ts — restart rule, durable ledger, atomic writes 〔src:ws:specs/tla/vwa-review-cycle/code-anchors.md#L164-L212〕

```ts
// review-run-store.ts:118-157 (abridged)
/** Persist a reservation before the host can schedule the callback. */
reserveRequest(runId: string, request: …): void {
  this.initRun(runId)
  this.writeRequest(runId, { ...request, processId: process.pid, processNonce: PROCESS_NONCE })
}

/** §14.3 restart rule: a persisted `running` run becomes `incomplete` on load. */
loadRequest(runId: string): … | undefined {
  let request = this.readRequest(runId)
  if (request) {
    const usage = this.readUsage(runId)
    const attempts = new Map<string, UsageRow>()
    for (const row of usage)
      if (row.kind !== 'reused' && (row.inputTokens > 0 || row.outputTokens > 0))
        attempts.set(`${row.taskId}:${row.seq}`, row)
    request = { ...request, calls: Math.max(request.calls, attempts.size), /* …token max… */ }
  }
  if (request?.status === 'running' || request?.status === 'queued') {
    let alive = request.processId === process.pid && request.processNonce === PROCESS_NONCE
    if (request.processId !== undefined && request.processId !== process.pid) {
      try { process.kill(request.processId, 0); alive = true } catch { alive = false }
    }
    if (!alive) return { ...request, status: 'incomplete' }
  }
  return request
}
```

```ts
// review-run-store.ts:226-249 (abridged: append-only usage ledger; atomic write)
appendUsage(runId: string, row: UsageRow): void {
  mkdirSync(this.runDir(runId), { recursive: true })
  const line = stableJson(row)
  const fd = openSync(join(this.runDir(runId), 'usage.jsonl'), 'a')
  try { writeSync(fd, `${line}\n`); fsyncSync(fd) } finally { closeSync(fd) }
}

private writeAtomic(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true })
  const tmp = `${path}.tmp`
  const fd = openSync(tmp, 'w')
  try { writeSync(fd, stableJson(value)); fsyncSync(fd) } finally { closeSync(fd) }
  renameSync(tmp, path)
}
```

## review-call.ts — retry pool: charge at decision, earn at reservation, refund otherwise 〔src:ws:specs/tla/vwa-review-cycle/code-anchors.md#L214-L245〕

```ts
// review-call.ts:98-149 (abridged)
// F1.4 correction: a retry unit is charged at the retry DECISION but is
// only earned when the retry actually reserves and dispatches. Every exit
// between the charge and that reservation refunds the unit.
let chargedRetryUnit = false
const refundRetryUnit = () => {
  if (chargedRetryUnit) {
    if (this.poolUnits !== undefined) this.poolUnits += 1
    chargedRetryUnit = false
  }
}
// … context overflow → refundRetryUnit(); counting failure → refundRetryUnit();
// budget refusal → refundRetryUnit(); then throw
// The attempt is committed (reserved, dispatch follows): the charged unit is earned.
chargedRetryUnit = false
```

```ts
// review-call.ts:201-209 (abridged)
// F1.4: the pool is checked and debited synchronously (same tick, before
// the retry dispatch, no await between check and debit) so concurrent
// tasks in a Promise.allSettled batch cannot both claim the last unit.
if (this.poolUnits !== undefined) {
  if (this.poolUnits <= 0)
    throw this.attach(new ReviewRetryBudgetError(RETRY_BUDGET_ADVICE), attempts)
  this.poolUnits -= 1
  chargedRetryUnit = true
}
```

## review-call.ts — reservation inside the lock precedes dispatch 〔src:ws:specs/tla/vwa-review-cycle/code-anchors.md#L247-L263〕

```ts
// review-call.ts:127-147 (abridged)
// Local counters and the durable ledger row must be updated inside the
// shared cycle lock, before another run can observe the available spend.
const reserve = () => {
  if (!this.tracker.reserve(counted.tokens)) return false
  const seq = this.tracker.calls
  this.usage({ taskId, seq, kind: 'reserved', /* …tokens, method… */ })
  return true
}
if (!(this.reserveShared ? this.reserveShared(counted.tokens, reserve) : reserve())) {
  refundRetryUnit()
  throw this.attach(new ReviewBudgetError('review budget exhausted'), attempts)
}
```

## review-continue.ts — reusable record: completed, key-matched, never a disagreement copy 〔src:ws:specs/tla/vwa-review-cycle/code-anchors.md#L265-L274〕

```ts
// review-continue.ts:190-207 (abridged)
reusableRecord(…) {
  // never a kind:'disagreement' copy
  // non-continue → first eligible from the same requestId's runs
  // continue → newest endedAt, tie-break by sha256(stableJson(record)) ascending
}
```

## review-runner.ts — default mode never reuses; continuation copies without spending calls 〔src:ws:specs/tla/vwa-review-cycle/code-anchors.md#L276-L284〕

```ts
// review-runner.ts:259-271, 323-336 (abridged)
// Audit reuse only in continue mode; the default mode never reuses
// (second opinion).
// ApplyReuse: save({...reusable, runId}) — a new record copy under the
// current run — plus a zero-token 'reused' usage row in continue mode.
```

## review-request.ts — one run per requestId 〔src:ws:specs/tla/vwa-review-cycle/code-anchors.md#L286-L293〕

```ts
// review-request.ts:7-37 (abridged)
// Same requestId + different payloadHash → IDEMPOTENCY_CONFLICT;
// stored refusal replays; running/queued → {completion:'running'};
// completed → completed + records + result + usage; anything else → incomplete.
```

## types.ts — statuses and enums (verbatim) 〔src:ws:specs/tla/vwa-review-cycle/code-anchors.md#L295-L306〕

```ts
// types.ts:189
ReviewJobStatus = 'queued' | 'running' | 'completed' | 'incomplete' | 'cancelled' | 'budget-exhausted'
// types.ts:298,339 (per-record status)
'completed' | 'error' | 'cancelled' | 'budget-exhausted'
// types.ts:185
Verdict = 'pass' | 'fail' | 'needs-review' | 'not-run'
// review-run-store.ts:40 (UsageRow.kind)
'actual' | 'reserved' | 'reused' | 'repair' | 'error'
```
