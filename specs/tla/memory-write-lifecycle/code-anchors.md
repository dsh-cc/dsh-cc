# Code anchors — memory-write-lifecycle

Verbatim excerpts pinned to the current implementation. Each section carries a
self-citation so its range is checkable in this file. The runner's raw evidence
(`evidence.json`, `.formal-design/runs/**`) is intentionally gitignored; run
identities and per-case statistics are therefore recorded in
`implementation.md`.

## A1 — save: read the entrypoint, validate topic+pointer as one batch, then write topic-then-index 〔src:ws:specs/tla/memory-write-lifecycle/code-anchors.md#L9-L57〕

`packages/memory/memory/src/save.ts:199-240`

```ts
      let entrypoint = ''
      try {
        entrypoint = await fs.readText(await fs.resolve(join(dir, ENTRYPOINT_NAME)))
      } catch {
        // No index yet — the upsert starts from an empty body.
      }
      const trimmed = entrypoint.trim()
      const preExistingOverLimit = trimmed.split('\n').length > MAX_ENTRYPOINT_LINES
        || Buffer.byteLength(trimmed, 'utf8') > MAX_ENTRYPOINT_BYTES
      // Reuse the write-back validator so tool saves and fork reports share
      // one security boundary (filename rule + size caps + index gate). An
      // index that was ALREADY over-limit fail-opens: the save did not cause
      // the overflow, and rejecting would brick every save with no repair
      // path (a consolidation run compacts it instead).
      const validated = await (async () => {
        try {
          return validateMemoryWrites(
            {
              writes: [
                { path: filename, content: renderTopicFile(args) },
                { path: ENTRYPOINT_NAME, content: upsertPointer(entrypoint, args) },
              ],
            },
            { allowOverLimitEntrypoint: preExistingOverLimit },
          )
        } catch (error) {
          // Push-over rejection: arm the forced-dream marker. WORKSPACE scope
          // only on purpose — the global directory has no dream coverage, so
          // a marker there would be orphan state and the queued sentence a
          // lie. A swallowed arm failure rethrows the original error.
          if (
            error instanceof Error && error.message.includes('would exceed its cap')
            && args.scope !== 'global'
            && await armPressure(fs, dir, Date.now(), memoryWritePolicy(dir))
          ) {
            throw new MemorySaveError(`${error.message}${QUEUED_SENTENCE}`)
          }
          throw error
        }
      })()
      await writeMemoryFiles(fs, dir, validated)
      await section.refresh(exec.agent)
```

## A2 — writeback: the shared gate and the sequential batch writer 〔src:ws:specs/tla/memory-write-lifecycle/code-anchors.md#L58-L102〕

`packages/memory/memory/src/writeback.ts:141-178`

```ts
  if (entrypoint !== undefined && opts?.allowOverLimitEntrypoint !== true) {
    const trimmed = entrypoint.content.trim()
    const lines = trimmed.split('\n').length
    const bytes = Buffer.byteLength(trimmed, 'utf8')
    if (lines > MAX_ENTRYPOINT_LINES || bytes > MAX_ENTRYPOINT_BYTES) {
      throw new Error(
        `${ENTRYPOINT_NAME} index would exceed its cap (${lines} lines / ${bytes} bytes; `
        + `limits: ${MAX_ENTRYPOINT_LINES} lines / ${MAX_ENTRYPOINT_BYTES} bytes). `
        + 'Rewrite the index to target under 140 lines, one line per entry: move detail into topic files, '
        + 'merge or drop stale entries. To update without growing the index, overwrite an existing memory '
        + "(same name); if this is not genuinely cross-workspace, save with scope 'workspace'.",
      )
    }
  }
  return writes
}

/**
 * Validate, then write the batch inside the memory directory under the
 * confined per-call policy. Writes are sequential so a mid-batch failure
 * leaves a deterministic prefix; the caller maps any throw to a failed job.
 * @param fs - the filesystem seam.
 * @param dir - the memory directory root.
 * @param writes - an already-validated batch (see {@link validateMemoryWrites}).
 * @returns the filenames written, in batch order.
 */
export async function writeMemoryFiles(
  fs: FileSystem,
  dir: string,
  writes: readonly MemoryWrite[],
): Promise<string[]> {
  const policy = memoryWritePolicy(dir)
  const written: string[] = []
  for (const { path, content } of writes) {
    const target = await fs.resolve(join(dir, path))
    await fs.writeText(target, content, undefined, undefined, policy)
    written.push(path)
  }
```

## A3 — lock: acquire = write + read-back verify; rollback restores the prior epoch 〔src:ws:specs/tla/memory-write-lifecycle/code-anchors.md#L103-L163〕

`packages/memory/memory-consolidation/src/lock.ts:71-124`

```ts
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
      const { at } = parse(await fs.readText(target))
      priorAt = at
      if (at > 0 && now - at < LOCK_STALE_MS) {
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
 * Roll the lock back to `priorAt` after a failed or killed consolidation.
 * A `priorAt` of 0 encodes the no-file state (the next read returns 0) with
 * the holder PID cleared. Best-effort: failures are swallowed so the caller's
 * teardown does not throw.
 * @param fs - the filesystem seam.
 * @param dir - the memory directory holding the lock.
 * @param priorAt - the pre-acquire consolidated epoch to restore.
 * @param policy - per-call sandbox policy for the lock write (see tryAcquireLock).
 */
export async function rollbackLock(fs: FileSystem, dir: string, priorAt: number, policy?: MemoryWritePolicy): Promise<void> {
  const target = await fs.resolve(join(dir, LOCK_FILE)).catch(() => undefined)
  if (target === undefined) return
  await fs.writeText(target, format(0, priorAt), undefined, undefined, policy).catch(() => {})
}
```

## A4 — pressure: read is fail-open, the arm is monotone, the stamp preserves the newer arm, the clear is conditional (issue #335 fix) 〔src:ws:specs/tla/memory-write-lifecycle/code-anchors.md#L164-L237〕

`packages/memory/memory/src/pressure.ts:47-61`

```ts
export async function readPressure(fs: FileSystem, dir: string): Promise<PressureState> {
  try {
    const { target, absent } = await pressureTarget(fs, dir)
    if (absent) return { armedAt: 0, lastForcedAt: 0 }
    return parse(await fs.readText(target))
  } catch {
    return { armedAt: 0, lastForcedAt: 0 }
  }
}
```

`packages/memory/memory/src/pressure.ts:63-130` (the monotone arm and the fixed writers' strict reader)

```ts
export async function armPressure(fs: FileSystem, dir: string, now: number, policy?: MemoryWritePolicy): Promise<boolean> {
  try {
    const { target, absent } = await pressureTarget(fs, dir)
    let lastForcedAt = 0
    let previousArmedAt = 0
    if (!absent) {
      try {
        const prev = parse(await fs.readText(target))
        lastForcedAt = prev.lastForcedAt
        previousArmedAt = prev.armedAt
      } catch {
        // Corrupt marker: treat as never-armed/never-forced, arming still proceeds.
      }
    }
    const armedAt = Math.max(now, previousArmedAt + 1)
    await fs.writeText(target, format(armedAt, lastForcedAt), undefined, undefined, policy)
    return true
  } catch {
    return false
  }
}

async function readMarkerStrict(fs: FileSystem, target: FsTarget): Promise<PressureState | null> {
  try {
    const match = /^(\d+)\n(\d+)\n?$/.exec(await fs.readText(target))
    return match === null ? null : { armedAt: Number(match[1]), lastForcedAt: Number(match[2]) }
  } catch {
    return null
  }
}
```

`packages/memory/memory/src/pressure.ts:133-175` (the fixed stamp and the conditional clear)

```ts
export async function markPressureForced(fs: FileSystem, dir: string, armedAt: number, now: number, policy?: MemoryWritePolicy): Promise<void> {
  const target = await fs.resolve(join(dir, PRESSURE_FILE)).catch(() => undefined)
  if (target === undefined) return
  const current = await readMarkerStrict(fs, target)
  const keep = current === null ? armedAt
    : current.armedAt === 0 ? 0
      : Math.max(armedAt, current.armedAt)
  await fs.writeText(target, format(keep, now), undefined, undefined, policy).catch(() => {})
}

export async function clearPressure(fs: FileSystem, dir: string, now: number, policy?: MemoryWritePolicy, servedArmedAt?: number): Promise<void> {
  const target = await fs.resolve(join(dir, PRESSURE_FILE)).catch(() => undefined)
  if (target === undefined) return
  const current = await readMarkerStrict(fs, target)
  if (current === null) return
  const armed = servedArmedAt !== undefined && current.armedAt > servedArmedAt ? current.armedAt : 0
  await fs.writeText(target, format(armed, now), undefined, undefined, policy).catch(() => {})
}
```

## A5 — dream: gates, stamp before the lock, and the job-done handler that only clears pressure 〔src:ws:specs/tla/memory-write-lifecycle/code-anchors.md#L238-L352〕

`packages/memory/memory-consolidation/src/index.ts:290-345`

```ts
  minSessions: number,
  pressureCooldownMinutes: number,
  sessionsRoot: string,
  scan: () => Promise<SessionScanResult>,
): Promise<void> {
  const fs = ctx.get('fs')
  if (fs === undefined) return
  const dir = resolveWorkspaceMemoryDir(home, agentCwd(agent))
  const now = Date.now()
  const policy = memoryWritePolicy(dir)
  const pressure = await readPressure(fs, dir)
  const lastAt = await readLastConsolidatedAt(fs, dir)
  let hints: readonly string[]
  if (pressure.armedAt > 0) {
    // Pressure mode: an armed marker bypasses the time/session gates. The
    // cooldown is measured from `lastForcedAt` (not `armedAt`) so a tight arm
    // loop of rejecting saves cannot spin dreams faster than the knob;
    // backwards clock skew (negative delta) counts as within-cooldown.
    if (now - pressure.lastForcedAt < pressureCooldownMinutes * 60_000) {
      ctx.logger.debug({ event: 'memory:dream-gates', mode: 'pressure', lastAt, count: 0, minSessions, pass: false, reason: 'cooldown' })
      return
    }
    // Stamp BEFORE acquiring the lock: consumes the cooldown slot even if the
    // lock is held or the spawn never happens, making the crash-window spawn
    // storm structurally impossible. Failure keeps the marker with this stamp
    // so the next window retries.
    await markPressureForced(fs, dir, pressure.armedAt, now, policy)
    // Scan AFTER the stamp (plan §3.2/§3.3): a zero scan skips the spawn with
    // the marker still armed — the lock was never acquired, so there is
    // nothing to roll back and the next cooldown window retries.
    const scanResult = await scan()
    const window = gateWindow(scanResult.sessions, lastAt)
    ctx.logger.debug({ event: 'memory:dream-gates', mode: 'pressure', lastAt, count: window.count, minSessions, pass: true })
    if (scanResult.scanned === 0) return
    hints = window.hints
  } else {
    // Periodic: the pure-arithmetic time gate runs FIRST, before any scan I/O;
    // the session-count gate runs only on the scanned result.
    if (!timeGatePasses(lastAt, now, minHours)) {
      ctx.logger.debug({ event: 'memory:dream-gates', mode: 'periodic', lastAt, count: 0, minSessions, pass: false, reason: 'time' })
      return
    }
    const scanResult = await scan()
    const window = gateWindow(scanResult.sessions, lastAt)
    const pass = sessionGatePasses(window.count, minSessions)
    ctx.logger.debug({ event: 'memory:dream-gates', mode: 'periodic', lastAt, count: window.count, minSessions, pass })
    if (!pass) return
    hints = window.hints
  }
  const priorAt = await tryAcquireLock(fs, dir, process.pid, now, policy)
  if (priorAt === null) {
    ctx.logger.warn(`memory-consolidation: consolidation lock held by a live holder in ${dir}`)
    return
  }
  // Diagnostics + lock hygiene from here on: everything after the acquire can
  // strand the lock (a startMemoryJob throw, an earlier silent death), so the
```

`packages/memory/memory-consolidation/src/index.ts:353-397`

```ts
    void job.done.then(async (outcome) => {
      ctx.logger.debug({ event: 'memory:dream-outcome', status: outcome.status, detail: outcome.status === 'failed' ? outcome.detail : undefined })
      if (outcome.status === 'completed') {
        // Success tombs the marker in BOTH modes -- but only the arms this
        // dream's rebuild addressed (issue #335): the clear is conditional on
        // the arm captured at the dream's initial read, so an arm that landed
        // during the dream survives for the next window.
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
        void rollbackLock(fs, dir, priorAt, policy)
        return
      }
      try {
        const retry = await startMemoryJob(ctx, agent, dir, provider, 'memory-consolidation', prompt)
        void retry.done.then(async (retryOutcome) => {
          ctx.logger.debug({ event: 'memory:dream-outcome', retry: true, status: retryOutcome.status, detail: retryOutcome.status === 'failed' ? retryOutcome.detail : undefined })
          if (retryOutcome.status === 'completed') {
            void clearPressure(fs, dir, Date.now(), policy, pressure.armedAt)
            return
          }
          await recordDreamDiagnostic(ctx, fs, dir, policy, {
            sessionId,
            phase: 'outcome-failed',
            detail: `retry ${retryOutcome.status === 'failed' ? retryOutcome.detail : retryOutcome.status}`,
          })
          void rollbackLock(fs, dir, priorAt, policy)
        })
      } catch (err) {
        const detail = err instanceof Error && err.stack ? `${String(err)}\n${err.stack}` : String(err)
        await recordDreamDiagnostic(ctx, fs, dir, policy, { sessionId, phase: 'outcome-failed', detail: `retry ${detail}` })
        await rollbackLock(fs, dir, priorAt, policy)
        ctx.logger.warn(`memory-consolidation: dream retry failed: ${detail}`)
      }
    })
```

## A6 — memory job: the truncate fallback and the validated write-back 〔src:ws:specs/tla/memory-write-lifecycle/code-anchors.md#L353-L394〕

`packages/memory/memory-consolidation/src/memory-job.ts:76-89`

```ts
export function applyEntrypointFallback(payload: unknown): unknown {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return payload
  const raw = (payload as { writes?: unknown }).writes
  if (!Array.isArray(raw)) return payload
  const writes: unknown[] = raw.map((entry) => {
    if (typeof entry !== 'object' || entry === null) return entry
    const { path, content } = entry as { path?: unknown; content?: unknown }
    if (path !== ENTRYPOINT_NAME || typeof content !== 'string' || !entrypointOverLimit(content)) {
      return entry
    }
    return { ...entry, content: truncateEntrypointContent(content).content }
  })
  return { ...(payload as object), writes }
}
```

`packages/memory/memory-consolidation/src/memory-job.ts:143-158`

```ts
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
```

## A7 — gates: the periodic time gate over the last consolidation epoch 〔src:ws:specs/tla/memory-write-lifecycle/code-anchors.md#L395-L423〕

`packages/memory/memory-consolidation/src/gates.ts:24-45`

```ts
 * @param now - current epoch.
 * @param minHours - minimum elapsed hours.
 * @returns whether the time gate passes.
 */
export function timeGatePasses(lastConsolidatedAt: number, now: number, minHours: number): boolean {
  // A zero last-consolidation means none ever happened: open the gate.
  if (lastConsolidatedAt <= 0) return true
  return now - lastConsolidatedAt >= minHours * 3_600_000
}

/**
 * Session gate: at least `minSessions` transcripts touched since the last
 * consolidation.
 * @param sessionCount - transcripts touched since the last consolidation.
 * @param minSessions - minimum transcripts to review.
 * @returns whether the session gate passes.
 */
export function sessionGatePasses(sessionCount: number, minSessions: number): boolean {
  return sessionCount >= minSessions
}

/**
```

## A8 — the turn-end extraction fork: no lock, same write-back path 〔src:ws:specs/tla/memory-write-lifecycle/code-anchors.md#L424-L462〕

`packages/memory/memory-consolidation/src/index.ts:210-240`

```ts

/** Surface event types whose count a single extraction batch reviews. */
const SURFACE_EVENT_TYPES = new Set(['user/message', 'assistant/message', 'tool/result'])
/** Upper bound on the injected index: first 200 lines or 8 KiB, whichever first. */
const INDEX_CAP_LINES = 200
const INDEX_CAP_BYTES = 8 * 1024
const INDEX_TRUNCATED_MARKER = '(index truncated; rely on MEMORY.md in-dir for the rest)'

async function runExtraction(ctx: Context, agent: Agent, home: string, provider: string): Promise<void> {
  // The extraction writes into the turning agent's repository directory —
  // the shared home root holds only explicitly-global memories.
  const dir = resolveWorkspaceMemoryDir(home, agentCwd(agent))
  // Only model-visible surface events count toward the batch size.
  const surfaceCount = agent.session.snapshotEvents().filter((e) => SURFACE_EVENT_TYPES.has(e.type)).length
  // The index read happens AFTER the in-flight/content gates (runExtraction is
  // only reached once a spawn is committed), so a skipped spawn never pays the
  // fs cost. Any failure here degrades to an empty index and still spawns.
  const existingIndex = await readExistingIndex(ctx, dir)
  const prompt = buildExtractionPrompt(surfaceCount, dir, existingIndex)
  // Fire-and-forget: extraction failure must never fail the turn itself. The
  // job status still reflects the real outcome (the fork's structured report
  // is validated and written host-side before `done` completes).
  return startMemoryJob(ctx, agent, dir, provider, 'extract-memories', prompt)
    .catch(() => {})
    .then(() => {})
}

/**
 * Read the existing topic index to inject into the extraction prompt: the
 * MEMORY.md body when present, else the names of sibling topic `.md` files.
 * Swallow-all: any error or an absent fs yields an empty index so a spawn is
```

