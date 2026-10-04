# CI test-suite stability: root-fixing the current flake corpus

Status: **Approved — six-round blind-review arc closed (critic GO at r5;
codex GO at r6; grok GO at r6; full ledger in §8); user sign-off granted
2026-10-03. Implementation per §7.**

(Draft history: v1 `.scratch/design-ci-test-stability-v1.md` — r1 object;
v2 `.scratch/design-ci-test-stability-v2.md` — r2 object;
v3 `.scratch/design-ci-test-stability-v3.md` — r3 object;
v4 `.scratch/design-ci-test-stability-v4.md` — r4 object, superseded in
place to produce this v5.)

## 1. Problem

PreSubmit's `Unit tests (vitest)` step fails intermittently with flakes that
turn green on a bare rerun of the same SHA. Recent main-line evidence
(signatures read from the actual job logs; log excerpts in
`.scratch/flaky-ci/job-*.log` on the authoring worktree):

| Run | Context | Failure signature |
| --- | --- | --- |
| 36878353680 (2026-10-01) | **empty baseline probe off main** (attribution control) | `e2e-codex-bridge.spec.ts › M6` — `Test timed out in 90000ms` |
| 36797390829 (2026-10-01) | main, docs-only PR #181 merge | `e2e-codex-bridge.spec.ts › M5` — `Test timed out in 90000ms` |
| 36732295417 (2026-09-30) | main, v0.8.2 release merge | `e2e-codex-bridge.spec.ts › M6` — `Test timed out in 90000ms` |

Baseline figures (verifiable): 540 unique spec files at HEAD 3adba19d
(`find packages -path '*/tests/*.spec.ts'`; the naive
`find packages/*/*/tests packages/launcher/*/tests` prints 547 because the
launcher glob double-counts 7 files — vitest's include list has the same
overlap and the runner dedupes); green-run vitest step 1m42s (run
36877675353, step started 14:51:44, completed 14:53:26).

Established corpus from earlier stacks (attested in project ledgers):

- hooks-claude-code timeout cluster under full-suite load (bridge /
  coverage-config / coverage-edge-paths / coverage-stop / coverage-context /
  events / plugin-hooks-seam — `Test timed out in 5000ms`, green in isolation;
  PR #160/#161 stacks).
- `e2e-grok-bridge.spec.ts › M5/M6` 90s timeouts (PR #170, PR #184 stack).
- `workflow-journal/tests/spike.spec.ts:275` ordering AssertionError on CI,
  3/3 green locally (PR #184 stack).
- `mcp-client/tests/stdio-stderr.spec.ts › rotation` — `expected false to be
  true` (PR #187 stack).
- `settings-cascade/tests/watcher.spec.ts` chokidar/fsevents timing.

Empty-baseline red ⇒ main flakes **with zero diff**. Every flake costs a
manual rerun and degrades flake-vs-product attribution.

## 2. Non-negotiable constraints

- **Integrity**: no assertion weakened silently. Every change declares the
  invariant it keeps. Where an existing assertion checks something the product
  never guarantees, it is replaced by the invariants the product *does*
  guarantee — written side by side in §4, and §7 requires *negative mutation
  demonstrations* (the new form must still reject wrong behavior), not only
  green-path reruns.
- **No blanket retries** and **no broad skipIf(CI)**.
- **No fixed sleeps as completion signals.** Negative windows ("nothing
  happens during T") that legitimately need sleeps stay sleeps — documented,
  shared constant — but a sleep that *hopes processing happened* without
  observing it is a defect class (§4-F5) and gets replaced by an observable
  completion signal.
- **Budget arithmetic must nest** (rule R4 below): every inner deadline chain
  must fit inside the outer test timeout with stated headroom, and every
  touched file's worst-case `Σ(outer timeouts)` must fit the presubmit
  vitest-step budget.

## 3. Flake corpus: mechanisms (all verified against code + logs in r1–r2)

### E1 — bridge e2e M5/M6 90s timeouts (current main-line offender)

Files: `packages/subagent/task/tests/e2e-codex-bridge.spec.ts`,
`e2e-grok-bridge.spec.ts` (near-clones; structure verified byte-level).

Per-test `setup()` boots a full world: cordis `Context` + session persistence
+ agent loop + subprocess runtime + `HooksClaude` + the real plugin mounted
from the repo path; only the LLM is a MockAdapter; hook + launcher + fixture
spawn real node/bash child processes.

M5/M6 shape: `await callTool(ctx, 'subagent_fork', …)` **blocks until the
child's first epoch completes** (chain: `task/src/tool.ts:372` →
`background-start.ts:295` → `epoch-collector.ts:315`, verified by codex lane),
then sequential `waitFor` polls (30s deadline each; predicates evaluated
before first sleep, so post-completion reads of already-written facts return
in milliseconds), then `waitNoActivation`; outer test timeout 90s.

**Failure-signature analysis (kept deliberately tentative):** the observed
message is vitest's bare `Test timed out in 90000ms`, *not* `waitFor:
condition not met before deadline` — no poll ever fired its own 30s deadline.
That rules out only one reading ("a poll starved for its full 30s before
t=90s"); it does **not** rule out a poll being in flight when the outer timer
fired, nor event-loop starvation delaying deadline checks. It is consistent
with the hypothesis that setup + the full child lifecycle consume the budget
under full-suite CPU contention, but the phase split is unproven by the logs
— which is why F1.5 ships timestamped phase dumps as part of the fix, and why
F1's envelope must cover setup too (F1.1), making any *next* timeout
attributable without a probe PR.

Secondary structural hazards found while verifying E1:

- No per-test world disposal: dirs are rmdird in `afterAll` (codex:94 /
  grok:114); a timed-out test can leak a live child (the collector
  re-subscribes shared listeners per context — `epoch-collector.ts:73`).
  Markers are per-test tmpdirs, so the leak is contained per test — but it
  keeps a subprocess fleet alive through the rest of the file and its own
  test's diagnostics can read torn writes (next bullet).
- `payloads()` (`codex:271` / `grok:291`) parses every non-empty line with
  unguarded `JSON.parse`; an in-flight partial write produces a bare
  `SyntaxError` reported as the test's error — a confusing-signature flake
  class whenever diagnostics read the marker while a writer may still be live.

### E2 — hooks-claude-code 5s default-timeout cluster

Root `vitest.config.ts` declares no `testTimeout` ⇒ 5s default repo-wide. The
cluster files boot per-test cordis worlds (coverage variants via
`coverage-cases.ts:76`). Several in-spec helpers carry their own 5s deadlines
(`bridge.spec.ts:83`, `events.spec.ts:67`, `plugin-hooks-seam.spec.ts:33`,
`coverage-cases.ts:99`), so raising only the outer per-file timeout changes
the failure signature, not the failure — inner and outer budgets move
together (R4).

Attested-red set (from ledgers): bridge, coverage-config, coverage-edge-paths,
coverage-stop, coverage-context, events, plugin-hooks-seam. safety-loop /
background-subagent-start / error-recovery are **not** in scope (no corpus
evidence). Correction of earlier-round claims (grok r3-10 + r4-5): the
budgeted-neighbor story was overstated in both directions — measured against
the tree: background-subagent-start has a 60s outer at :135; error-recovery's
async tests run 30s; safety-loop is mixed (six tests with explicit 30s/60s at
:115/:130/:160/:193/:212/:310, fourteen on the 5s default). None of the three
joins F2's attested set, but the original "already budgeted" justification was
wrong and is corrected here.

### E3 — workflow-journal spike ordering assertion

`spike.spec.ts:275` asserts run-3 live-spawn arrival order **exactly equals**
run-1's normalized suffix order, while the file's own comment (:213-215)
documents cross-item pipeline interleaving as engine-owned. Run 3 replays its
cached prefix synchronously, shifting microtask scheduling ⇒ cross-item
arrival swaps (`answer-* stage2 b/c` observed) with no product bug.

What the old assertion incidentally also pinned (preserved by F3): the freeze
boundary (the live suffix begins at the `fan 2` slot, inclusive — run 3's
edited prompt reruns live), the exact prompt **multiset** of the suffix, and
per-item stage1<stage2 ordering. Note the fans are dispatched by one
`parallel(args.fans.map(...))` (:43): *fan-before-pipeline* phase order is
script-guaranteed (`await parallel` completes before `pipeline` starts), but
**inter-fan arrival order inside one parallel block is engine-owned** — r2
adjudication on F3.2 honored that by not asserting fan-internal order.

### E4 — stdio-stderr rotation header race + chunk-coalescing hazard

Rotation generation switch ends the old stream and opens the new one
independently (`stdio-stderr.ts:145`); the fresh generation's header is queued
asynchronously (`:180`). Poll predicates gating on backup/fresh content
(`spec:163`, `:180`, `:202-203`, `:227-229`) never cover the fresh header, yet
assert `readOr(logPath()).startsWith(header)` immediately after ⇒ `expected
false to be true` under I/O contention. The `:247/:249` site is a different
gap: its predicate covers only the fresh log's content and then reads the
backup unguarded — same fix family (predicate must cover the asserted file).

Additionally: `childConfig()` (:133-138) implies chunk boundaries via
60ms-spaced writes, but delayed pipe consumption coalesces writes; the test at
:193 asserts `POST-MARKER` lands *after* rotation while production rotates
*per received chunk* (`stdio-stderr.ts:129`) — a coalesced chunk legitimately
routes it to the backup. Chunk-dependent assertions are timing-dependent
assertions. Also: helper deadline 5s (`spec:290`) vs vitest's 5s default outer
— zero headroom (R4).

### E5 — watcher.spec timing budgets and hope-sleeps

Seven `vi.waitFor(...)` sites cap at `{ timeout: 3000 }` (fsevents delivery on
a loaded runner can exceed 3s). The malformed-JSON test packs two waits + a
300ms sleep inside a 15s outer (`watcher:158`) — budget nesting breaks as soon
as waits grow. The 300ms (:169) and 500ms (:196) sleeps are *hope-sleeps*:
they do not observe that the malformed document was actually processed, nor
that the self-write event's dedup decision completed, so the tests can pass
while the intended paths never ran; `settled()` drains only already-enqueued
operations (`settings-cascade/src/index.ts:267`), so it cannot substitute for
"watch event arrived and was handled". The teardown sleep at :265 is a
legitimate bounded negative observation. The comment at :125 ("five awaited
writes fit a two-second window") is an unbacked arithmetic claim.

## 4. Fixes

### Rule R4 (budget nesting, governs all fixes below)

- Per touched test: `setup + Σ(sequential inner deadlines) <
  outer testTimeout`, strict inequality, with the headroom written next to
  the timeout. Hook work (teardown) lives in vitest's separate `hookTimeout`
  budget — it never borrows the test outer, and must be budgeted explicitly.
- Per touched file: `Σ(test outers) + Σ(hook allowances measured at the
  ENFORCED hookTimeout ceiling)` ≤ **18 minutes** (ceiling semantics — grok
  r4-1: expected-allowance arithmetic answers nothing about the timer vitest
  actually enforces). Derivation: vitest step cap 25m (§5) minus ≥5m margin
  for the rest of the suite; the 30m job cap stays the non-observable
  backstop.
- The implementation PR attaches the computed per-file Σ (including hooks)
  and per-touched-test nesting tables.
- Self-enforcement limitation (recorded decision, not omission): nothing
  structural stops a future PR from breaking these sums by adding tests; if
  R4 arithmetic starts biting repeatedly, a grep-based Σ lint is the
  follow-up.

### Shared budget snippet (Q2 adjudicated: per-file duplication)

```ts
// TIMEOUT-BUDGET: keep byte-identical across spec files.
// scale: DSH_TEST_TIMEOUT_SCALE (debug override), else 2 on GitHub Actions, else 1.
// Must be an integer in [1,4]; anything else → 1. Values >2 exceed what R4 was sized for.
const raw = Number(process.env.DSH_TEST_TIMEOUT_SCALE ?? (process.env.CI === 'true' ? 2 : 1))
const scale = Number.isInteger(raw) && raw >= 1 && raw <= 4 ? raw : 1
```

Strict `=== 'true'` parse; validated override (`''`/`'abc'`/`Infinity`/`0`/`20`
all fall back to 1 — codex r2-6, ceiling added per critic r3-5);
`DSH_TEST_TIMEOUT_SCALE=2 pnpm test` reproduces CI budgets locally.
Q2 dissent on record in §8.

### F1 — bridge e2e: bound the lifecycle in one envelope, dispose worlds, harden reads

Applies to `e2e-codex-bridge.spec.ts` and `e2e-grok-bridge.spec.ts` identically.
`e2e-shunt-gate.spec.ts` is **audit-only** in this PR (structurally adjacent
— foreground in-process forks plus sequential 20s polls under 30s outers,
with one 40s cold-resume test at :490; lone background-pinned dispatch is
the critic call at :243); its teardown timing is measured, not changed.

1. **One inner envelope per test, starting before `setup()`.** The envelope is
   derived, not picked: `envelopeMs(test) = outerMs(test) − 30 s` — 90s for
   M5/M6 (outer 120s), 60s for the other seven tests (outer 90s). A single
   deadline covers setup → fork await → polls → `waitNoActivation`; the fork
   await and every poll receive `remaining(envelope)`, so no combination of
   inner waits exceeds the envelope, a hang *inside setup* (a phase the
   signature analysis cannot exclude, §3-E1) is envelope-covered, and the
   envelope always fires 30s before vitest with the timestamped `dumpState`,
   never as the bare timeout. The fork promise's rejection is recorded at
   creation (no floating promise). The numbers exceed the observed worst
   case; a wrong phase call surfaces attributable in the dump.
2. **Outer per-test timeout: 90s → 120s for M5/M6 (flat); other seven tests
   stay 90s (flat).** Deliberately unscaled: 120s buys the observed
   contention margin; scaling would breach R4. Nesting: envelope 90s < outer
   120s strictly, 30s headroom (setup is *inside* the envelope). Per-file
   ceiling accounting (R4): test outers `7×90 + 2×120 = 870s` + enforced hook
   ceilings `9 × 15s afterEach + 2 × 15s afterAll = 165s` → **1035s = 17m15s
   ≤ 18m** ✓. Expected-case teardown is the smaller `4_000×scale` window per
   test (`870 + 9×8s = 942s CI`); expected figures answer "is headroom
   present", ceiling figures answer "can vitest's own timers over-run the
   bound" — no (17m15s ≤ 18m; step cap 25m). History footnote: v1 proposed
   150/300, v2 shipped 150s flat — both breached their own stated bounds.
3. **Per-test world disposal, in pinned order, inside an explicit hook
   budget.** New `worlds[]` registry — `setup()` pushes each ctx into it **at
   construction, not on completion** (grok r4-6: an envelope abort midway
   through setup otherwise leaves a half-built world outside disposal; the
   disposal chain must tolerate partially-initialized worlds: seal/interrupt/
   dispose are tolerated no-ops on what was never mounted). Both bridge files
   add `vi.setConfig({ hookTimeout: 15_000 })` — flat, unscaled (hooks are
   teardown; contention does not multiply housekeeping need): the ceiling
   sits comfortably over the CI-scaled teardown window below, and keeps the
   R4 ceiling arithmetic honest. `afterEach`: (a) **seal** the ctx — no new
   spawns/tool executions admitted; then ONE shared teardown window of
   `4_000 * scale` **clamped under the hook ceiling**
   (`Math.min(4_000 * scale, 13_000)` — at override scale 4 the raw window
   would exceed the flat 15s ceiling; critic r5 minor) covers (b) bounded-join of any in-flight start admission,
   (c) interrupt of registered live children, (d) dispose/finalize of the ctx
   (dispose must join the same window — its own hang cannot outlive it); a
   window expiry mid-way logs a `teardown-incomplete` marker line (visible in
   the tee'd artifact) and continues — verification of actual quiescence is a
   §7 adverse-path case, not a teardown precondition; (e) the registry is
   cleared regardless. The **two** `afterAll`s per file (env restore at
   codex:62/grok:72 + tmpdir rmSync at codex:94/grok:114 — hence "two") ride
   the same ceiling and are counted in the sum below. The API names are implementation-pinned (D1);
   the pinned order and its guarantees are the design requirement.
4. **payloads(): provisional vs terminal reads.** While the owning test's
   child may be live, exactly one unterminated trailing line is tolerated
   (torn mid-write read); completed lines always pass through throwing
   `JSON.parse`. The terminal read — after the fork resolved and no live
   child remains — re-parses the whole file strictly, so a writer that exits
   with a truncated final record still fails loudly (codex r2-5). A negative
   demonstration with a truncated-final-line writer is in §7.
5. Keep the per-milestone sequential polls and `dumpState`; the dump gains
   phase timestamps (setup done / fork dispatched / fork resolved / each poll
   entered) — the attribution instrumentation for any *next* timeout.
6. Fixture `spawnSync` (`codex:233` / `grok:253`) is envelope-clamped via the
   remainder-with-guard rule: `timeout = remaining(envelope) − 1_000`; if
   `remaining ≤ 1_000` the fixture fails fast *without spawning* (never spend
   a deadline that is already empty, codex r4-3 — `Math.max(1_000, remaining)`
   from v3/v4 could still overrun an exhausted envelope). **Honest residual,
   measured by the codex lane with a live reproduction:** a child that
   *ignores* the kill signal wedges `spawnSync` past its timeout and blocks
   the worker's whole event loop — the envelope timer and the afterEach
   teardown then *cannot run*; worker-side diagnostics are impossible in that
   case and the only bounds are vitest's worker-teardown machinery and the
   25m step cap (external termination, no dump). Inertness here rests
   entirely on the fixture's command set being fixed test code — echoes plus
   the canonical launcher invocation, which refuses fast under the file's
   hermetic PATH (codex unresolvable by design) — so the trap scenario
   requires changing the fixture itself; any such change reopens this
   residual for review, and §7's wedged-spawn demonstration covers the
   signal-cooperative path only (codex r5-1 / grok r5-2, convergent).

Integrity accounting: every existing assertion unchanged; the changes bound,
sequence, and clean up — they do not judge.

### F2 — hook-cluster per-file budgets, with the per-test nesting audit

For each attested-red file (bridge, coverage-config, coverage-edge-paths,
coverage-stop, coverage-context, events, plugin-hooks-seam):

1. File-level outer `vi.setConfig({ testTimeout: 30_000 })` — **flat, not
   scaled** (grok r3-4: `30_000 * scale` would breach R4 — bridge.spec
   17 tests × 60s = 17m before any hook ceilings are counted; the same flake
   evidence that justifies raising 5s→30s does not justify scaling on top):
   suite-level per-file sums with flat 30s — bridge 17×30s = 8.5m, events
   16×30s = 8m, plugin-hooks-seam 5×30s = 2.5m, coverage wrappers 12/13/9/9
   respective cases (lane-reported, later tree-verified; the wrappers generate
   their `it`s through `coverage-cases.ts`) × 30s = 6/6.5/4.5/4.5m — all well
   under the 18m ceiling-inclusive bound (their teardown is trivial, no
   subprocess worlds).
   These are **pre-audit floors** (critic r5 minor): the totals are starting
   points, not invariants — the F2.3 audit's PR tables are the final
   artifact, and must keep every file's Σ(outers+hooks at ceiling) ≤ 18m.
2. In-spec helper deadlines 5s → `5_000 * scale` (bridge:83, events:67,
   plugin-hooks-seam:33, coverage-cases:99 — verified per file at
   implementation). Helpers scale because the flake mechanism *is* contention
   slowing the waits; outers don't because per-file R4 can't afford it.
3. Same-commit per-test nesting audit (never blind), with three distinct
   deadline *classes* on the table (codex r5-3): (a) in-spec helper
   deadlines (the 5s → `5_000×scale` sites); (b) **unbounded delegate waits**
   — `waitForIdle()` just returns `agent.whenIdle()` with no deadline of its
   own: any call site gets wrapped in an explicit budget (it joins the
   per-test sum); (c) explicit per-test third-arg overrides that already
   exist (e.g. 15s sites) — the new 30s file default does **not** replace
   them; their nesting is audited as-is. A test chaining three scaled helpers
   sums to 30s at CI = the flat outer before setup — that test gets its own
   outer (allocated per R4, e.g. 45s) or shorter helper budgets; the PR
   carries the arithmetic per touched test. (Longest helper chain today is
   K=2 — grok r4/r5 confirm — but K≤2 says nothing about class (b), hence the
   three-class table.)
4. Honest trade wording: latency-detection walls for these files move from
   5s to 30s (both environments; functional assertions untouched).

### F3 — spike.spec: assert guarantees, drop engine interleaving

Replace the cross-run exact-order `toEqual` (:275) with, on run 3's live
spawns (`run3Prompts`, `normalized` as today):

1. **Normalized multiset equality** against run 1's expected suffix — exact
   prompt set modulo the `answer-\d+` token, `fan 2` → `fan EDITED`
   substituted. (Rejects wrong/missing/duplicate prompts.)
2. **Freeze position (v3, adjudicated — see §8):** the first two live prompts
   are exactly the **set** `{fan EDITED, fan 3}` and no pipeline prompt
   precedes them; fan-internal arrival order is not asserted (inter-fan
   dispatch order inside one `parallel(...)` block is engine-owned — same
   class as what E3 deletes; script-guaranteed fan-before-pipeline phase
   order remains asserted).
3. **Per-item stage order** for a/b/c (same predicate family as run 1's
   :218-223).
4. Count `TOTAL - 2` and cached-prefix absence (already present).
5. **Records-level run-3 checks:** the run-3 `runId`-filtered durable
   `agent-start` rows are exactly ten, have strictly monotonic `+1` seqs
   (relative contiguity — whether seq is session-global and run 3's rows start
   at 21 is pinned at implementation, D4), and the rows at the prefix
   positions carry `cached: true` while live suffix rows carry none.

Dropped: cross-run exact arrival **order** equality and fan-internal order
within one parallel block — both engine-owned (run 1's own exact fan-order
check at :217 stays: it has never flaked, and §7 gains a positive demo that a
forced inter-fan swap *passes* run 3, proving run 3 re-imports nothing).
Gained: records-level assertions run 1 does not currently have.

### F4 — stdio-stderr: complete the predicates, de-time the chunk tests

1. Predicate completion: header-coverage sites (`:163/:165`, `:180/:187`,
   `:202/:212`) poll for the fresh header **and** the original marker; the
   `:247/:249` site polls for the backup content it then asserts (its gap is
   backup coverage, not header — grok r3-8 also de-listed `:227/:234` from the
   header sites; see F4.2). Assertions unchanged.
2. **Chunk determinism with a routing-aware acknowledgment.** Every
   chunk-boundary routing claim driven by `childConfig`'s 60ms spacing moves
   to the deterministic seam — that is both the `:193` test (POST-MARKER
   placement) **and** the `:218-235` test (B/C placement — same coalescing
   class; header polling does not fix it). Preferred: the byte-routing
   decision is exercised through a deterministic seam (routing
   factored/injectable so chunk boundaries are synthetic inputs). Fallback:
   an ack protocol in which the **parent side** — the pipe consumer running
   the production routing/rotation code — acks each child write only *after*
   the routing decision has been applied (an ack of delivery alone does not
   exclude coalescing; the ack must certify per-chunk routing). The
   integration tests keep byte-conservation + both-markers-present-anywhere
   invariants; only the timing-derived routing placement claims move to the
   deterministic level.
3. Budgets: helper 5s → `5_000 * scale`; file outer flat `30_000` (R4:
   16 tests × 30s = 8m ≤ 18m ✓); per-test nesting audited — multiple
   sequential helper waits sum into the table, not the default.

### F5 — watcher.spec: budgets that nest, hope-sleeps → completion signals

1. Positive waits `{ timeout: 3000 }` → `{ timeout: 5_000 * scale }`.
2. Per-test nesting with explicit allocations (the v2-style resolution, kept
   this time — codex r3-5). The malformed-JSON test (`watcher:158-176`) gets
   its outer raised **flat** to `45_000` with this allocation, valid at both
   scales: setup ~2s + two positive waits (`5s×scale` each) + one signal wait
   (`5s×scale`) + named negative window (0.5s) + headroom 12.5s at scale 2
   (32.5s used) / 27.5s at scale 1 (17.5s used) → strict inequality per R4.
   A second audit-affected test (grok r4-2): the self-write dedup test
   (`watcher:178-202`) gains its new dedup-completion signal wait under F5.3 —
   two scaled waits (2×5s×scale = 20s CI) cannot nest inside its 15s outer, so
   that test's outer also goes flat to `30_000` (scale 2: ~22.5s used < 30s ✓;
   scale 1 ~12.5s ✓). Scale-3/4 values exceed these allocations — the R4
   sizing note applies. Other tests keep their 15s outers unless their own
   audit fails. File Σ: 6×15s + 45s + 30s = 165s ≪ 18m ✓.
3. **Signals, not sleeps:** :169 — wait until the failed-reload warn is
   observed (logger spy on the existing `queueRefresh` catch path) — i.e.
   *processing completed*, not merely time elapsed. :196 — a signal
   establishing the self-write event's **dedup decision completed** (counter /
   hook / logger seam; not mere event receipt). If no adequate seam exists,
   the implementation PR adds a minimal test-observable counter as part of its
   reviewable surface (D3). `settled()` alone is not accepted. :265 stays a
   documented negative window. The :125 comment's arithmetic is deleted or
   proven.
4. Any genuinely negative observation keeps a bounded window as a named,
   commented constant.

## 5. CI observability add-on (fixed for job-cap reality)

Presubmit vitest step:

- `timeout-minutes: 25` on the step (kills the hang-all case so the upload
  step below still runs; combined with the R4 per-file ceiling of 18m, even a
  fully-hung bridge file ends on vitest's own timers before the step cap);
- `mkdir -p artifacts` before vitest (`tee` needs the directory);
- run vitest as `vitest run --reporter=default --reporter=junit
  --outputFile.junit=artifacts/vitest-junit.xml 2>&1 | tee
  artifacts/vitest.log` (default job shell is bash with pipefail, so the
  step's exit status stays vitest's unless `shell:` is overridden — no
  override here);
- `actions/upload-artifact` with `if: always()`, path `dsh-cc/artifacts/`
  (nested checkout).

Explicit guarantee scoping (codex r3-4 / grok r3-7 / codex r4-5 / critic
r4-5): the upload is **expected — not guaranteed** and not time-enforced —
on cache-hit runs, which are the operative common case (the three r1 evidence
logs all restored the harness cache — no `build:lib` step ran; their measured
prefix from job start to `$ vitest run` was 54s / 56s / 60s respectively:
jobs 110424912171, 110163848308, 109944840463). At a ~1m prefix, a 25m step
cap plus a seconds-scale upload fits the 30m job cap with ~4m slack — enough
for the observed prefix drift, not for unbounded regressions. Accepted
residual, stated not hidden: on a cache-miss run (cold `build:lib` ≈ 62% of
the pipeline per presubmit.yml:16-18) that also hits a hung suite, the jobcap
can win before the upload step and artifacts are lost; and a hit alone bounds
neither the prefix nor the upload duration — the claim is operational, not
mechanical. The junit XML is best-effort
(end-of-run writer — dies on hard kills); the tee'd log is the
expected-on-cache-hit artifact. No effect on pass/fail semantics.

## 6. Explicitly rejected / deferred options (with reasons)

- **Global `retry`** or per-hot-test retries — converts real regressions into
  invisible flakes; rejected.
- **Global root-config `testTimeout` bump** — hides seven hot files behind a
  repo-wide deadlock-latency slowdown; rejected (F2 is the targeted form).
- **skipIf(CI)** on E1/E2/E5 — coverage loss in the very environment shipped;
  rejected while deterministic fixes exist (the grok-launcher skipIf
  precedent required a vitest-itself root cause; nothing comparable here).
- **v1-F1.1 poll/child overlap — deferred.** The r1 evidence does not
  establish the sequential-poll structure as the failure driver (no poll ever
  fired its own deadline — which excludes only full-30s poll starvation);
  overlap added torn-read and floating-promise hazards for no measured
  benefit. Revisit only if F1.5's timestamped dumps show poll time in a
  future red run.
- **Splitting presubmit into two jobs (serial e2e lane)** — deferred Phase 2
  contingency; trigger threshold: ≥2 main-line e2e fork timeouts in any
  2-week window after this merges.

## 7. Rollout & verification

Single PR, commits: F1 → F2 → F3 → F4 → F5 → workflow (§5 last so artifacts
exist from the first presubmit run on the PR).

Verification (driven / pass criteria):

- Local, per touched spec: isolated `vitest run <path>` ×5 green.
- F3: full root suite (`pnpm test`) ×2 local green — the load/interleaving
  regime CI exercises must actually be present; plus spike.spec ×10 solo.
- F1: timestamped-dump path exercised deliberately once (artificially wedged
  child) — output shape verified, not only the green path.
- **Negative mutation demonstrations (r2-addition; the PR must show each):**
  F3's new assertions reject a wrong/missing/duplicate suffix prompt, a wrong
  freeze boundary, a reversed per-item stage pair, and a wrong cached/live
  marking respectively; F3's positive counterpart: a forced inter-fan swap in
  run 3 *passes* (proves engine-owned ordering was not re-imported); F1: a
  wedged child ends with teardown completing inside the hook budget (with or
  without confirmed termination — the `teardown-incomplete` marker line is
  the evidence either way), the inner-envelope expiry fires with the dump
  even when the wedge is *inside setup* **and the wedge demo additionally
  asserts the half-built world WAS registered in `worlds[]` and the disposal
  pass ran on that partial world** (grok r4-6's hole, asserted — codex r5-2 /
  grok r5-1 both caught §7 not carrying it), and a wedged fixture spawn on a
  signal-cooperative child is bounded by its envelope-clamped timeout (the
  signal-*ignoring* variant is the accepted external-termination residual of
  F1.6, outside worker-side diagnostics by construction); F1.4's truncated-final-line writer
  fails the terminal read; teardown adverse cases: a child spawned late
  (after seal) is refused, an interrupt-resistant child does not hang the
  hook; F4 loses no bytes and no markers under coalesced chunk delivery
  (driven through the deterministic seam; if the ack fallback is chosen
  instead: parent-ack-before-routing demonstrably rejects mis-routed chunks);
  F5's two new signal waits fail if the intended processing path is removed
  (mutation check).
- CI: the PR's presubmit green; then an empty-baseline probe PR off the merge
  result rerun ×3 green. Acceptance is falsifiable: any M5/M6 vitest timeout
  or hook-cluster 5s timeout on the probes re-opens the E-class.
- Rollback: `git revert` of the merge commit; no migrations.

## 8. Review ledger

Lanes per round: critic (`dsh-cc-agents:critic`, Opus), codex via
cc-codex-bridge (r1: gpt-5.6-sol, 83k tokens; r2: gpt-6-astra, 22k tokens),
grok via cc-grok-bridge.

**grok lane: interrupted in r1 — `Not signed in` auth failure,
deterministic, pre-review (no judgment was formed; not substitutable per lane
rules). User elected to re-auth (device-code) for a fresh grok seat in r3.
Recorded as interrupted, not as a passed or waived seat.**

**Round 1** — critic SHIP-WITH-FIXES (2 Critical, 5 Major, 3 Minor); codex
NO-GO (8 Major, 2 Minor). Dispositions (v1→v2):

- critic-C1 / codex-1 (overlap doesn't address observed failure; signature
  analysis vitest-timeout ≠ waitFor-deadline): accepted — F1.1 deferred; E1
  mechanism rewritten.
- critic-C2a / codex-2 (torn reads in `payloads()`): accepted — F1.4.
- critic-C2b / codex-3 (floating promise, bounded child, disposal,
  collector-resubscription hazard, unbounded spawnSync): accepted — F1.1-env,
  F1.3, F1.6.
- critic-3 / codex-8 (300s breaks the job cap; artifacts dead on timeout):
  accepted — outer reduced (150s), R4 bound, §5 tee+pipefail+always().
- critic-4 ("strictly stronger" rhetoric): accepted — cut.
- critic-5 / codex-4 + Q3 (F3 loses freeze-index and exactness): accepted —
  F3.1/3.2/3.5.
- critic-6 / codex-5 (F2 list exceeds corpus; internal 5s helpers; 6×≠3×):
  accepted — attested set only; F2.2 helper audit.
- critic-7 / codex-9 (CI-env parse leaky; no local knob): accepted — strict
  parse + override.
- codex-6 (E5 hope-sleeps / settled() insufficient / nesting / :125 claim):
  accepted — F5.2–5.4.
- codex-7 (chunk coalescing; helper 5s vs outer 5s): accepted — F4.2/4.3.
- codex-10 (executable verification criteria; tee/artifacts details):
  accepted — §5/§7.
- critic-8 (shunt-gate teardown): partially accepted — audit-only scope;
  teardown measurement added to the audit.
- critic-9 (evidence citation): accepted — §1 sources.
- Adjudications: **Q2 — dissent resolved for duplication** (codex wanted a
  shared helper; critic cited check-spec-deps plumbing; decided byte-identical
  duplication + grep marker; revisit if a sixth consumer appears). Q1:
  numbers derived from job-cap arithmetic (r2 re-derived them again). Q4:
  attested-red only; shunt-gate audit read-only.

**Round 2 (v2 object)** — critic SHIP-WITH-FIXES (3 Major, 6 Minor); codex
NO-GO (7 Major, 2 Minor; round-1-fold honesty challenged on several items —
fair criticism, the v2 ledger had overclaimed "accepted" where dispositions
were partial). Convergent dispositions (v2→v3):

- critic-1 / codex-2 (**F1 violates its own R4**: 120s fork + sequential 30s
  polls > 150s outer): accepted — F1.1 is now one 90s envelope covering
  fork+polls+waitNoActivation with `remaining()` handoffs; outer 120s; per-file
  Σ 870s ≤ 15m; step cap 20m (§5).
- critic-3 (F3.5's absolute seq 1..10 likely wrong — session-scoped seqs):
  accepted — relative contiguity + D4 implementation pin.
- critic-4 / codex-5 (trailing-line tolerance needs its discriminator and a
  terminal strict read): accepted — F1.4 provisional-vs-terminal protocol +
  truncated-writer negative demo in §7.
- critic-5 / codex-6 (Number() foot-guns; override voids R4): accepted —
  validated parse; `>2` voids-R4 documented.
- codex-1 (E1 attribution overclaimed): accepted — hedged to "consistent
  with / rules out poll-starvation"; phase split deferred to F1.5's shipped
  instrumentation.
- codex-3 (job-cap guarantee incomplete; upload not time-reserved; paths):
  accepted — step-level `timeout-minutes: 20`, explicit mkdir + nested paths,
  junit-vs-tee guarantee explicitly scoped.
- codex-4 (disposal ≠ isolation; late-creation race; unbounded teardown):
  accepted — F1.3's pinned close→bounded-interrupt→dispose→clear order; D1
  carries the API pin requirement.
- codex-7 (§7 proved permissiveness, not retained rejection): accepted —
  negative mutation demonstrations now listed per fix.
- codex-8 (F4 ack must certify routing; F5 signal must certify dedup-decision
  completion): accepted — F4.2/F5.3 wording.
- codex-9 (F2's "15s walls" contradicted its own constants; multi-wait chains
  exceed defaults): accepted — F2.3/2.4.
- **Adjudication — critic-2 vs codex-7 on F3.2 fan order:** codex called the
  ordered first-two check "sufficient to preserve guarantees"; critic showed
  inter-fan arrival order inside one `parallel(...)` is engine-owned (same
  class E3 deletes) and proposed the set form. Decided for the **set form**:
  freeze-boundary position is the guarantee; inter-fan order is not — codex's
  sufficiency claim is compatible (the set form preserves the same boundary
  fact) where its ordered form would re-import the deleted flake class.
- critic-6 (flat-vs-scaled in F1 needs one sentence): accepted — F1.2 states
  it. critic-7 (:247/:249 mislabeled): accepted — F4.1 relabeled. critic-8
  (junit dies when it matters): accepted — §5 explicit. critic-9 (R4
  self-enforcement): accepted — recorded as decision + lint follow-up note.
- codex's "fold honesty" charge is itself recorded: the v3 ledger distinguishes
  folded / partially-folded / adjudicated.

**Round 3 (v3 object; grok seat re-armed)** — critic SHIP-WITH-FIXES (1 Major,
5 Minor; all its r2 findings verified honestly folded); codex NO-GO (5 Major,
2 Minor; fold-honesty: "materially improved, still overstated on 4 points" —
fair, folded now); grok NO-GO (1 Critical, 6 Major, 3 Minor). Dispositions
(v3→v4):

- **hookTimeout** (critic r3-1 / codex r3-1 / grok r3-C1 — all three lanes
  converged on the same unbudgeted timer): accepted — F1.3 now budgets hooks
  explicitly (`hookTimeout: 30_000 * scale` in the bridge files, bounded
  interrupt wait `4_000 * scale`, R4 per-file sums include hook allowances,
  942s = 15.7m ≤ 16m).
- codex r3-2 / grok partially (disposal termination + admission barrier):
  accepted — F1.3's order is seal → bounded-join in-flight admission →
  bounded interrupt → dispose → clear, with a `teardown-incomplete` marker
  when termination is unconfirmed; honest residual documented (cooperative
  interrupt is best-effort; §7 gains delayed-creation and interrupt-resistant
  cases).
- codex r3-3 (spawnSync outside the envelope; SIGTERM resistance): accepted —
  envelope-clamped `remaining()` timeout; SIGTERM-trapping residual
  documented as inert for the fixed echo fixture.
- codex r3-4 / grok r3-7 (upload not time-reserved; cold cache): accepted —
  guarantee scoped to cache-hit runs with measured pre-step time; cold-cache
  hung-suite artifact loss stated as an accepted residual.
- codex r3-5 (F5 budget regression vs v2): accepted — F5.2 restored explicit
  allocation, malformed-JSON outer flat 45s with the table.
- codex r3-6 / grok r3-3 ("rules out" too strong): accepted — E1 and §6
  reworded; only full-30s poll starvation is excluded; phase split stays
  unproven; consequence folded into F1.1 (envelope covers setup).
- grok r3-2 (90+30<120 is equality; envelope starts at fork dispatch, setup
  uncovered): accepted with the F1.1/F1.2 rewrite.
- grok r3-4 (F2/F4 `*scale` outers breach R4: bridge 17×60s=17m, events 16m,
  stdio 16m): accepted — F2/F4 outers went flat (30s unscaled), helpers kept
  scaled; per-file sums re-tabulated in F2's text.
- grok r3-6 (F4.2 misses the sibling :218 B/C routing claims): accepted —
  F4.2 scope extended to all `childConfig`-timed routing claims.
- grok r3-8 (:227/:234 is not a header site): accepted — F4.1 relisted.
- grok r3-9 (E3 freeze-boundary wording; §7 needs the positive inter-fan-swap
  demo): accepted — E3 reworded (boundary at the `fan 2` slot, inclusive);
  §7 gains the swap-passes demo.
- grok r3-10 (547→540 dedup; safety-loop mostly 5s; shunt-gate is the same
  foreground structure with 40s outers, contradicting codex r2-Q4's
  "background-launch/30s" label): accepted — §1 figure corrected, E2
  correction noted, F1's shunt-audit scope unchanged but its structure label
  corrected (grok's code-verified reading stands over codex's r2 shorthand).
- critic r3-2 (strict inequality text): accepted — R4 states `<`, F1.2's
  numbers satisfy it strictly with written headroom.
- critic r3-3 (envelope split is a hypothesis bet — say so): accepted —
  F1.1 states it.
- critic r3-5 (scale ceiling): accepted — snippet clamps to [1,4].
- critic r3-6 ("pageant" typo; 150s attribution): accepted — fixed.
- codex r3-7 (§7 must cover the F4 ack fallback too): accepted.

 **Round 4 (v4 object)** — critic SHIP-WITH-FIXES (1M+4m, all its r3 folds
verified honest); codex NO-GO (3M+2m, arithmetic/precision class —
convergent with critic's on envelope scope, headroom, teardown accounting,
§5 citation); grok NO-GO (1C+2M+4m — its Critical and codex's teardown
accounting are the same issue from two directions). Dispositions (v4→v5):

- critic r4-1 / codex r4-1 (envelope-vs-seven-outer ambiguity): accepted —
  F1.1's envelope is now derived per test (`outer − 30s`: 90s M5/M6, 60s for
  the seven); every test's envelope fires 30s before its outer.
- critic r4-2 (equality-as-inequality phrasing): accepted — envelope < outer
  with setup inside.
- critic r4-3 / codex r4-4 / grok r4-3 (F5 headroom figures): accepted —
  12.5s @scale-2 / 27.5s @scale-1; scale-3/4 exclusion noted.
- critic r4-4 / codex r4-2 / grok r4-1 (**the Critical** — R4 must count the
  timer vitest actually enforces): accepted, resolved by ceiling-consistent
  numbers — `hookTimeout` flat 15s (not 30s×scale); R4 per-file bound
  restated as ceiling semantics ≤ 18m; vitest step cap raised to 25m; bridge
  file at ceiling: 870 + 9×15 + 2×15 = 1035s = 17m15s ≤ 18m ✓ (expected-case
  window stays 4s×scale; expected vs ceiling both written into F1.3). The
  two afterAll hooks are now counted — grok's catch.
- codex r4-3 (spawnSync clamp overrun; "echo-only" justification inaccurate):
  accepted — `remaining − 1s` guard, fail-fast below it; justification
  corrected to hermetic-PATH fast refusal.
- grok r4-2 (F5's second audit-affected test — the self-write dedup test's
  two scaled waits cannot nest in 15s): accepted — flat 30s outer + table;
  watcher Σ now 165s.
- grok r4-4 (shunt-gate structure label stale in F1's scope paragraph despite
  the r3-10 ledger entry): accepted — F1 scope text corrected to the
  foreground-adjacent structure (mixed 30s/40s outers; only :243 is
  background-pinned).
- grok r4-5 (my E2 correction itself overshot safety-loop's budgets):
  accepted — six explicitly-budgeted tests + fourteen defaulted, all
  enumerated.
- grok r4-6 (envelope-abort mid-setup leaves a half-built world un-registered
  for the disposal pass): accepted — `setup()` registers the world in
  `worlds[]` at construction; teardown chain tolerates partial worlds; the
  setup-wedge §7 demo asserts registration happened.
- critic r4-5 / codex r4-5 / grok r4's §5 arithmetic check (pre-step figure
  uncited): **accepted with better data than either side guessed** — the r1
  evidence logs measure the cache-hit prefix at 54s/56s/60s; wording demoted
  to "expected, not guaranteed".
- codex's remaining pass notes (E1 hedging, §7 demos, F2/F4 sums, F4 sibling
  scope, 540, validator) and grok's folded-cleanly list (r3-2/3/4/6/8/9/10)
  recorded as accepted-by-lane.

**Round 5 (v5 object)** — critic **GO** (3 minors, all folded: teardown-window
clamp `Math.min(4_000*scale, 13_000)` vs the flat 15s ceiling; "two afterAlls"
parenthetical; F2 sums labeled pre-audit floors); codex NO-GO (1 Major, 2
Minor); grok SHIP-WITH-FIXES (2 Minor). Dispersions (v5 → v5-final):

- codex r5-1 / grok r5-2 (**convergent**: the SIGTERM-ignoring spawnSync wedges
  the whole worker event loop — codex reproduced it live with a probe — so the
  "envelope dump and teardown still fire" promise was impossible text):
  accepted — F1.6 rewritten to state external-termination as the only bound
  for that case; §7's wedged-spawn demo scoped to the signal-cooperative path;
  fixture-stability gating note kept.
- codex r5-2 / grok r5-1 (**convergent**: §7 never asserted the registration
  the r4 fold introduced; my ledger overclaimed it did): accepted — the
  setup-wedge demo now asserts `worlds[]` registration + partial-world
  disposal, and the ledger language was corrected (this entry exists because
  §8 said "asserts registration happened" before §7 did).
- codex r5-3 (F2 terminology: helpers vs unbounded delegates like
  `waitForIdle()` vs pre-existing third-arg overrides): accepted — F2.3 now
  audits three distinct deadline classes; K≤2 is scoped to class (a).

**Round 6 (delta-only confirmation)** — codex **GO** ("No NO-GO-class issue
remains"; r5-1/r5-2/r5-3 each verified closed against text, fold-honesty
confirmed, noting this confirms design text, not implementation); grok
**GO** (both r5 minors verified closed; clamp/afterAll/F2-floors/F2.3 folds
audited; no arithmetic or guarantee regression). **Review arc closed:
critic GO (r5), codex GO (r6), grok GO (r6). User sign-off pending.**

## 9. Residual decisions for the implementation PR (not review blockers)

- D1. Exact seal/dispose/interrupt APIs for F1.3's pinned order — code-
  referenced at implementation; the guarantees (no new admissions after seal,
  in-flight admissions bounded-joined, bounded interrupt, teardown fits the
  hook budget, registry cleared) are the requirement, the calls are the
  choice.
- D2. F4.2's deterministic seam vs routing-ack fallback — implementer chooses
  and states why.
- D3. F5.3's dedup-completion seam — implementer pins; a new product-visible
  hook would be its own reviewable point in the PR.
- D4. Whether `agent-start` seq is session-global (run-3 rows start at 21) —
  pinned against the journal provider source at implementation; F3.5 only
  asserts relative contiguity + runId filtering + cached-by-position.
