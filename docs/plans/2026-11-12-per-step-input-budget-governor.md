# Per-step Input Budget Governor

- Date: 2026-11-12
- Status: Implemented — stacked PR over #409 (input-ledger); formal design verified (TLA input-admission-governance, Lean input-admission-arithmetic, bridge acceptanceReady).

r3 → r4 fold: observe mode drops the `wouldTrim`/`wouldDefer` pseudo-fields (decisions live in the shared `trimmed` array under `mode: 'observe'`); `cc-shell-glue` moved advisory → **passthrough in v1 as an algorithmic rule** (pre-delivery latch makes enforced drops silent one-shot misses; doc 7 keeps it observe-only, cross-doc consistent); kind-enumeration test re-specified as a repo scan including harness-side kinds (explicit passthrough).
- Program: context-engineering input governance (doc 1 of 8)
- Depends on: doc 3 (`@dsh-cc/input-ledger` — row schemas GovernorRow/DedupeRow/CapRow live there; single schema source). Doc 7 plugs into this package's `govern()` pipeline.
- Literature basis: Mei et al. `C* = argmax U(C) s.t. |C| ≤ L`; ContextPipe (2609.00749); Anthropic "smallest high-signal token set"; ToolMenuBench.

## Formal design

- mode: auto (session-adopted; no formal-design screening clause in the project rules at this revision; adoption snippet at `<skill>/references/agents-snippet.md`).
- decision: enabled (shared model with the dedupe doc — the governor hosts both stages in one listener)
- triggerIds: FD-T2 (defer backlog re-offers are late messages affecting admission outcomes), FD-L1 (class eligibility composition with stated never-trim invariants whose violation changes effective behavior), FD-L2 (byte budgets with stated bounds, FIFO ordering, monotonic gateSeq arithmetic).
- backends: `["tla", "lean"]`
- modelDirs: `{"tla": "specs/tla/input-admission-governance", "lean": "specs/lean/input-admission-arithmetic"}`
- model status: `specs/tla/input-admission-governance` (bridge-bound, aggregate verified) + `specs/tla/input-admission-governance-probes` (fault-injection negative controls, deliberately red) + `specs/lean/input-admission-arithmetic` — TLA convention verified; Lean: 6 properties verified, conformance 55/55 vs the model-local fixture; combined acceptance ready.
- rationale: the cross-step invariants (no-self-suppression, commit-on-admission atomicity, observe/enforce state separation, protected-class preservation) are state-machine properties; the class map and budget arithmetic are deterministic rules with stated conservation/bounds — both backends apply, and neither substitutes for the other.

## Problem

Eleven-plus producers append content into the per-step message stream with no byte budget, no arbitration, and no cross-producer visibility (`memory` recall bodies with no byte cap at `memory/src/recall.ts:410`, cc-shell glue notices, retry-attendant guidance, advisor severity notes, subagent lifecycle notices, MCP-ready notice, progress briefs, hook additionalContext). The only existing caps are a per-session **total** injection count inside one producer (`turn-rules` `MAX_INJECTIONS = 32`, counted per session, `turn-rules/src/wiring.ts:26`) plus #403's two **section-level** system-prompt byte caps (`cc-memory-section`, `cc-subagent-catalog`) — a different surface: section-level inside the assembled system prompt, not batch-level over the per-step enter batch.

## Goals / Non-goals

Goals:

1. A single outermost gate over the final per-step enter batch, enforcing class-based byte budgets.
2. Deterministic trim/defer/expire behavior for budgetable classes; never-touched classes by construction.
3. Full auditability in the input ledger (doc 3).
4. Ships observe-first with an isolated shadow-state model that cannot affect real flow.

Non-goals:

- **Unknown source kinds are never trimmed.** The gate touches only explicitly enumerated kinds (r1 fold: my original "unknown → advisory" classification was inverted into deferrable by default, which two seats flagged as dangerous: it would silently trim `agent-instructions` workspace rules and hook additionalContext as they currently flow).
- No rewrites of message content, no reordering of admitted messages.
- No system-prompt governance (doc 4), no persisted-transcript governance (doc 2).
- No LLM triage.
- No notice dedupe itself (doc 7 implements that in this same package).

## Current behavior (anchors)

- `agent/pre-step` payload is `{ agent, messages, turn, step, signal }`; `messages` is the claimed inbox batch for this step. `PreStepDecision`: `{kind:'enter', messages: UserMessage[]}` | `{kind:'reject'}`; rewriting = returning `{...decision, messages: newArray}` (append precedent `mcpReadyNotice.ts:157-163`; filter precedent `strip-instructions.ts:71-77`).
- Durable injected messages (`agent.inject`) re-surface inside a later step's claimed batch, so a final pre-step gate sees them with no extra plumbing.
- Prepend semantics: `prepend: true` listeners are **unshifted** (run earliest in the waterfall); among prepended listeners, later registration is outermost. Plain (non-prepend) listeners execute in registration order after all prepended ones. On the way back out of `next()`, the outermost listener sees the final decision produced by everything inside it. Verified against the actual registrations: `hooks-claude-code` `agent/pre-step` is registered **plain** (`hooks-claude-code/src/register-events.ts:90-97` — only its `tools/pre-execute` at `:102-130` is prepended); `mcpReadyNotice` and `one-shot-notice` are plain; `strip-instructions` is prepended but subagent-scoped (`strip-instructions.ts:70-77`). The r1 draft's claim that hooks/mcpReady prepend and its `agent.cordis.yml:416-418` row anchor were both false (that file is a 32-line wrapper; the shared `agent.shared.cordis.yml:410-418` lines are isolate keys, not pre-step rows).
- The complete census of **prepended** pre-step/batch rewriters at and after preset mount (delta-round fold, grok): `strip-instructions` (subagent-scoped, `strip-instructions.ts:71-77`), `suppress-settled` (`subagent/task/src/suppress-settled.ts:76-88`, mounted from `subagent/task/src/index.ts:286`), and the dynamically installed moa sanitizer (`ui/tui/src/harness/model-selection-wiring.ts:16-19`) — the last of which is mounted after preset apply and therefore sits outside the governor **by construction** (documented and accepted: classes default to passthrough, so outside-governor content is never harmed). All three are named in the composition pin below.
- `agent-instructions` baseline content is spliced into the enter batch by harness (`context/agent-instructions/src/index.ts:330-355` in the pinned copy) with `source.kind === 'agent-instructions'`; hook additionalContext arrives with kind from hooks (`turn-safety.ts:157-160`). Both must be classed never-trim.
- Real top-level kinds in use (r1 audit, corrected): `user`, `memory`, `turn-rules`, `edit-recovery-hint`, `moa`, `progress-rebuild`, `cc-shell-glue`, `cc-subagent-children`, `advisor`, `retry-attendant`, `completion-gate`, `permission-rules`, `compaction-micro`, `compaction-cost-gate`, `agent-instructions`, `compact-checkpoint`, `hooks-claude-code`, `subagent-settled`, `moa-escalation`, `vwa-evidence`, `cc-workflow-completion`, `command-preset`, `side-query`, `tool-web-fetch`, `tool-registry`.

## Design

### Package & seam

New package `packages/context/input-budget` (`@dsh-cc/input-budget`). One `agent/pre-step` waterfall listener: `{ prepend: true }`, delegate-first, mounted from the preset row during preset apply. Because prepending unshifts and later prepend = outer, and no prepended global pre-step rewriter exists at preset-mount time (verified list above), the governor is outermost among preset-mounted pre-step rewriters. Three ordering defenses:

1. Composition.spec pin: the governor's preset row and the producer rows it guards against.
2. Live-fold test: a synthetic plain (non-prepend) producer appending a marker message is still visible to the governor's final batch (guards the prepend/unshift contract).
3. Live-fold test: a synthetic late-registered prepended listener lands **outside** the governor (asserts the documented by-construction visibility boundary stays a property, not an accident).

### Classes (explicit membership only)

| class | kinds (explicit) | policy |
|---|---|---|
| governance | `turn-rules`, `edit-recovery-hint`, `completion-gate`, `permission-rules`, `agent-instructions`, `hooks-claude-code`, `compact-checkpoint`, `moa-escalation` | never trim, never defer; counted |
| task | `user`, `progress-rebuild`, `moa`, `subagent-settled`, `cc-subagent-children`, `vwa-evidence`, `cc-workflow-completion` | never trim, never defer; counted (lifecycle/delivery wakes: losing them loses work product or settlement; classified via the doc-7 r1/delta reviews) |
| memory | `memory` | trim/defer under `memory-budget-bytes` (its own budget, not the advisory pool) |
| advisory | `advisor`, `retry-attendant`, `compaction-micro`, `compaction-cost-gate` *(and `cc-shell-glue` — but that kind is observe-only in v1, see passthrough note)* | trim/defer under `advisory-budget-bytes` |
| passthrough | `cc-shell-glue` **(v1 — hard rule)**, `command-preset`, `side-query`, `tool-web-fetch`, `tool-registry`, **everything else / unknown** | never trim, never defer; counted |

`cc-shell-glue` sits in passthrough in v1 as an **algorithmic rule**, not an annotation (delta-round two-seat finding): `mcpReadyNotice` commits its once-per-session latch **before** returning the notice (`mcpReadyNotice.ts:154` then `:157-163`) — any enforced trim/defer/oversize-rejection of a glue notice is a silent one-shot miss. Doc 7 therefore runs dedupe/caps on `cc-shell-glue` in observe mode only until a producer-side latch-after-admission contract exists. This also keeps the governor kind table and doc 7's exclusion list consistent.

A startup enumeration test asserts that a **repo scan** of every kind declared in `MessageSourceMap` augmentations (dsh-cc packages **and** the pinned harness copy, including harness kinds like `plan-mode`, `skill-invocation`, `session-reference`, `goal`, `runtime-context`, `time-context`, `system-prompt`) is covered by the class map — harness kinds map to passthrough explicitly (grok delta: the enumeration is a repo-scan assert, not a doc-table fixture equality check).

Clock: the governor maintains a **monotonic per-session invocation counter `gateSeq`** (incremented on every gate call). `agent/pre-step`'s `step` is **turn-local** (resets per turn — codex delta MAJOR) and is unusable as a session clock; `gateSeq` replaces it for defer-TTL aging and for doc 7's dedupe window.

### Budget model (per enter batch)

1. Classify each message; compute per-class bytes.
2. governance/task/passthrough: never modified.
3. `memory` class: if memory bytes > `memory-budget-bytes` (default **16384**), trim oldest memory messages (recall delivers whole-topic bodies; trimming is whole-message, FIFO) until within budget. Trimmed entries go to the same defer queue as advisory (memory recall re-fires anyway on subsequent matches; dropping loses little).
4. Advisory budget: FIFO-oldest trim until `advisoryBytes ≤ advisory-budget-bytes` (default **8192**).
5. Enter budget: if total > `enter-budget-bytes` (default **24576**), trim advisory (then memory) further; if budget cannot be met within trimmable classes, admit everything, set `hardOver: true`, trim nothing from protected classes (row records the overflow).

### Defer queue (deterministic algorithm)

Per-session `Deque<DeferredEntry>` where entry = `{ message, enqueuedAtSeq, lastOfferedSeq }` — both fields carry **gateSeq values** (the monotonic per-session invocation counter above; turn-local `step` is never used). Initialization/update semantics (codex delta fold): `enqueuedAtSeq` set at trim time; `lastOfferedSeq` initialized to `enqueuedAtSeq` and **updated at the end of every gate invocation in which the entry was evaluated** (regardless of admission outcome — admission, rejection, and re-defer all advance it).

On each gate invocation (in order):

1. Age: entries with `gateSeq - enqueuedAtSeq > defer-ttl-steps` (default 3) → drop `drop-expired`.
2. Backlog admission: walk backlog FIFO; admit head while the entry's own class budget has room (memory entries are evaluated against `memory-budget-bytes`, advisory entries against `advisory-budget-bytes` — codex delta fold: a 12 KiB memory entry must not be judged against the advisory limit). Admitted entries are appended to this step's batch (they only re-enter via the governor's own return value — not via `agent.inject`, so no new claimed batches form).
3. Fresh classification/trim (per Budget model); a trimmed message whose own bytes **alone exceed its class budget** is dropped immediately as `drop-oversize` (never enqueued — critic/ledger fold: defer-then-drop would fake a deferral that could never succeed); the rest append to the backlog tail.

Rationale: backlog-first respects FIFO aging; admitted-message order is otherwise never touched. TTL is wall-bounded by invocation count, not admission count — stated bluntly so two implementers cannot diverge.

### Observe mode (r1 fold: isolated shadow state)

`mode: 'observe'` runs the same computation against the real batch but **must not assume divergent history**: a defer that never happened in observe has no next-step admission pending. Therefore:

- The defer queue exists in enforce mode only. In observe mode there is no simulated backlog; rows represent decisions for the current batch in the shared `GovernorRow.trimmed` array under `mode: 'observe'` (delta-round fold: all three seats flagged the earlier `wouldTrim`/`wouldDefer` pseudo-fields as a schema fork — there are no such fields; observe rows look exactly like enforce rows, only `applied`-family semantics differ by mode).
- Multi-step defer-impossibility claims are explicitly out: `drop-expired` rows appear only in enforce mode; `drop-oversize` IS possible in observe (fresh-batch trim computation).
- On `observe → enforce` flip, the queue starts empty at the flip boundary (no cross-mode carryover).

### GovernorRow

Defined in doc 3 (single schema source). This package only supplies `mode`, `bytesByClass`, `trimmed`, `offeredBacklog`, `hardOver`, `error?`. When the ledger package is absent/disabled, the governor still runs; rows are simply not persisted (append API tolerates missing sink, `onError` counts).

### Settings — `cc-input-budget` (kebab, user-layer, hot-read)

| key | type | default | bounds |
|---|---|---|---|
| `enabled` | bool | true | — |
| `mode` | `'observe' \| 'enforce'` | `'observe'` | — (flip boundary resets defer queue) |
| `enter-budget-bytes` | int | 24576 | 4096..262144 |
| `advisory-budget-bytes` | int | 8192 | 512..65536 |
| `memory-budget-bytes` | int | 16384 | 1024..131072 |
| `defer-ttl-steps` | int | 3 | 1..16 |

Four-surface default discipline + "no settings file → observe mode runs" wiring test.

### Failure semantics

Governor exception → return the unmodified decision, row `{ error: true }`. Never drops protected classes, never throws.

## Dependencies & interactions

- Doc 3 ledger for rows (soft dependency: governor works without it if the package is not mounted).
- Doc 7 (dedupe/caps) plugs into the same listener (`govern()` order: dedupe → caps → budget trim).
- Doc 4 section budgets are orthogonal (assemble-time, this is batch-time).
- moa dynamically-installed sanitizer sits outside the governor (documented property, test-pinned).

## Verification

- Unit: class map completeness assert vs repo kind declarations; FIFO trim; backlog admission aging (each aged case: backlog/fresh/oversize/reject); observe/enforce row parity for fresh-batch fields only; flip-boundary queue reset; hard-over.
- Integration: producer-chain live-fold tests (the two ordering defenses above); a 3-step sequence with defer/TTL progression end-to-end.
- Live acceptance: two weeks observe mode; ledger answers real per-class bytes p50/p95, would-fire rates per class; those numbers set enforce-time budget floors before flipping.

## Risks

- Advisory starvation under sustained overload: described; doc 7's per-kind caps bound the worst offenders before the budget has to arbitrate strangers.
- Late-registered prepended listeners bypass the governor: by construction, documented, and class-default passthrough means they cannot be trimmed by surprise.
- Observe-mode fields are "fresh-batch only": reviewers of flip decisions must not read defer-family rows in observe data (documented in the row schema).

## R1 fold ledger (three seats: internal critic, grok, codex)

Folded: kind classification inversion (unknown → passthrough; audited advisory list; `agent-instructions`/`hooks-claude-code` explicitly governance); `progress-brief` → `progress-rebuild` correction + moa classified; ordering section rewritten against real prepend semantics with three tested defenses and dynamic-listener boundary; memory gets its own budget class (r1: the cited biggest producer was never budgeted); deterministic defer algorithm; observe-mode shadow-state model with flip-boundary reset and no simulated backlog; GovernorRow schema ownership moved to doc 3; startup kind-enumeration guard test; settings authority/bounds/hot semantics.

## R2 → R3 delta fold ledger (three seats)

Folded: kind table completed (`cc-workflow-completion`, `command-preset`, `moa-escalation`, `side-query`, `tool-web-fetch`, `tool-registry`, `vwa-evidence` added with classes; `cc-subagent-children` promoted to task — pre-delivery latch analysis in doc 7); `gateSeq` monotonic per-session clock replaces turn-local `step` for defer-TTL and dedupe-window arithmetic; `lastOfferedSeq` init/update semantics defined; oversize evaluated at trim time against the entry's **own class budget** and dropped immediately (`drop-oversize`, never enqueued; GovernorRow action union reconciled with doc 3 — `drop-hard`/`drop-cap-memory` removed); backlog admission evaluates entries against their own class budgets (fixing the advisory-threshold misjudgment of deferred memory); the prepended-rewriter census expanded (`suppress-settled`, `strip-instructions`, moa sanitizer) and named in the composition pin.
