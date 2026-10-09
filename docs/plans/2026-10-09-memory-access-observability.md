# Memory access observability: recall logging + outcome attribution (design)

- Date: 2026-10-09
- Status: draft v3 — internal critic GO after 2 rounds; user sign-off pending. NOT yet implemented.
- Scope: instrumentation inside the existing packages `packages/memory/memory` and `packages/memory/memory-consolidation`; new typed session events + one JSONL ledger. Capability manifest evidence updates. No new package. No behavior change to recall/save/dream semantics.
- Sources: MemCon (memory access — retrieve/re-retrieve/consolidate/forget — is the hard control problem; fixed heuristics are being superseded; +15.2pp / −5–20% tokens when learned), AMV-L (retrieval-path P99 grows with session lifetime when lifecycle is age-driven instead of cost-driven), Harness-Evolution-as-Learning (self-updating loops plateau at ~0.48 violation rate vs 0.071 oracle — memory accumulation alone does not converge to preference compliance). All three agree on the prerequisite: measure ops and outcomes before controlling them.

## 1. Problem

dsh-cc's memory subsystem already has structure (MEMORY.md index + topic files,
workspace/global scopes, pressure→forced-dream). What it lacks is any feedback
loop:

- **Recall is unmeasured.** `MemoryRecall.maybeRecall`
  (`packages/memory/memory/src/recall.ts:302-385`; the `agent/pre-step` handler
  `:274-300`, top-level agents only `:293-294`) selects ≤5 topics
  (`MAX_RECALL_MEMORIES`, `recall.ts:31`) and injects them as a durable next-step
  `user/message` with `source.kind='memory'` (`recall.ts:378-381`). Nothing
  records *which* topics were picked, at what cost, or whether the following
  turn actually used them.
- **Retrieval cost is unaccounted.** AMV-L's point applies verbatim to the
  file-store: candidate set size and selector latency grow as the topic library
  accretes (candidates are `{path, filename, description}` scanned from both
  layers; `scanMemoryDirectory` calls the per-layer candidate mappers at
  `recall.ts:325-328` and maps them at `recall.ts:347-352`), and nobody sees
  the curve.
- **Dream/consolidation quality is unmeasured.** The pressure lifecycle
  (armPressure at `save.ts:229-234`, forced run at
  `memory-consolidation/src/index.ts:300-322`, pressure file protocol at
  `pressure.ts:19,30`) fires blind: did the dream actually change downstream
  behavior? Unknown today.

MemCon and Harness-Evolution-as-Learning jointly justify doing *logging first*:
a controller without an outcome signal is astrology; and the plateau result
says do not build the controller until the measurements support it.

Probe-verified seams (2026-10-09, this worktree):

- Per-turn attribution precedent exists and is proven: advisor-watchdog keeps the
  newest loop-stamped request's `messages` snapshot per session from an
  `llm/stream` listener (`packages/interaction/advisor-watchdog/src/wiring.ts:88-97`,
  `{global:true,prepend:true}`, cache-health precedent
  `packages/observability/cache-health/src/index.ts:152-158`), then diffs at
  `agent/turn-stopping` (`wiring.ts:99-107`) using a cursor (`delta.ts:37-42`)
  over `reviewWindow(snapshot, cursor)` (`delta.ts:100-111`), with
  injected-source filtering (`isInjected`) and staleness reset
  (`len < count || tail mismatch`). The snapshot blocks carry role/text/
  tool-name/args (`delta.ts:44-59`).
- `memory_save`'s handler receives `exec.agent` (`save.ts:189`) so
  `exec.agent.session` is reachable for typed event appends — none exist today
  (probe: ABSENT inside the memory package).
- Session event plumbing: `session.append` + `SessionEventMap` augmentation
  (pattern `packages/hooks/hook-protocol/src/types.ts:8-9`); firehose consumer
  precedent `packages/hooks/hooks-claude-code/src/register-events.ts:264`.

## 2. Goals and non-goals

Goals:

1. **L1 — recall-op logging.** Every recall injection records: selected topic
   names, candidate count, candidate bytes total, selection latency, query
   digest (not text). Session event + JSONL ledger row.
2. **L2 — outcome attribution.** For each recall event, after the next turn
   stops, classify each recalled topic used/unused by a deterministic heuristic
   (§3.3) over that turn's delta; append outcome events.
3. **L3 — dream/pressure lifecycle logging.** Arm/forced-run/cleared transitions
   record timestamps + outcomes necessary to compute dream cadence and stack-ups.

Non-goals:

- **No controller.** No bandit, no policy changes to selection/injection/dream
  triggering (MemCon-shaped control is a §7 design study gated on this data).
- **No schema change to memory files or the index.** Read-only against the
  store; append-only beside it.
- **No cross-session personalization.** Per-workspace ledger only (global-scope
  memories are logged with their scope tag but the ledger stays per-workspace).

## 3. Design

### 3.1 Where the code lives

The L1 field collection and the L2 cursor/listener code live in a NEW file
`packages/memory/memory/src/recall-telemetry.ts` (recall.ts is ~400 lines vs
the 500-line cap). Extend `packages/memory/memory` (recall + save
instrumentation) and `packages/memory/memory-consolidation` (dream lifecycle
logging). No new package; capability manifest evidence rows updated in the
same commit (memory rows already exist for recall/save; events are evidence
additions, not new surfaces — confirm with `pnpm check:capabilities`).

### 3.2 L1 — recall logging

At the existing injection site (`recall.ts:378-381`), after a successful
`agent.inject`:

```jsonc
// session event 'memory/recall' + ledger row
{ "v":1, "ts", "sessionId",
  "topics": [ { "name", "scope", "path" }, … ],  // selected topics (≤5);
        // scope = workspace|global; identity is {name, scope, path} because
        // the same name can exist in both layers (recall.ts keys its
        // shown-tracking by full path at :321-323 for exactly this reason)
  "topicsTotal": 47,                  // library size after scan (recall.ts:329)
  "candidateCount": 12,               // fresh-filtered candidate set at select
                                      // time (recall.ts:340) — both are logged
                                      // so the AMV-L growth curve stays
                                      // measurable as shown-filtering shrinks
                                      // the effective candidate pool
  "candidateBytes": 18340,            // sum of candidate topic file byte sizes
  "selectorLatencyMs": 42,
  "queryDigest": "ab12…",             // sha256(query)[:16], never the text
  "budget": { "maxTopics": 5 } }
```

`candidateBytes`: extend `scanMemoryDirectory` to also return per-candidate
byte sizes — it already touches every file, so this costs zero extra
syscalls; `candidateBytes` sums those. Primary decision; fallback if that
proves awkward at implementation: `await fs.stat(path)` per candidate via the
ctx fs seam (precedent `pressure.ts:43`, `paths.ts:251`). NO `node:fs` use.

Note that `maybeRecall` fires per new user query, not once per session — it
is deduped by `lastQuery` (`recall.ts:338`) and the shown-set
(`recall.ts:340`) — so per-candidate work runs at query frequency, which is
why the byte-size path is chosen to be syscall-free.

Ledger: `<memoryHome>/projects/<slug>/memory-telemetry.jsonl` — reuses the
EXISTING project slug mapping (`paths.ts:184-191` idiom). This deviates from
the handoff-store `sha256(cwd)[:16]` convention deliberately: the memory
store already keys all per-project state by one identifier, and telemetry
must join with it (one project = one identifier). Detached
`void appendFile().catch(debugLog)`.

### 3.3 L2 — outcome attribution

New listener in the memory package: `agent/turn-stopping`, carrying a per-session
cursor over an `llm/stream` snapshot (advisor-watchdog shape, replicated
locally — do NOT import advisor-watchdog internals; the packages are siblings
with separate lifecycles; duplicate the ~60-line cursor/delta machinery,
note this deviation in the module header).

Window mechanics: at each `memory/recall` emission, record the advisor-shaped
fullCursor for that session (the `llm/stream` snapshot cursor,
`advisor-watchdog/src/delta.ts:80-85`). At `agent/turn-stopping` the
attribution window is `snapshot.slice(cursor.count)`, with the staleness
reset rule (`delta.ts:107`).

Ordering subtlety (stated so the slice is understood): the injected memory
user-message only enters the llm/stream snapshot with the NEXT loop-stamped
request — `agent.inject` splices into the pending messages, and the running
snapshot predates it. Slicing from the pre-inject cursor therefore *includes*
the injected message in the window; the copied `isInjected` filter (denylist
includes `'memory'`, `advisor-watchdog/src/delta.ts:24-31`) drops it from the
haystack. First turn-stop after a recall whose snapshot never advanced yields
an *absent* outcome row (not a wrong one) — the reset/slice rule naturally
produces an empty window, and absence is logged as absence.

Attribution: a recalled topic counts as **used** iff it appears in the
window's assistant text or tool arguments. Matching: ASCII topic names use
case-insensitive word-boundary `\b` matching; non-ASCII names (CJK) fall back
to substring match on the NFKC-folded haystack (Unicode-aware folding,
advisor's CJK-collapse lesson). JS `\b` is ASCII-only — that ASCII-only
boundary is exactly the bug this fallback avoids. Names shorter than 4
characters are excluded from matching (noise).
Multiple concurrent recalls attribute independently.

Outcome event: `session.append('memory/recall-outcome', { v:1, ts:…, topics:
[{name, scope, path, used:boolean}] , turn })` — same `{name, scope, path}`
identity as the recall event — + ledger row. Deterministic, no model calls
(MemCon's "no extra LLM calls" discipline for the measurement layer too).

Known false-positive class (documented): a topic name that equals an ordinary
word rates "used" spuriously; mitigated by the ≥4-char + word-boundary rule and
accepted as a conservative bias (over-attribution toward *used* is the honest
direction: it biases future controller decisions toward *less* recall).

### 3.4 L3 — dream/pressure lifecycle logging

At the existing sites (names from probe):
- arm: `save.ts:229-234` (`armPressure`) → event `memory/pressure-armed`.
- forced run start/result: `memory-consolidation/src/index.ts:300-322`
  → `memory/dream-forced {ok:boolean, changedFiles:[names], latencyMs}`.
- clear: `pressure.ts:119` tombstone → folded into the forced-run event (single
  event per cycle; armedAt from `pressure.ts:30` wire format).
Same ledger + event discipline as L1.

### 3.5 Configuration

NO settings namespace is added (no `registerNamespaceSafe`). Read keys
`memory-telemetry.enabled` (default `true`) and
`memory-telemetry.attribution` (default `true`) from the user-layer
`<dshHome>/settings.json` via the local raw sync reader idiom
(`readUserSettingsSync`, precedent
`packages/interaction/advisor-watchdog/src/settings.ts:161`). That reader is
advisor-local and NOT importable (no-cross-package-import rule); memory
copies the idiom locally. Both read
per-event (hot toggling for free). The dual-half namespace path (namespace
registration for /config visibility) is deferred until /config visibility
for these keys is actually requested.

### 3.6 Failure discipline

Observe-only everywhere; snapshot/cursor failures reset the cursor
(advisor-watchdog's reset rule, `delta.ts:107`); all file errors swallow +
debug. `session.append` outside an open turn throws (hook-protocol
`invariants.spec` precedent), and the recall emission is fire-and-forget so
it can settle near a turn boundary — the swallow discipline therefore applies
to the append CALL specifically (try/catch + debug log), never to attribution
decisions. Every event row carries `turn` when known. No waterfall decision
is touched by any listener in this design.

Denylist drift (F6): the copied injected-source denylist must copy the
advisor's `KNOW-YOUR-INJECTOR` comment verbatim (any new injected source kind
must be added to ALL copies or a self-feeding phantom loop re-opens). No existing shared module is a legal common home for
`INJECTED_SOURCE_DENYLIST`: the only dependency the two packages share is
`model-aliases` (memory deps: model-aliases, tools; advisor deps:
model-aliases, permission-rules, settings-ns, side-query), which is
domain-mismatched for an injected-source denylist, so the copies stay local
and a cross-package test asserts the two copies are array-equal.

## 4. Edge cases

- Subagent sessions: recall is top-level-only, so recall events carry the main
  session id; attribution listeners skip subagents (`delegationDepth` from the
  header — `session.header.delegationDepth`, session-transcript format fact).
- `/resume`: cursor/snapshot state is in-memory only; after resume the first
  turn's attribution for a pre-suspend recall is simply absent (reset rule);
  the ledger is append-only so history survives.
- Multiple projects in one session dir: the ledger path follows the session
  cwd via the existing project slug mapping (`paths.ts:184-191`), consistent
  with how the memory dir resolves (`packages/memory/memory/src/paths.ts:191`).

## 5. Verification plan

1. Unit: recall event fields — synthetic candidates, fixed clock; digest never
   equals raw query (grep test over ledger seed corpus).
2. Unit: attribution matcher — CJK names, 3-char exclusion, word boundaries,
   NFKC; used/unused fixture table.
3. Unit: cursor reset on snapshot regression (shorter array / tail mismatch) —
   replicate advisor's own reset tests against the local copy.
4. Integration (testkit): session with fake memory dir → first user prompt ⇒
   exactly one `memory/recall`; next turn-stop ⇒ exactly one
   `memory/recall-outcome`; injected `source.kind='memory'` user message never
   counted as "user text" in the attribution window (isInjected filter).
5. Integration: same topic name present in workspace AND global layers ⇒
   two distinct recall rows (scope/path disambiguation, §3.2 identity).
6. Integration: window-boundary case — the selector settles on the final
   step of a turn; the outcome window for that recall is the next turn's
   delta, and a never-advanced snapshot yields an absent (not wrong) outcome
   row.
7. Cross-package: copied `INJECTED_SOURCE_DENYLIST` equals the advisor's
   (array-equality assertion, §3.6).
8. Gates: `pnpm check:capabilities` evidence update, `docs:parity`,
   `check:file-size`, `check-spec-deps` if the spec imports harness packages
   (declare devDeps). Probe test first for the `agent.inject` splice timing:
   if the injected message does not surface in the next snapshot, the slice
   point shifts by one message (upstream-unverifiable; §3.3 states the
   expected behavior — verify before relying on it).
9. Integration: probe/assert that a forced dream run and a save-side
   validation pass leave `memory-telemetry.jsonl` — and any non-.md,
   non-marker file — in the workspace memory dir untouched (scan.ts:56
   already filters to .md so recall is safe; this pins dream/validation/
   UI-listing interactions).

Dogfood: two weeks of passive logging on the dsh-cc workspace; review artifact =
one awk/jq rollup over the ledger: recall rate, candidate count trend, used-rate
per topic, dream cadence. Decision gate for the §7 controller: used-rate signal
must exist above noise before any control policy ships (A11).

## 6. Why logging-only is the honest increment

MemCon's claim is that *access policy* is learnable control. Harness-Evolution-
as-Learning tempers it: naive self-updating plateaus far from oracle. The shared
prerequisite is this telemetry; the falsified variant (deploy a controller on
unmeasured ops) is the 12227 trap. This design therefore ships no control and
states that plainly.

## 7. Follow-ups

1. MemCon-shaped control study (retrieve/skip/consolidate policy over this
   telemetry), gated on dogfood signal + held-out discipline.
2. AMV-L-style cost caps: selection latency/candidate budgets derived from the
   measured P99 curve, not TTL.
3. Dream-quality signal: downstream used-rate delta for topics a dream rewrote.

## 8. Review ledger

- Round 1 (critic, 2026-10-09): 10 findings, all adopted.
  - Anchor fixes (candidates mapping recall.ts:347-352 vs scanMemoryDirectory
    call :325-328; pre-step handler :274-300; `armPrice`→`armPressure` typo).
  - F1 window mechanics: cursor-recorded at emission, slice + reset rule,
    inject-enters-next-snapshot ordering subtlety, absent-not-wrong outcome.
  - F2 candidateBytes via scanMemoryDirectory sizes (no `node:fs`), fs-seam
    `await fs.stat(path)` fallback only.
  - F3 maybeRecall fires per new user query, not per session; log both
    `topicsTotal` and `candidateCount`.
  - F4 topic identity `{name, scope, path}` on recall + outcome rows.
  - F5 CJK substring fallback on NFKC-folded haystack; JS `\b` is ASCII-only.
  - F6 denylist KNOW-YOUR-INJECTOR comment copied verbatim; no legal shared
    home exists → cross-package equality test instead.
  - F7 no settings namespace; raw user-layer sync read; /config deferred.
  - F8 append-call-specific try/catch (append outside an open turn throws);
    `turn` carried when known.
  - F9 new file `recall-telemetry.ts` (recall.ts ~400/500-line cap).
  - F10 ledger under `<memoryHome>/projects/<slug>/` (existing slug mapping),
    deviation from handoff-store sha256 convention stated.
  - Upstream-unverifiable: `agent.inject` splice timing — if inject does not
    surface in the next snapshot, the slice point shifts by one message; a
    probe test runs first (§5 item 8).
  - Status: draft v2; round-2 confirm pending; user sign-off pending.
- Round 2 (critic, 2026-10-09): verdict GO; N1/N2/N3 folded.
  - N1 dep-list fix in §3.6/F6 (sole shared dep is model-aliases; dep lists
    corrected; conclusion unchanged: local copies + equality test).
  - N2 raw-reader precedent anchor corrected to settings.ts:161
    (readUserSettingsSync); reader is advisor-local — memory copies the
    idiom, does not import.
  - N3 added §5 item 9: dream/validation leave the telemetry ledger and
    other non-.md files in the workspace memory dir untouched.
