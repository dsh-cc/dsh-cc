# Fix plan v2: subagent parallelization and cache-hit-rate attribution

Status: **Implemented (v2 scope)** — PR #59 (merged 2026-08-31). F1 (batched-fork prompt rule in CLAUDE.md) and F2 (cache-trajectory forensics: analyze-log / compare-fork) shipped; the F3 persona-delivery channel is documented below as out of scope by design.

> Restructured after a cold review of v1 by deep-reasoner. Cold-review conclusion: v1's
> headline fix (byte-identical fork persona) yields zero benefit under the current
> deployment — typed agents all carry model overrides (opus→zai/glm-5.3,
> sonnet→llmbox_ant/deepseek-v4-flash, fable→llmbox_ant/kimi-k3), cross-model caches are
> not shared anyway, and `{{model}}` interpolation means "byte-identical" can never hold
> for model-override children. v2 is restructured on evidence.

## Empirical basis (full forensics over 482 sessions in ~/.dsh/sessions)

| Pattern | Signature | Examples |
|---|---|---|
| Healthy accumulation | Steady-state readShare 95–99%, decaying only at >15min gaps | kimi-k3 main chain (including subagent child 0c22bbee at 95.5%) |
| Single-slot incremental | read(N+1)≈input(N), readShare constant ~0.5 | xai_oauth/grok-4.6 (early portion of 879f94da) |
| No cache accounting | read=0 and write=0, billed in full | Segments failed over to kimi-coding/k3-256k (tail of tui-5177) |
| TTL decay | gap>15min → readShare 13–40% | Long-gap requests across otherwise healthy sessions |

Conclusion: **the harness cache mechanism on the kimi-k3 chain is healthy; the "low hit
rate" is attributable to routing/upstream cache-semantics differences + TTL + a structural
first-request miss — not a single harness bug.**

## Parallelism conclusion

The scheduler, tool declaration, and streaming-parse layers all support concurrency
(evidence: 3 forks fired in the same step within 2ms of each other and all returned
together after 181s). The true root cause = the model does not batch its emissions.
Current routing uses the anthropic-messages dialect, which **has no parallel_tool_calls
field to send** (an OpenAI completions-specific feature); no protocol-layer change is
needed. The only lever = the prompt layer.

## Deliverables for this iteration (all in dsh-cc; deepseek-harness untouched)

### F1 Prompt-layer parallelism guidance (CLAUDE.md)
- Add a hard rule to the orchestration section: N mutually independent delegations must
  emit all subagent_fork calls at once in the same assistant message; serial drip-feed of
  dependency-free forks is forbidden.
- The commit message must state the expected observable behavior change (higher share of
  multi-fork same-step emissions), to be verified in later real sessions.

### F2 Session cache attribution analyzer (new cache-trajectory module, TDD)
`packages/test-support/cache-trajectory/src/session-log-analysis.ts`:
- `analyzeSessionCache(events)`: folds usage per request (reusing the disjoint accounting
  from report.ts), attributes provider/model per the most recent `request/context` event;
  outputs per-request readShare, gap, routing breakdown, and hit rates by gap bucket
  (<1m / 1-5m / 5-15m / >15m).
- Pattern classification: `no-cache-accounting` (consecutive runs with read=0 and
  write=0), `single-slot` (read(N)≈input(N-1) for more than half of requests),
  `healthy` (default/accumulation), `insufficient-data`.
- findings: human-readable conclusions (e.g. "req 150-152 had zero cache accounting on
  kimi-coding/k3-256k").
- `compareForkPrefix(parentEvents, childEvents)`: byte comparison of the system/config
  fields in the fork parent/child first-request `request/header`, plus the byte offset of
  the first divergence — pinning the existing invariant that "a plain fork is
  byte-identical to its parent", and diagnosing the divergence point (persona location)
  of typed forks.
- bin gains `analyze-log <file|->` (supports .zstd, decompressed via the zstd CLI) and
  `compare-fork <parent> <child>` subcommands.

### F3 Success criteria
- The analyzer's classification of the 4 known signature sessions matches the manual
  forensics (single-slot / no-cache / healthy / TTL).
- Later real sessions: the share of multi-fork same-step emissions increases (validates
  F1); new sessions can self-check via analyze-log.

## Designed but not implemented (recorded for the record)

- **fork personaDelivery 'message' channel** (harness side): only beneficial when "the
  typed agent routes the same as its parent"; the current deployment has no such case,
  and demoting the persona to the user channel carries behavioral risk (mid-conversation
  identity switching, dilution by compaction, weakened instruction hierarchy).
  Implementation requires a behavioral A/B gate. Corresponds to a subset of
  deepseek-harness #2124.
- LLMBox `supportsLongCacheRetention` (1h TTL) declaration: requires confirming gateway
  support first.
- toolFilter rollout, continuable forks, workflow fan-out primitives: separate projects.
- Subagent spawn failing with no tools (new instances as of 2026-09): investigate
  separately.

## Execution order

1. Worktree `worktree-fork-cache-diagnostics` (already created, deps already linked).
2. F2 tests first (tests/session-log-analysis.spec.ts red) → implementation (green) →
   bin wiring.
3. F1 CLAUDE.md guidance.
4. vitest at package level + repo gates (typecheck, check:size, check:exports).
5. Analyzer replays the 4 known sessions and verifies classifications match.
6. Two commits (F2 code / F1 prompt), with messages stating the observable behavior
   change.
