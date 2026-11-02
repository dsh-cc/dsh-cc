# vwa-argument: eliminate the torn-lock brick (issue #307)

Status: v3 — three-lane blind review converged (v1: grok GO w/ 5×P1, codex
NO-GO w/ 4×P1, critic GO-conditional w/ 2×P1 — all folded into v2; delta
round: codex GO, critic pending, grok GO after one NEW fold (§3.2b re-read
read/parse split) folded here)
Date: 2026-11-02
Issue: https://github.com/dsh-cc/dsh-cc/issues/307
Review provenance: three blind lanes on v1 (2026-11-02); findings P1-1..P1-5
below are the folded cross-seat set.

## 1. Problem (verified on main @ 865d008f)

`packages/interaction/vwa-argument/src/lock.ts` — `acquireLock` creates the lock
with `openSync(lockPath, 'wx')` and then writes the body with `writeSync` +
`fsyncSync`. A crash between create and write leaves a zero-byte or partial
`locks/write.lock`. On the next acquisition:

- `JSON.parse(readFileSync(...))` throws → `existing = undefined`;
- the dead-holder reclaim branch requires a parseable body, so it never fires;
- the 2 s wait deadline then returns `LOCK_BUSY` on **every** acquisition,
  forever — the store lock (`store.ts` `acquireLock`/`withTransaction`) and the
  budget lock (`review-cycle.ts` `withBudgetLock`) are both bricked until
  someone hand-deletes the file.

There is no regression test for the torn path today.

## 2. Root cause

Exclusivity (the `wx` create) and crash-safe content publication are conflated
in one file. The `wx` create is atomic, but the body write is not, so the
"lock exists" state can be observed with a body that carries no holder pid.

## 3. Design decision

**Staged `link()` acquisition — the torn state becomes structurally
unreachable in same-version deployments; legacy torn files are reclaimed as
unowned, with that reclaim classified as carrying the known #311
reclaim-TOCTOU race.**

Why not `renameSync` over `write.lock` (issue's option 1, literal reading)?
`rename` over an existing target is atomic but **not exclusive**: two processes
staging distinct tmp names and renaming both "succeed" and both believe they
hold the lock. Mutual exclusion would be lost (all three review lanes
confirmed). The correct primitive is `linkSync(staging, lockPath)`: hard-link
creation fails with `EEXIST` iff the target already exists — an atomic
exclusive promote, the classic atomic-create pattern. `writeAtomic`
(`review-run-store.ts`) is a single-writer publish pattern, not an
exclusivity pattern — deliberately not copied.

Portability note: `linkSync` needs hard-link support and same-filesystem
staging — both hold by construction (staging lives in the same `locks/` dir;
NTFS/APFS/ext4 all support hard links).

### 3.1 Acquisition algorithm (replaces the body of `acquireLock`)

```
acquireLock(dir):
  lockDir   = dir/locks
  lockPath  = lockDir/write.lock
  mkdirSync(lockDir, recursive)
  deadline  = now + LOCK_WAIT_MS                  // unchanged: 2000 ms
  reapStaleStaging(lockDir)                        // §3.3, once per call
  loop:
    staging = lockDir/write.lock.<pid>.<processNonce>.<attemptUUID>.tmp
             // unique PER ATTEMPT (attemptUUID = randomUUID() each iteration)
             // — review fold P1-4: a per-process-constant name turns a
             // best-effort unlink failure into a permanent self-EEXIST
    fd = openSync(staging, 'wx')
      on EEXIST: continue loop (new attemptUUID; do not fail)
      on other error: fail('STORE_IO_FAILED', ..., retryable)  // unchanged shape
    bytes = Buffer.from(stableJson({pid, startedAt, nonce: processNonce}), 'utf8')
    writeAllSync(fd, bytes)   // LOOP until every byte is written
                             // — review fold P1-2: a single unchecked
                             // writeSync can short-write and publish a torn
                             // body; the loop is what makes "torn is
                             // structurally unreachable" true
    fsyncSync(fd); closeSync(fd)
    try: linkSync(staging, lockPath)               // ATOMIC EXCLUSIVE PROMOTE
    catch EEXIST:
      bestEffortUnlink(staging)
      → contention path (§3.2), then continue loop
    catch other:
      bestEffortUnlink(staging)
      fail('STORE_IO_FAILED', ..., retryable)
    success:
      bestEffortUnlink(staging)                    // lock survives: it is a
                                                   // second hard link
      return undefined                              // acquired
```

`writeAllSync(fd, bytes)` is a small module-level helper: loop
`writeSync(fd, bytes, offset)` advancing by the returned byte count until
`offset === bytes.length`; a `null`/0 return in violation of POSIX (write of
nonempty buffer returns >0 or throws) is treated as an error →
`STORE_IO_FAILED`. Same shape as `writeCycleBudget` (`review-cycle.ts:176-177`).

Crash at any point before the `link`: only the staging file exists; it is
inert (never read as a lock) and reaped by §3.3. Crash after the `link`: the
lock body is complete and fsynced; the holder pid is recoverable and the
existing dead-holder reclaim applies. **There is no reachable state in which
`write.lock` exists with a torn body under this code** (given the full-buffer
write loop and the `link`-only publication).

### 3.2 Contention path (on `EEXIST` from `linkSync`)

Read the lock file with the read/parse split below (fold P1-1/P1-4 of the
review: the current `lock.ts:73-77` catch folds `readFileSync` errors and
`JSON.parse` errors together; carrying that into a reclaim branch turns any
transient read error — `EMFILE`, `EACCES`, and critically `ENOENT` when the
holder released between our `link` failure and our read — into "unowned"
evidence and unlinks a live holder's lock):

1. `readFileSync` error with `ENOENT` → the lock is gone → `continue` loop
   (retry immediately).
2. `readFileSync` error other than `ENOENT` → `fail('STORE_IO_FAILED', ...,
   retryable)` — do NOT unlink anything.
3. Read succeeded but `JSON.parse` threw (torn or empty) → §3.2b.
4. Read+parse succeeded → classify body:
   a. **holder pid dead** → `unlinkSync(lockPath)` (swallow errors), `continue`
      — the existing dead-holder reclaim, unchanged. **Known defect carried:
      the read→decide→unlink sequence is not atomic (TOCTOU); two reclaimers
      can end up dual-holding. This is the pre-existing defect already
      tracked as issue #311 and modeled-atomic as E-8
      (`specs/tla/vwa-review-cycle/design.md:230`); this PR does not widen or
      fix that window — see §8.**
   b. **pid is ours and nonce is ours** → immediate `LOCK_BUSY` self-deadlock
      report (unchanged).
   c. **parseable but wrong shape** (e.g. `{}`, `pid` missing → `pidAlive`
      throws internally and returns `false`): behaves as a dead holder —
      reclaimed. Unchanged from main; pinned by test.
   d. otherwise (live foreign holder) → wait for deadline → `LOCK_BUSY`
      (`retryable`), else 50 ms bounded spin — unchanged.

### 3.2b Unparseable-body recovery (the issue's brick)

Under this code a torn `write.lock` cannot be produced (§3.1). An
unparseable file can only come from a **pre-fix binary** that crashed (or is
mid-write) inside its open→write window. Recovery:

1. Spin one bounded wait (reuse the 50 ms spin) and **re-read — applying the
   same §3.2 read/parse split to this re-read** (grok delta fold): read
   error `ENOENT` → `continue` loop; read error other than `ENOENT` →
   `fail('STORE_IO_FAILED', ..., retryable)` — never unlink (a transient
   read error is not "still unparseable" evidence); parse success → fall
   through to §3.2(4) classification (a live old-version writer usually
   completes its body within this window — cheap narrowing of the
   mixed-version hazard; not a guarantee); parse failure again → step 2.
2. Still unparseable → `unlinkSync(lockPath)` (swallow errors), `continue`
   loop → our `link` promotes.

**Hazard classification (review fold — supersedes v1's "availability-only"
claim, which was wrong):** reclaiming an unparseable body can break mutual
exclusion in two ways, both **safety-class**:

- **Mixed-version race**: an old binary sitting between `openSync('wx')` and
  `writeSync` has its freshly-created file reclaimed by a new binary; the old
  writer then writes to its still-open (unlinked) fd, returns success, and
  both processes enter their critical sections. The old writer's
  pathname-based `releaseLock` can later delete the new holder's lock.
- **Two-reclaimer race**: two new binaries that both read the same torn file
  can each unlink-and-republish (the second unlink deleting the first's
  replacement lock) — dual ownership.

Both are instances of the same non-atomic reclaim TOCTOU as the dead-holder
path, which the repo already tracks as **issue #311** and models as atomic
(E-8). Same-version deployments have no such window: new code never publishes
a torn `write.lock`, so §3.2b only fires on pre-fix leftovers — a one-time
migration event whose writer is, in the overwhelmingly common case, dead (it
crashed). The residual exposure (a *live* old binary racing a new binary
during an upgrade window) is real but bounded to the upgrade moment, and the
re-read grace in step 1 narrows it. **Decision: accept and document, cross-ref
#311; the structural fix for non-atomic reclaim belongs to #311 and is out of
scope for this PR.** (No portable userland primitive — `renameat2`
`RENAME_EXCHANGE` is Linux-only — provides an inode-CAS; folding a #311 fix
here would couple two defect classes into one PR.)

`lockHeld` and `releaseLock` are unchanged (reporting + best-effort unlink of
`write.lock`).

### 3.3 Staging-file hygiene

Staging files are never locks, but crashed processes leave them behind. On
each `acquireLock` call, before the first staging attempt, best-effort reap
`write.lock.*.tmp` entries in `locks/` whose second `.`-separated segment
parses as an integer pid that is dead and is not our own pid. Entries with an
unparseable pid stay (harmless, rare). Because the reaped pid is the owner's
pid and live owners always look live, pid reuse can only **retain** garbage
(conservative), never delete a live process's staging. Note the glob must
match the trailing dot (`startsWith('write.lock.')` AND
`endsWith('.tmp')`) — `startsWith('write.lock')` alone would match the lock
file itself (review fold P2). All reaping errors are swallowed. Own leftovers
cannot block us anyway (per-attempt UUID names, §3.1).

## 4. What does NOT change

- Public API: `acquireLock`, `releaseLock`, `lockHeld` signatures and semantics.
- `LOCK_WAIT_MS`, the 2 s deadline, the 50 ms spin, `Fail` codes
  (`LOCK_BUSY`, `STORE_IO_FAILED`) and messages.
- Dead-holder reclaim semantics for valid bodies ("never by timeout alone").
- Callers: `store.ts`, `review-cycle.ts` (`withBudgetLock`), `init-tool.ts`,
  `index.ts` re-exports — zero diffs expected there.

## 5. Test plan (new file `packages/interaction/vwa-argument/tests/lock.spec.ts`)

Use a temp project dir per test (`mkdtempSync`), same rig style as
`store.spec.ts`. Where a live foreign process is needed, spawn a
long-sleeping child (pattern: `store.spec.ts:95-107`) and reap it in a
`finally`.

1. **torn lock is reclaimed (the regression flip demanded by the issue)**:
   write non-JSON garbage into `locks/write.lock`, call `acquireLock` →
   returns `undefined` (acquired), and `write.lock` now contains a parseable
   body naming our pid. (Assert the full-reclaim path completed under the
   2 s wait, i.e. not via deadline expiry.)
2. **empty lock file**: zero-byte `write.lock` → acquired.
3. **live foreign holder still blocks**: valid body with a live foreign pid →
   `LOCK_BUSY` with `retryable: true` (pins the 2 s wait was endured).
4. **dead-holder reclaim unchanged**: valid body with a dead pid (a reaped
   spawned child) → acquired.
5. **self-deadlock report unchanged**: two sequential `acquireLock` calls
   without release → second returns the `LOCK_BUSY` self-report.
6. **wrong-shape-but-parseable body** (review fold): `{}` → acquired via the
   dead-holder branch (pins current behavior).
7. **staging hygiene**: create `write.lock.<deadPid>.<uuid>.tmp` and
   `write.lock.<liveForeignPid>.<uuid>.tmp` in `locks/`, call `acquireLock` →
   dead-pid staging is gone, live-pid staging remains, acquisition succeeded.
8. **acquired body is complete**: after successful acquisition, `write.lock`
   parses as `{pid, startedAt, nonce}` with `pid === process.pid`.
9. **full-buffer write loop** (review fold): with `vi.spyOn(fs, 'writeSync')`
   returning short counts on early calls, `acquireLock` still publishes a
   parseable complete body — the helper must loop (mock restores after).
10. **ENOENT between EEXIST and read** (review fold): plant a valid live
    foreign lock; sequence: our `link` gets EEXIST, the holder (test helper)
    releases, our read sees ENOENT → the loop retries and acquires promptly
    (no unlink, no `STORE_IO_FAILED`). Implement by releasing the lock after
    the first `link` EEXIST is observed (spy on `linkSync`).
11. **two live acquirers, empty dir** (review fold): spawn two child processes
    that each call `acquireLock` (tiny node -e script importing the built
    helper or duplicating a 10-line inline version of the staging+link
    algorithm against the same dir is NOT acceptable — drive the real code
    via a child process executing a small script that imports
    `@dsh-cc/vwa-argument/lock` through the workspace); assert exactly one
    acquires and the other reports `LOCK_BUSY`.
12. **release**: `releaseLock` removes `write.lock` and leaves foreign
    staging files alone.

Plus one consumer-level pin in `review-cycle.spec.ts` (review fold: plant path
must be the **budget** dir `<root>/.dsh/vwa/<projectId>/review-budget/locks/
write.lock`, `review-cycle.ts:88-90`): garbage `write.lock` there → the
`withBudgetLock` action proceeds.

Not deterministically testable, documented instead (§3.2b): the
two-reclaimer and mixed-version dual-ownership traces — interleavings belong
to the #311 TOCTOU class; deterministic coverage of those races is coupled to
the #311 fix, not this PR.

## 6. TLA+ model true-up (`specs/tla/vwa-review-cycle`)

Under this design, acquisition *is* publication of a complete body; a crash
in the (staging-only) create window leaves `lockHolder` unchanged — subsumed
by the existing `Crash` action. Edit set (hand-edits; no auto-regeneration by
design) — review folds expanded this list:

- Delete `CrashTorn` (Model.tla:443-452) **and** `AdmissionBusy`
  (150-156, becomes dead code; remove from `Next`, line ~461/474).
- Drop `"torn"` from the `lockHolder` domain in `TypeOK` (line ~498) and from
  every `lockHolder`-domain comment.
- Delete the dead `lockBody` variable entirely (never set `TRUE` anywhere in
  the module; carrying it is incoherent after the true-up).
- Delete the `LockNeverTorn` probe (Model.tla:570-572), the
  `cases/strict-torn-lock.cfg` case file, and its `checks.json` entry
  (lines ~36-56).
- Flip `design.md` R-9 (line 43: expected-red "torn is permanent" → removed;
  note the fix and cross-ref issue #307) and R-7 (line 41: remove torn-lock
  from the admission-refusal list).
- Update `code-anchors.md` (lock.ts anchors move) and `implementation.md`
  (record the fix, the new semantics, and the new run lineage with runId).
- Re-run the model check scoped to `specs/tla/vwa-review-cycle` via the
  existing formal-design pipeline and record the runId in `implementation.md`.

The atomic-reclaim abstraction (E-8/#311) is retained unchanged — the model's
green does not claim the real reclaim is atomic; `design.md` says so already.

## 7. Delivery

- Single PR, branch off latest `main`. Commits: (1) design doc, (2) code +
  tests + model true-up. English conventional-commit titles.
- Verification battery (orchestrator-run): `tsc -b tsconfig.packages.json
  --force`, root `vitest run packages/interaction/vwa-argument`, the four
  static docs gates, `pnpm check:size`, `pnpm check:exports` (after
  `pnpm run build`), README hash gate untouched (no README change).
- Close the loop on issue #307 with the PR number.

## 8. Out of scope

- **Non-atomic reclaim TOCTOU (dual ownership via dead-holder or torn-body
  reclaim), tracked as issue #311** — pre-existing, modeled as atomic (E-8),
  structural fix (e.g. inode-CAS via `renameat2`) is not portably available in
  Node and belongs to #311. This PR does not widen the same-version window
  (new code never creates the torn files the recovery path reclaims) but does
  add a reclaim trigger for pre-fix leftovers; the §3.2b grace narrows the
  live-old-writer subcase.
- PID-reuse misclassification (documented exclusion, unchanged; conservative
  direction in both the dead-holder check and staging reap).
- Host/power-loss durability beyond file `fsync` (no directory fsync after
  `link`) — matches existing repo convention (`writeAtomic` does not fsync
  directories); the worst case is a lost (freed) lock, never a torn or
  duplicated one.

## 9. Review ledger

Three blind lanes on v1 (2026-11-02, all lanes saw the same brief, no
cross-feeding):

- **Lane A (external reviewer A)**: GO with 5 P1 / several P2 — write-loop
  requirement, read/parse split, mixed-version reclassification, staging-name
  collision, test/model-edit-set gaps.
- **Lane B (external reviewer B)**: NO-GO with 4 P1 — competing-reclaimer
  dual ownership (cross-referenced #311), mixed-version mutex violation,
  short-write torn publication, read-failure conflation; reproduced traces
  with real filesystem primitives.
- **Lane C (internal critic)**: GO-conditional with 2 P1 / 3 P2 — mixed-version
  misclassification + re-read grace, staging-collision contradiction, test and
  model bookkeeping.

Adjudication: verdict divergence (GO / NO-GO / GO-conditional on the same
finding set) was severity calibration, not substance — every finding was
folded into v2 (implement-as-written test: v1 as written could publish a
torn body via short writes and unlink live holders via read-error conflation,
so the strict lane's blockers were upheld). Delta round (fresh briefs, fold
map only): Lane A GO, Lane B GO; Lane A additionally caught one NEW fold
(§3.2b grace re-read must apply the §3.2 read/parse split), folded into v3,
confirmed GO in a single-item micro-confirmation round. Lane C delta: GO, no
new findings. All three lanes converged GO on v3. User sign-off pending
(delivery authorized in the issuing session).

