# Code anchors for background-task-lifecycle

Verbatim excerpts from the cited production and test files, captured at worktree
commit 51bc5846 and refreshed for the issue #336 lock-release fix (src/index.ts,
src/lock.ts and the affected tests). Each section is the exact content of the
cited line range; this file is the citable evidence target (the validator
whitelist admits *.md only, so code citations are recorded here verbatim).

## packages/memory/memory-consolidation/src/index.ts L8-L12

```
 * MEMORY.md and the topic files. The forks hold no write tools — the memory
 * directory sits outside the session workspace, so the fs sandbox would fence
 * every model-side write with no escalation path from a background job; the
 * plugin validates each reported batch and writes it host-side under a
 * per-call policy confined to the memory directory (see `writeback.ts`). A
```

## packages/memory/memory-consolidation/src/index.ts L182-L184

```
        void runDream(ctx, agent, home, provider, minHours, minSessions, pressureCooldownMinutes, sessionsRoot, scan)
          .catch((err) => { ctx.logger.warn(`memory-consolidation: dream dispatch failed: ${String(err)}`) })
          .finally(() => { dreamInFlight = false })
```

## packages/memory/memory-consolidation/src/index.ts L343-L343

```
  const priorAt = await tryAcquireLock(fs, dir, process.pid, now, policy)
```

## packages/memory/memory-consolidation/src/index.ts L363-L363

```
    void job.done.then(async (outcome) => {
```

## packages/memory/memory-consolidation/src/index.ts L363-L429

```
    void job.done.then(async (outcome) => {
      ctx.logger.debug({ event: 'memory:dream-outcome', status: outcome.status, detail: outcome.status === 'failed' ? outcome.detail : undefined })
      if (outcome.status === 'completed') {
        // Success releases the lock BEFORE clearing the marker (issue #336),
        // and AWAITs it: void fire-and-forget chains interleave, so only an
        // awaited release guarantees the marker clear never lands first. A
        // crash between the two writes then leaves an armed marker with a
        // free lock — the next cooldown window retries, which is
        // conservative. The reverse order would leave the marker tombstoned
        // with the lock still stamped: the exact stale-window delay this fix
        // removes. The release is guarded (skipped when a reclaimer took the
        // file mid-dream) and best-effort (failures are swallowed inside).
        await releaseLock(fs, dir, process.pid, now, policy)
        // Success tombs the marker in BOTH modes — but only the arms this
        // dream's rebuild addressed (issue #335 Face B): the clear is
        // conditional on `pressure.armedAt` (captured at the dream's initial
        // read, which the fork's index snapshot postdates), so an arm that
        // landed during the dream survives for the next window. The cooldown
        // reference advances to completion time, not dream start.
        void clearPressure(fs, dir, Date.now(), policy, pressure.armedAt)
        return
      }
      await recordDreamDiagnostic(ctx, fs, dir, policy, {
        sessionId,
        phase: 'outcome-failed',
        detail: outcome.status === 'failed' ? outcome.detail : outcome.status,
      })
      // One bounded retry (design 2026-09-24 §4.2): only a FAILED outcome
      // respawns — `killed` is an intentional abort (session teardown /
      // controller.abort) and must never respawn. The retry reuses the held
      // lock (no re-acquire) and does not restamp the pressure marker. The
      // whole retry block gets its OWN try/catch mirroring the dispatch-throw
      // branch: a throw inside the retry must never strand the lock.
      if (outcome.status !== 'failed') {
        void rollbackLock(fs, dir, process.pid, now, priorAt, policy)
        return
      }
      try {
        const retry = await startMemoryJob(ctx, agent, dir, provider, 'memory-consolidation', prompt, baselineIndex)
        void retry.done.then(async (retryOutcome) => {
          ctx.logger.debug({ event: 'memory:dream-outcome', retry: true, status: retryOutcome.status, detail: retryOutcome.status === 'failed' ? retryOutcome.detail : undefined })
          if (retryOutcome.status === 'completed') {
            // Same guarded, awaited release as the first attempt: the retry
            // reuses the ORIGINAL lock, so the same pid+epoch pair is still
            // ours to free.
            await releaseLock(fs, dir, process.pid, now, policy)
            // Same conditional clear as the first attempt: the retry reuses
            // the ORIGINAL captured arm (the retry's fork re-reads the
            // directory, so an arm older than a fresh capture is at worst
            // conservatively kept — an extra dream later, never a lost one).
            void clearPressure(fs, dir, Date.now(), policy, pressure.armedAt)
            return
          }
          await recordDreamDiagnostic(ctx, fs, dir, policy, {
            sessionId,
            phase: 'outcome-failed',
            detail: `retry ${retryOutcome.status === 'failed' ? retryOutcome.detail : retryOutcome.status}`,
          })
          void rollbackLock(fs, dir, process.pid, now, priorAt, policy)
        })
      } catch (err) {
        const detail = err instanceof Error && err.stack ? `${String(err)}\n${err.stack}` : String(err)
        await recordDreamDiagnostic(ctx, fs, dir, policy, { sessionId, phase: 'outcome-failed', detail: `retry ${detail}` })
        await rollbackLock(fs, dir, process.pid, now, priorAt, policy)
        ctx.logger.warn(`memory-consolidation: dream retry failed: ${detail}`)
      }
    })
```

## packages/memory/memory-consolidation/src/index.ts L390-L396

```
      // One bounded retry (design 2026-09-24 §4.2): only a FAILED outcome
      // respawns — `killed` is an intentional abort (session teardown /
      // controller.abort) and must never respawn. The retry reuses the held
      // lock (no re-acquire) and does not restamp the pressure marker. The
      // whole retry block gets its OWN try/catch mirroring the dispatch-throw
      // branch: a throw inside the retry must never strand the lock.
      if (outcome.status !== 'failed') {
```

## packages/memory/memory-consolidation/src/index.ts L401-L401

```
        const retry = await startMemoryJob(ctx, agent, dir, provider, 'memory-consolidation', prompt, baselineIndex)
```

## packages/memory/memory-consolidation/src/index.ts L423-L427

```
      } catch (err) {
        const detail = err instanceof Error && err.stack ? `${String(err)}\n${err.stack}` : String(err)
        await recordDreamDiagnostic(ctx, fs, dir, policy, { sessionId, phase: 'outcome-failed', detail: `retry ${detail}` })
        await rollbackLock(fs, dir, process.pid, now, priorAt, policy)
        ctx.logger.warn(`memory-consolidation: dream retry failed: ${detail}`)
```

## packages/memory/memory-consolidation/src/lock.ts L84-L129

```
export async function tryAcquireLock(
  fs: FileSystem,
  dir: string,
  pid: number,
  now: number,
  policy?: MemoryWritePolicy,
): Promise<number | null> {
  const { target, absent } = await lockTarget(fs, dir)
  let priorAt = 0
  if (!absent) {
    try {
      const { pid: holder, at } = parse(await fs.readText(target))
      priorAt = at
      // Issue #336: a RELEASED lock (holder PID 0) is free regardless of its
      // epoch — a completed dream keeps the epoch (it is lastConsolidatedAt,
      // which the periodic time gate still reads) but no holder. Only a
      // recorded holder blocks acquisition, until the stale window reclaims
      // it (a crash or PID reuse). A malformed holder line (undefined) is
      // treated as an unknown holder and keeps blocking while fresh; a
      // malformed EPOCH (at = 0) with a recorded holder is reclaimed at
      // once — the guard needs a positive epoch to block.
      if (holder !== 0 && at > 0 && now - at < LOCK_STALE_MS) {
        // A recently stamped lock is held; the stale window reclaims crashed holders.
        return null
      }
    } catch {
      // Unreadable or malformed lock: reclaim below, treating it as empty.
    }
  }
  await fs.writeText(target, format(pid, now), undefined, undefined, policy)
  // Read the lock back once to verify we own it. If the content is not EXACTLY
  // ours, a cross-process writer interleaved between our read and write and we
  // lost the race. This narrows the TOCTOU window to a sub-millisecond
  // symmetric-collision; the residual race is accepted (the stale-window
  // reclaim handles crashes, and the worst case is a redundant MEMORY.md
  // rewrite bounded by minHours). A read-back THROW is treated as a
  // verify-failure too (conservative).
  let owned = false
  try {
    owned = (await fs.readText(target)) === format(pid, now)
  } catch {
    owned = false
  }
  if (!owned) return null
  return priorAt
}
```

## packages/memory/memory-consolidation/src/lock.ts L84-L187

```
export async function tryAcquireLock(
  fs: FileSystem,
  dir: string,
  pid: number,
  now: number,
  policy?: MemoryWritePolicy,
): Promise<number | null> {
  const { target, absent } = await lockTarget(fs, dir)
  let priorAt = 0
  if (!absent) {
    try {
      const { pid: holder, at } = parse(await fs.readText(target))
      priorAt = at
      // Issue #336: a RELEASED lock (holder PID 0) is free regardless of its
      // epoch — a completed dream keeps the epoch (it is lastConsolidatedAt,
      // which the periodic time gate still reads) but no holder. Only a
      // recorded holder blocks acquisition, until the stale window reclaims
      // it (a crash or PID reuse). A malformed holder line (undefined) is
      // treated as an unknown holder and keeps blocking while fresh; a
      // malformed EPOCH (at = 0) with a recorded holder is reclaimed at
      // once — the guard needs a positive epoch to block.
      if (holder !== 0 && at > 0 && now - at < LOCK_STALE_MS) {
        // A recently stamped lock is held; the stale window reclaims crashed holders.
        return null
      }
    } catch {
      // Unreadable or malformed lock: reclaim below, treating it as empty.
    }
  }
  await fs.writeText(target, format(pid, now), undefined, undefined, policy)
  // Read the lock back once to verify we own it. If the content is not EXACTLY
  // ours, a cross-process writer interleaved between our read and write and we
  // lost the race. This narrows the TOCTOU window to a sub-millisecond
  // symmetric-collision; the residual race is accepted (the stale-window
  // reclaim handles crashes, and the worst case is a redundant MEMORY.md
  // rewrite bounded by minHours). A read-back THROW is treated as a
  // verify-failure too (conservative).
  let owned = false
  try {
    owned = (await fs.readText(target)) === format(pid, now)
  } catch {
    owned = false
  }
  if (!owned) return null
  return priorAt
}

/**
 * Release the lock after a SUCCESSFUL consolidation (issue #336): the holder
 * PID is cleared while the acquisition epoch is kept — the epoch doubles as
 * lastConsolidatedAt and the periodic time gate still reads it. The write is
 * guarded by a read-verify: if the file no longer carries exactly this
 * holder+epoch (a stale-window reclaimer took it mid-dream), the release is
 * skipped — the current holder owns the file. Best-effort: failures are
 * swallowed so the caller's teardown does not throw.
 * @param fs - the filesystem seam.
 * @param dir - the memory directory holding the lock.
 * @param pid - the process id that acquired the lock.
 * @param at - the acquisition epoch the lock was stamped with.
 * @param policy - per-call sandbox policy for the lock write (see tryAcquireLock).
 */
export async function releaseLock(
  fs: FileSystem,
  dir: string,
  pid: number,
  at: number,
  policy?: MemoryWritePolicy,
): Promise<void> {
  const target = await fs.resolve(join(dir, LOCK_FILE)).catch(() => undefined)
  if (target === undefined) return
  try {
    if ((await fs.readText(target)) !== format(pid, at)) return
  } catch {
    return
  }
  await fs.writeText(target, format(0, at), undefined, undefined, policy).catch(() => {})
}

/**
 * Roll the lock back to `priorAt` after a failed or killed consolidation.
 * A `priorAt` of 0 encodes the no-file state (the next read returns 0) with
 * the holder PID cleared. The write carries the same guarded read-verify as
 * `releaseLock` (issue #336): it runs only when the file still holds exactly
 * `pid`/`at` — a stale-window reclaimer that took the lock mid-dream owns it,
 * and a rollback that clobbered it would free a lock under a live dreamer
 * (holder 0 is free by definition). Best-effort: failures are swallowed so
 * the caller's teardown does not throw.
 * @param fs - the filesystem seam.
 * @param dir - the memory directory holding the lock.
 * @param pid - the process id that acquired the lock.
 * @param at - the acquisition epoch the lock was stamped with.
 * @param priorAt - the pre-acquire consolidated epoch to restore.
 * @param policy - per-call sandbox policy for the lock write (see tryAcquireLock).
 */
export async function rollbackLock(fs: FileSystem, dir: string, pid: number, at: number, priorAt: number, policy?: MemoryWritePolicy): Promise<void> {
  const target = await fs.resolve(join(dir, LOCK_FILE)).catch(() => undefined)
  if (target === undefined) return
  try {
    if ((await fs.readText(target)) !== format(pid, at)) return
  } catch {
    return
  }
  await fs.writeText(target, format(0, priorAt), undefined, undefined, policy).catch(() => {})
}
```

## packages/memory/memory-consolidation/src/lock.ts L114-L120

```
  // Read the lock back once to verify we own it. If the content is not EXACTLY
  // ours, a cross-process writer interleaved between our read and write and we
  // lost the race. This narrows the TOCTOU window to a sub-millisecond
  // symmetric-collision; the residual race is accepted (the stale-window
  // reclaim handles crashes, and the worst case is a redundant MEMORY.md
  // rewrite bounded by minHours). A read-back THROW is treated as a
  // verify-failure too (conservative).
```

## packages/memory/memory-consolidation/src/lock.ts L162-L187

```
/**
 * Roll the lock back to `priorAt` after a failed or killed consolidation.
 * A `priorAt` of 0 encodes the no-file state (the next read returns 0) with
 * the holder PID cleared. The write carries the same guarded read-verify as
 * `releaseLock` (issue #336): it runs only when the file still holds exactly
 * `pid`/`at` — a stale-window reclaimer that took the lock mid-dream owns it,
 * and a rollback that clobbered it would free a lock under a live dreamer
 * (holder 0 is free by definition). Best-effort: failures are swallowed so
 * the caller's teardown does not throw.
 * @param fs - the filesystem seam.
 * @param dir - the memory directory holding the lock.
 * @param pid - the process id that acquired the lock.
 * @param at - the acquisition epoch the lock was stamped with.
 * @param priorAt - the pre-acquire consolidated epoch to restore.
 * @param policy - per-call sandbox policy for the lock write (see tryAcquireLock).
 */
export async function rollbackLock(fs: FileSystem, dir: string, pid: number, at: number, priorAt: number, policy?: MemoryWritePolicy): Promise<void> {
  const target = await fs.resolve(join(dir, LOCK_FILE)).catch(() => undefined)
  if (target === undefined) return
  try {
    if ((await fs.readText(target)) !== format(pid, at)) return
  } catch {
    return
  }
  await fs.writeText(target, format(0, priorAt), undefined, undefined, policy).catch(() => {})
}
```

## packages/memory/memory-consolidation/src/memory-job.ts L117-L117

```
  const controller = new AbortController()
```

## packages/memory/memory-consolidation/src/memory-job.ts L122-L158

```
  const run = await startWithFilterResilience(subagents, provider, {
    label,
    signal: controller.signal,
    prompt: [{ type: 'text', text: prompt }],
    parent: agent,
    toolFilter: MEMORY_TOOL_FILTER,
    // Defense-in-depth recursion cap: the top-level listener already gates on
    // depth zero, so this fork's child never delegates. maxDepth is compared
    // against the CHILD's resolved depth (parent + 1); a top-level parent's
    // child resolves to 1 and passes, a grandchild to 2 is rejected.
    maxDepth: 1,
    outputSchema: MEMORY_WRITES_SCHEMA,
  }, logger) as { result: Promise<SubagentResultLike> }  // Real job-done wiring: `done` maps the subagent outcome onto the JobHooks
  // contract (must never reject). Aborted → killed (rolls back the dream
  // lock); a non-completed stopReason, a missing/invalid payload, or a
  // write-back failure → failed with detail; a validated, persisted batch →
  // completed. All branches resolve.
  const done: Promise<JobOutcome> = run.result.then(
    async (res): Promise<JobOutcome> => {
      if (controller.signal.aborted) return { status: 'killed' }
      if (res?.stopReason !== 'completed') {
        return { status: 'failed', detail: `memory fork ended with stopReason ${String(res?.stopReason)}` }
      }
      if (fs === undefined) {
        return { status: 'failed', detail: 'fs seam unavailable for memory write-back' }
      }
      try {
        const writes = validateMemoryWrites(applyEntrypointFallback(res.structured))
        await writeMemoryFiles(fs, dir, writes)
        return { status: 'completed' }
      } catch (err) {
        return { status: 'failed', detail: String(err) }
      }
    },
    (err): JobOutcome =>
      controller.signal.aborted ? { status: 'killed' } : { status: 'failed', detail: String(err) },
  )
```

## packages/memory/memory-consolidation/src/memory-job.ts L139-L158

```
  const done: Promise<JobOutcome> = run.result.then(
    async (res): Promise<JobOutcome> => {
      if (controller.signal.aborted) return { status: 'killed' }
      if (res?.stopReason !== 'completed') {
        return { status: 'failed', detail: `memory fork ended with stopReason ${String(res?.stopReason)}` }
      }
      if (fs === undefined) {
        return { status: 'failed', detail: 'fs seam unavailable for memory write-back' }
      }
      try {
        const writes = validateMemoryWrites(applyEntrypointFallback(res.structured))
        await writeMemoryFiles(fs, dir, writes)
        return { status: 'completed' }
      } catch (err) {
        return { status: 'failed', detail: String(err) }
      }
    },
    (err): JobOutcome =>
      controller.signal.aborted ? { status: 'killed' } : { status: 'failed', detail: String(err) },
  )
```

## packages/memory/memory-consolidation/src/memory-job.ts L141-L141

```
      if (controller.signal.aborted) return { status: 'killed' }
```

## packages/memory/memory-consolidation/src/memory-job.ts L148-L154

```
      try {
        const writes = validateMemoryWrites(applyEntrypointFallback(res.structured))
        await writeMemoryFiles(fs, dir, writes)
        return { status: 'completed' }
      } catch (err) {
        return { status: 'failed', detail: String(err) }
      }
```

## packages/memory/memory-consolidation/src/memory-job.ts L165-L171

```
  let dispose: (() => void) | undefined
  try {
    dispose = agent.ctx.effect(() => async () => {
      controller.abort('agent disposed')
      await done.catch(() => {})
    }, 'memory-consolidation: cancel the fork on agent disposal')
  } catch { /* agent scope already disposing: the fork dies with it anyway */ }
```

## packages/memory/memory-consolidation/tests/dream-diagnostics.spec.ts L240-L276

```
  it('first attempt failed + retry completes: one lock acquire, two spawns, outcome-failed + success (marker cleared)', async () => {
    await seedFresh(tmpRoot, 5)
    const { ctx, subagents, fs } = mount()
    const spawnCount = { n: 0 }
    subagents.startActivation.mockImplementation(async () => {
      spawnCount.n += 1
      if (spawnCount.n === 1) return { childId: 'job-child', messageId: 'job-m', dispose: () => Promise.resolve(), result: Promise.resolve({ stopReason: 'error' }) }
      return {
        childId: 'job-child',
        messageId: 'job-m',
        dispose: () => Promise.resolve(),
        result: Promise.resolve({
          structured: { writes: [{ path: 'MEMORY.md', content: '# index\n' }, { path: 'topic-a.md', content: 'fact\n' }] },
          stopReason: 'completed',
        }),
      }
    })

    await stopTurn(ctx, fakeAgent('/mem'))
    await vi.waitFor(() => {
      expect(fs.backing.get(LOCK)).toMatch(/^0\n\d+\n$/)
      expect(diagnosticOf(fs).phase).toBe('outcome-failed')
    })
    // The write-back proves the retry completed the job (same lock, no re-acquire).
    expect(fs.backing.get(`${DIR}/MEMORY.md`)).toBe('# index\n')
    expect(fs.backing.get(`${DIR}/topic-a.md`)).toBe('fact\n')
    expect(fs.backing.get(DIAG)).toBeDefined()
    expect(subagents.startActivation).toHaveBeenCalledTimes(2) // one dispatch window, two spawn calls (attempt + retry)
    // Issue #336: the retry-success release keeps the acquisition epoch as
    // lastConsolidatedAt with the holder cleared (EXACT released bytes), and
    // an in-window acquire succeeds returning that epoch.
    const released = fs.backing.get(LOCK) ?? ''
    expect(released).not.toContain(String(process.pid))
    const acquireEpoch = Number(released.split('\n')[1])
    expect(acquireEpoch).toBeGreaterThan(0)
    expect(await tryAcquireLock(fs as never, DIR, process.pid, acquireEpoch + 1000, memoryWritePolicy(DIR))).toBe(acquireEpoch)
  })
```

## packages/memory/memory-consolidation/tests/dream-diagnostics.spec.ts L278-L291

```
  it('retry also fails: exactly two spawns, rollback, no third attempt', async () => {
    await seedFresh(tmpRoot, 5)
    const { ctx, subagents, fs } = mount()
    subagents.startActivation.mockImplementation(async () => ({ childId: 'job-child', messageId: 'job-m', dispose: () => Promise.resolve(), result: Promise.resolve({ stopReason: 'error' }) }))

    await stopTurn(ctx, fakeAgent('/mem'))
    await vi.waitFor(() => expect(fs.backing.get(LOCK)).toBe('0\n0\n'))

    expect(subagents.startActivation).toHaveBeenCalledTimes(2)
    const entry = diagnosticOf(fs)
    expect(entry.phase).toBe('outcome-failed')
    expect(String(entry.detail)).toContain('retry')
    expect(String(entry.detail)).toContain('stopReason error')
  })
```

## packages/memory/memory-consolidation/tests/dream-diagnostics.spec.ts L312-L312

```
  it('no retry on killed: exactly one spawn and a plain outcome-failed breadcrumb', async () => {
```

## packages/memory/memory-consolidation/tests/lock.spec.ts L270-L270

```
  it('a killed consolidation leaves the lock stale and reclaimable after the stale window', async () => {
```

## packages/memory/memory-consolidation/tests/memory-job-silence.spec.ts L96-L118

```

describe('per-agent disposal guarantee', () => {
  it('disposing the agent aborts the in-flight fork with the disposal reason and awaits its settle', async () => {
    const ctx = new Context()
    const pending = deferred<unknown>()
    const subagents = subagentsWith(pending.promise)
    ctx.provide('subagents' as never, subagents as never)
    ctx.provide('fs' as never, fsMock() as never)
    const { agent, disposers } = agentWithEffects()

    const job = await startMemoryJob(ctx, agent, '/mem', 'fork', 'extract-memories', 'prompt')
    expect(disposers.length).toBe(1)

    // Simulate agent-fiber disposal: run the registered teardown. It aborts
    // immediately but its promise settles only after the job's own settle.
    const teardown = disposers[0]!
    const teardownSettled = Promise.resolve(teardown()).then(() => 'teardown settled')
    expect(subagents.calls[0]!.signal.aborted).toBe(true)
    expect(subagents.calls[0]!.signal.reason).toBe('agent disposed')
    pending.reject(new Error('cancelled'))
    await expect(job.done).resolves.toEqual({ status: 'killed' })
    await expect(teardownSettled).resolves.toBe('teardown settled')
    // The done chain detached the effect: no accumulated disposers.
```

## packages/memory/memory-consolidation/tests/turn-stopping.spec.ts L267-L305

```
  it('job outcome: rejection maps to failed/killed; a completed run writes back and completes', async () => {
    // failed
    const a = mount({ memoryHome: '/tmp/mem', dreamEnabled: false })
    a.subagents.startActivation.mockImplementation(async () => ({ childId: 'job-child', messageId: 'job-m', dispose: () => Promise.resolve(), result: Promise.reject(new Error('boom')) }))
    await stopTurn(a.ctx, fakeAgent('/tmp'))
    await vi.waitFor(() => expect(startMemoryJob).toHaveBeenCalledTimes(1))
    const [failedDone] = await controlsOf('extract-memories')
    await expect(failedDone.done).resolves.toEqual({ status: 'failed', detail: 'Error: boom' })

    // completed: a valid structured report is written host-side.
    const b = mount({ memoryHome: '/tmp/mem', dreamEnabled: false })
    b.subagents.startActivation.mockImplementation(async () => ({
      childId: 'job-child',
      messageId: 'job-m',
      dispose: () => Promise.resolve(),
      result: Promise.resolve({
        structured: { writes: [{ path: 'user-profile.md', content: 'body' }] },
        stopReason: 'completed',
      }),
    }))
    await stopTurn(b.ctx, fakeAgent('/tmp'))
    await vi.waitFor(() => expect(startMemoryJob).toHaveBeenCalledTimes(1))
    const [completedDone] = await controlsOf('extract-memories')
    await expect(completedDone.done).resolves.toEqual({ status: 'completed' })
    // The write-back lands in the turning agent's workspace directory:
    // <home>/projects/<slug of the agent's cwd>.
    expect((b.fs as ReturnType<typeof makeFsMock>).backing.get('/tmp/mem/projects/tmp/user-profile.md')).toBe('body')

    // killed: aborted before the result rejects.
    const c = mount({ memoryHome: '/tmp/mem', dreamEnabled: false })
    const pending = deferred<unknown>()
    c.subagents.startActivation.mockImplementation(async () => ({ childId: 'job-child', messageId: 'job-m', dispose: () => Promise.resolve(), result: pending.promise }))
    await stopTurn(c.ctx, fakeAgent('/tmp'))
    await vi.waitFor(() => expect(startMemoryJob).toHaveBeenCalledTimes(1))
    const [cancellable] = await controlsOf('extract-memories')
    cancellable.abort('disposed')
    pending.reject(new Error('cancel'))
    await expect(cancellable.done).resolves.toEqual({ status: 'killed' })
  })
```

## packages/memory/memory-consolidation/tests/turn-stopping.spec.ts L295-L304

```
    // killed: aborted before the result rejects.
    const c = mount({ memoryHome: '/tmp/mem', dreamEnabled: false })
    const pending = deferred<unknown>()
    c.subagents.startActivation.mockImplementation(async () => ({ childId: 'job-child', messageId: 'job-m', dispose: () => Promise.resolve(), result: pending.promise }))
    await stopTurn(c.ctx, fakeAgent('/tmp'))
    await vi.waitFor(() => expect(startMemoryJob).toHaveBeenCalledTimes(1))
    const [cancellable] = await controlsOf('extract-memories')
    cancellable.abort('disposed')
    pending.reject(new Error('cancel'))
    await expect(cancellable.done).resolves.toEqual({ status: 'killed' })
```

