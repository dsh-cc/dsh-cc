# CCR Deferred Externalization: send full output twice, swap on the third request

Date: 2026-09-20. Status: design — two reviews passed with amendments, all baked in.
Second (pre-implementation, code-grounded) review: GO-WITH-AMENDMENTS — B1 cache-safety
test claims rewritten (the cited test was vacuous), M1 `eventSeq` dropped from the
resident entry (unknowable at insertion time), M2 subagent-exclusion rationale corrected,
plus four minor pins (listener registration flags, ledger path, Phase-0 test scope,
dry-run I/O divergence). First review (7 findings:
gate arithmetic rewritten to suffix cost, prune-row pairing added to the swap, all swaps
pinned to the pre-step boundary, send counting moved to first-chunk with a purpose
allowlist; all baked in below).

Origin: SoL-Pi (arXiv:2609.20519) ObservationPack — the only one of the four retained
mechanisms that *improved* the capability score (+5.3% on Sol, and its counterpart slot on
Opus). Its insight: a large tool result is most valuable immediately after it is produced;
externalizing it at once either forces a wasted `context_retrieve` round-trip or silently
costs the model the evidence it needed on the very next step. ObservationPack therefore
archives >10 KiB outputs locally but **keeps the full text in-context for the first two
provider requests**, then replaces it with a stable handle plus short head/tail excerpts.
Retrieve-by-handle gives exact paging back.

## 1. Problem

dsh-cc's context-crusher (PR #34) implements immediate externalization: the post-execute
handler rewrites an eligible result's content into `[compressed body + ccr:// marker]`
before the result is appended to the session. PR #34 deliberately guaranteed
byte-stability of already-sent events (the cache-safety test asserts `snapshotEvents()`
never changes), so today there is exactly one externalization point — insertion time.

That single point is the wrong one for a subset of outputs. A 40 KiB failing-build log the
agent will dissect over the next two model calls pays a retrieve round-trip tax under
immediate externalization, while a 40 KiB search result nobody reads again pays a lifetime
input-token tax if we keep it. The paper's answer — age-based deferral with a fixed small
residency — splits the difference. Concretely for us:

1. Add an optional *deferred* mode to the crusher: eligible results are stored immediately
   (so evidence is durable) but their content enters the session **unmodified**.
2. Count how many subsequent provider requests included that message.
3. When the counter crosses the residency threshold (default 2, paper parity), rewrite the
   session surface in place, swapping the full text for the standard stub + marker.

## 2. Ground facts (verified 2026-09-20 against this checkout; re-verified in review)

Harness-repo anchors are read-only per the harness-repo-readonly directive.

- **Deferred in-place rewrite already exists elsewhere in the stack.** Microcompact's
  replacement is TWO adjacent appends: `session.append('compaction/prune',
  { shadowedRange, shadowedSeqs, shadowedTokenCount })` (so the token meter subtracts the
  shadowed node) followed by `session.append('tool/result', replacement, { surfaceOp:
  { op: 'replace', startSeq, endSeq }, sourceEventSeqs })`, with every non-content field of
  the original block preserved (`{...resultBlock, content: [...]}`)
  (`packages/compaction/compaction-micro/src/index.ts:239-309`, prune at `:278`,
  replacement at `:284`). Replacements committed earlier in a pass stay durable if a later
  one fails (doc comment `:230-240`). §3.3's swap reuses this exact paired shape; no new
  session surgery is invented here.
- **Crusher stubs are never re-substituted**: the microcompact guard
  `if (isCrusherStub(plainText(blocks))) continue` (`compaction-micro/src/index.ts:254`)
  protects any body containing a `ccr://` marker line. Our swap targets only messages that
  are *not* stubs; after the swap they *become* stubs and fall under the same protection.
- Provider-request observation: `ctx.on('llm/stream', listener, { global: true,
  prepend: true })` precedents (`packages/observability/cache-health/src/index.ts:148-160`,
  `packages/llm-tuning/reasoning-fold/src/index.ts:82-86`). `GenerateOptions` exposes
  `sessionId`, `provider`, `model`, and the full outbound prompt — `PrefixTracker.observe`
  hashes `[options.system, options.tools, ...options.messages]`
  (`cache-health/src/tracker.ts:107`) — and the owning session is reachable via
  `ctx.sessions.get(options.sessionId)` (`cache-health/src/index.ts:103`). Fingerprinting
  tool-result blocks inside `options.messages` is therefore a local computation, exactly
  as §3.2 assumes. Stream chunks are observable too (first-chunk timing used in §3.2).
- Crusher insertion-time path: `context-crusher/src/index.ts:178-201` — savings check at
  `:178`, store put at `:187-190`, replacement assembly at `:192-195`, decision rewrite at
  `:197-201`. When deferral applies, steps `:192-201` are skipped; `:187-190` still runs.
- PR #34's composition test contains a *vacuous* byte-stability assertion (it compares each
  event to its own deep clone). Deferred mode amends the test story rather than relaxing a
  real guard: the executor must (a) harden the existing test to capture pre-tool event
  bytes before running the tool and compare after, (b) keep it green under
  `defer-requests: 0` (bit-identical to today), (c) add a surface-level test for
  `defer-requests > 0` asserting the surface shows the stub after the swap while the log
  stays append-only (the swap changes the surface via `surfaceOp: replace`, not old
  events' bytes).
- Store keys deliberately carry no session id (resume would dead-reference them). The
  resident-entry ledger below keys rows by **store hash** for the same reason; see §3.5
  for why session-keyed rows would strand entries across resume/fork.
- Line numbers drift; implementation must re-verify anchors.

## 3. Design

### 3.1 Data flow

```
post-execute accept decision
  → existing gates + route() + savings check (unchanged)
  → store.put(original) always (unchanged)
  → deferral enabled AND candidate qualifies?
      │ no   → immediate replacement (today's behavior, bit-identical)
      │ yes  → record resident entry; return downstream decision UNMODIFIED
llm/stream request (observe-only): count sends per resident entry (3.2)
agent/pre-step: evaluate swaps for every eligible entry, one atomic critical section
  per entry (3.3); entries that fail the cost gate stay resident (3.4)
```

A "resident entry": `{ hash, callId, sentCount: 0, tokensSaved, createdAt }`. `callId` is
the **sole locator** — `eventSeq` is unknowable at insertion time (the crusher acts in
`tools/post-execute` and returns a decision; the harness appends the `tool/result`
downstream), so the swap pass resolves the event by scanning the live surface for the
callId at pre-step time (compaction-micro's `snapshotCandidates` precedent). (No session
id and no prefix-size snapshot — both would go stale; see §3.4/§3.5.)

### 3.2 Counting without fragility

A resident entry counts as *sent* when the stream listener observes **the first chunk** of
a provider request whose `options.messages` contain a tool-result block whose text
fingerprint (sha256 of the tool-result text, first 16 hex) matches the stored full text.
Counting at first chunk — not at request start — excludes requests that fail before
reaching the provider (network errors, aborts, adapter retries): an attempt that never
produced a chunk never aged evidence.

Purpose filtering is an **allowlist**, not a denylist: only main-loop requests count
(`purpose` undefined or the main-loop value; the harness purpose union is closed to
`'compaction' | 'session-title'`, so the allowlist is exact). Subagent fan-outs carry
`purpose: undefined` like the main loop — their exclusion is a **fingerprint side
effect** (subagents get fresh history that never contains the resident), not a purpose
filter. To close the fork-inheriting corner, the listener additionally requires
`options.sessionId` to equal the crusher's own session id (held in memory only, never in
the ledger — the ledger stays session-id-free per §3.5). The stream listener registers
with `{ global: true, prepend: true }` (cache-health precedent) because the crusher runs
in its own realm; swapped or
dropped entries stop matching by construction — the invariant is that a resident entry
always matches its stored full text until it is swapped or dropped.

### 3.3 The swap pass (pre-step boundary, atomic per entry)

Counter updates never swap directly. On every `agent/pre-step`, each entry whose
`sentCount` has reached the residency threshold (`>=` — "send full output twice, swap on
the third request"; an earlier draft's `>` contradicted the title and §5 and is corrected
here) runs one **non-awaiting critical section**:

1. Locate the current event by `callId` (the sole locator — see §3.1) and confirm the current body
   still byte-equals the stored full text (user compacted / microcompact already folded /
   manual intervention → drop the entry, ledger `swap:stale`).
2. Append the two rows, microcompact shape exactly:
   - `session.append('compaction/prune', { shadowedRange, shadowedSeqs,
     shadowedTokenCount })` with `shadowedTokenCount = tokenMeter.estimateMessage` over
     the original message — **without this row the token meter keeps charging the original
     forever**;
   - `session.append('tool/result', replacement, { surfaceOp: { op: 'replace', startSeq,
     endSeq }, sourceEventSeqs })` where the replacement preserves every non-content field
     of the original block (`{ ...resultBlock, content: [stubTextBlock] }`) and the stub
     text is the standard compressed body + `buildMarker(...)` trailer.
3. Ledger `swap:applied` with the gate inputs.

No timers exist in this design: eligibility is recomputed at the boundary, and the
staleness re-check + two appends happen without yielding, so an in-flight request or a
microcompact pass cannot interleave with a swap. (Failure ordering matches microcompact:
appends committed earlier stay durable if a later entry's swap throws; the throw is
caught, ledgered, and the remaining entries continue.)

### 3.4 Cache economics gate (suffix cost, not prefix cost)

Prompt cache is a **prefix**: replacing the message at index k busts cache from k to the
end, not from 0 to k. The rewrite price of a swap is therefore the **suffix tokens from
the entry's position to the surface end, measured at swap time** — for a two-request-old
result that suffix is small (the stub plus what accrued since). Compute at each pre-step,
per eligible entry:

```
suffixTokens = Σ estimateMessage(events after entry.eventSeq on the current surface)
projectedSavings = tokensSaved × max(1, remainingRequestsEstimate)
swap iff projectedSavings > margin × suffixTokens        (margin default 1.5)
```

`remainingRequestsEstimate` follows the compaction cost-gate doc
(2026-09-20-cost-gated-plan-step-compaction.md): observed requests-per-step × pending todo
steps, floored at 1. With no price table resolved, the comparison stays in token units —
conservative in the direction of *not* swapping, the safe side.

Window-pressure override: `defer-urgency-tokens` set and the session estimate within that
distance of the model window → swap regardless of the gate. If the gate fails, the entry
stays resident (the suffix cost keeps shrinking... or growing; re-evaluation is cheap and
happens at every pre-step). Entries are swept at `defer-max-age-ms` (default 30 min) with
ledger `swap:abandoned` so decks of stale residents cannot accumulate unboundedly.

### 3.5 Resume and durability

- Resident entries persist to `<dshHome>/ccr/defer/<sessionId>.jsonl` as
  append-only rows (store write succeeded → row; swap committed → row).
- On session start, rebuild by **fingerprint match against the live surface**, not by
  session id: for each recorded hash, the stored full text is searched among current
  `tool/result` events; found → resume the entry at `sentCount: 0` (deliberately
  conservative — slower aging after resume is harmless, faster would defeat §3.4); not
  found → drop. Session-id keying alone would strand every resident across a
  resume/forked identity change; the fingerprint makes the store hash the identity, which
  matches the store's own keying rule.
- Ledger failures are swallowed per the CCR ledger precedent — durability is best-effort,
  correctness never depends on it.

### 3.6 Config (under the existing `cc-context-compression` section)

| key | default | note |
|---|---|---|
| `defer-requests` | `0` (off — today's behavior) | residency; 2 = paper parity |
| `defer-margin` | `1.5` | §3.4 multiplier |
| `defer-max-age-ms` | `1_800_000` | sweep age for residents that never swapped |
| `defer-urgency-tokens` | unset | window-pressure override; inactive without a window source |

`mode: 'dry-run'` interaction: the deferral path stores and counts but **never appends
anything to the session**; intent rows in the ledger carry `applied:false`. A test pins
this. Note the divergence this creates with today's dry-run, which returns *before*
`store.put` — deferred dry-run writes store files and ledger rows, it only skips session
appends. `defer-requests: 0` must be byte-identical to current behavior: the hardened
pre-tool-bytes composition test (see §2, B1) stays green, and a second test pins the
surface-level swap for `> 0` while the log stays append-only.

### 3.7 Interaction boundaries

- **Reducer** (2026-09-20-evidence-preserving-reducer.md): receipts are emitted already
  compressed and never become residents.
- **Microcompact**: swap output is a crusher stub, so the stub guard
  (`compaction-micro/src/index.ts:254`) skips it. Ordering between a pending microcompact
  fold and a crusher swap on the same event: both run staleness checks against the current
  surface, so the loser's entry drops (`swap:stale`); a composition test executes both
  orders — fold-then-swap and swap-then-fold.
- **TUS**: summaries are keyed by callId and unaffected by content replacement.

## 4. Phases

- **Phase 0 — pure mechanics, swap disabled.** Resident-entry bookkeeping, first-chunk
  counting with the purpose allowlist, ledger rows, fingerprint rebuild. Everything
  observable in dry-run; zero content changes possible.
- **Phase 1 — swap path.** The paired prune+replace swap, staleness check, and the relaxed
  cache-safety test scoped to `defer-requests > 0`.
- **Phase 2 — gate + dogfood.** Suffix-cost gate, urgency override, one-week ledger study
  on this repo's own sessions (default config stays at residency 0 until the ledger says
  otherwise).

## 5. Verification

- **Unit (repo root, `node_modules/.bin/vitest run packages/context/context-crusher`):**
  counter increments only on first chunk with an allowlisted purpose and a matching
  fingerprint; failed-before-chunk requests never count; staleness drop on mutated body;
  gate arithmetic table (suffix measured at swap time, margin boundary strict); ledger
  rebuild by fingerprint after simulated restart; entry sweep at `defer-max-age-ms`;
  dry-run never appends.
- **Composition** (`mountAgentLoopTestDependencies`, MockAdapter scripted to force ≥3
  requests): eligible large result enters the session **byte-identical** on requests 1–2;
  request 3 observes the stub; the paired prune row records the shadowed tokens;
  `context_retrieve` round-trips the original; a real microcompact pass afterwards skips
  the swapped stub (guard executed, not just asserted); both swap/fold orderings land a
  consistent surface; the pre-existing cache-safety assertion still passes with
  `defer-requests: 0`.
- **Observable claim for the commit message:** with `defer-requests: 2`, a large eligible
  tool result remains fully visible to the model for its first two reasoning steps and is
  compacted from the third request on, with the original permanently retrievable and the
  token meter debited exactly once via the prune row.

## 6. Risks and explicit non-goals

- **Prompt-cache write cost** is the whole tradeoff; §3.4's suffix accounting exists
  because naive prefix accounting would make the feature either inert (over-counted cost)
  or cash-negative (under-counted). Dogfood phase must publish the real gate pass rate
  before any default change.
- **Counter drift under compaction.** If compaction drops the resident message before
  residency is reached, the entry dies unmatched and is swept at `defer-max-age-ms`.
  Acceptable: the evidence is in the store and compaction itself compressed the context.
- **No harness changes.** Everything rides `llm/stream`, `agent/pre-step`, and the
  microcompact replacement call shape — three seams already in production use.
- Non-goals: paging API parity with the paper's handle-based retrieval (our
  `context_retrieve` already returns the full blob; partial paging is a separate feature);
  applying deferral to reducer receipts, MCP outputs, or sub-`min-bytes` results.

## 7. Review outcomes and residual risks

Critic cold review (2026-09-20): GO-WITH-AMENDMENTS, 7 findings; all blocking/major baked
in above:

1. [blocking→fixed §3.4] Gate compared savings against the full stored prefix — prompt
   cache busts from the *swap point onward*, so the cost is the suffix measured at swap
   time; `prefixTokensAtStore` deleted from the resident entry.
2. [major→fixed §3.3] Swap omitted microcompact's paired `compaction/prune` row — the
   token meter would charge the original forever; the swap now performs both appends and
   preserves non-content block fields.
3. [major→fixed §3.2/§3.3] Timer-driven recheck raced the pre-step boundary — timers
   removed entirely; all swaps execute atomically on `agent/pre-step`.
4. [major→fixed §3.2] Send counting moved from request start to first chunk; purpose
   filtering is now an allowlist (main-loop only).
5-7. [minor→fixed §3.2/§3.5/§5] Matching invariant stated; resume now rebuilds by surface
   fingerprint (session-id keying would strand residents across resume/fork); stub-guard,
   ordering-race, retry-over-count, and dry-run tests added.

Residual risk handed to the executor: `llm/stream` chunk delivery for errored streams must
be pinned during Phase 0 — the counting rule assumes a stream that fails before any
chunk emits zero chunks. The adapter contract itself lives in the read-only harness repo
and cannot be confirmed from this checkout, so the pin is scoped to our listener: an
in-repo test asserting the listener counts zero on a stream that throws before its first
yield. Phase 0 also verifies the `llm/stream` registration uses `{ global: true,
prepend: true }` (realm boundary; receipt checked in-test).
