# Feature A: complete task accounting

- Status: proposed; implementation order A1 then A2 in the [overview](2026-10-27-guarded-execution.md).
- Owner: new `packages/observability/task-accounting` (`@dsh-cc/task-accounting`).

## 1. Objective and exclusions

Count every observable model request for a task, including child sessions, compaction, auxiliary calls, failed calls, retries, and late-settling background calls. Separate logical calls from physical provider attempts. Preserve the current bare `/cost` session view. Do not estimate unreported usage as zero or claim that stream count equals network request count. No prompts, source text, tool arguments, credentials, or raw provider errors enter the accounting ledger.

## 2. Attribution contract

Expose these proposed public APIs from the new package:

```ts
type Purpose = 'reasoning' | 'subagent' | 'compaction' | 'summary'
  | 'review' | 'selector' | 'recovery' | 'title' | 'other'
interface Attribution {
  taskId: string; sessionId: string; logicalCallId: string;
  parentLogicalCallId: string | null; purpose: Purpose;
}
interface TaskScope {
  taskId: string; rootSessionId: string; status: 'open' | 'closing' | 'closed';
}
interface Accounting {
  begin(rootSessionId: string): TaskScope;
  bindChild(taskId: string, parentSessionId: string, childSessionId: string): void;
  run<T>(attribution: Attribution, body: () => Promise<T>): Promise<T>;
  close(taskId: string): Promise<TaskReport>;
}
```

`begin` creates a UUID task ID. An ordinary interactive task begins when a new top-level user message starts an idle activation and closes at that activation's settled stop; follow-up steering during that activation remains in the same task. A new idle activation gets a new task ID even in the same session. An experiment supplies one task scope per execution/repetition. Host root-activation hooks own this lifecycle, not heuristic message scanning. Without those hooks, A1 requires an explicit task scope from a caller; unscoped requests remain unassigned.

`run` uses Node AsyncLocalStorage for same-process propagation. Each logical call gets a new UUID; its parent is the causing logical call when known, otherwise null. Child sessions bind at creation, including continuable IDs preallocated in `subagent/task`; binding cannot be reassigned. A child stores task attribution in trusted runtime metadata, never in model-authored prompts. A later user activation of an existing child creates or binds to its current causing task, not the original task forever. Fork/spawn/one-shot paths share this rule. Cross-process adapters explicitly serialize attribution through a trusted host envelope and validate it at entry. Do not use a process-global current-task variable.

New optional `purpose` and accounting context in `SideQueryOptions` default to `other` and the calling task scope. Change every current `runSideQuery` consumer to pass its specific purpose. Main-loop, compaction, title, MoA, hooks, memory and provider-direct consumers require an inventory in the implementation PR: source entry point, attribution source, and collection coverage. Missing entries block complete coverage. Cancellation does not clear the context of already-started work.

## 3. Versioned host capability (A2 prerequisite)

Proposed capability `accounting/physical-attempts-v1` belongs at the provider transport boundary, below adapters and their retries. `llm/stream` remains a logical observer only. The host exposes an immutable capability descriptor listing covered provider/transport implementations and emits these events to a registered observer:

```ts
type AttemptStart = {
  v: 1; event: 'attempt-start'; attemptId: string; logicalCallId: string;
  attribution: Attribution | null; ordinal: number;
  provider: string; model: string; startedAt: string;
};
type AttemptEnd = {
  v: 1; event: 'attempt-end'; attemptId: string;
  status: 'ok' | 'error' | 'cancelled'; endedAt: string;
  usage: Usage | null; usageSource: 'provider' | 'unavailable';
  errorCode: string | null;
};
type Usage = {
  inputTotal: number; outputTotal: number;
  cacheRead: number | null; cacheWrite: number | null;
  // Cache counts are subsets of inputTotal, never additive totals.
};
```

Every physical send, including a retry that never yields a stream chunk, receives a fresh attempt ID before transport invocation. Ordinal starts at 1 within a logical call. A route fallback is another attempt with its actual provider/model. Reconnected streams that send a new provider request are new attempts; locally resumed consumption is not. Pre-dispatch validation failures have logical outcomes and zero attempts. Provider-internal attempts invisible to the host are outside coverage and MUST be declared in the descriptor/report. Report physical coverage as complete only relative to this stated observable boundary.

An adapter normalizes provider usage to this schema. If reasoning tokens are a subset of billed output, count them once. Unsupported normalization or partial usage sets usage null; do not manufacture totals. Physical end usage is authoritative; logical aggregate usage is diagnostic and MUST NOT be added to it. Repeated final usage chunks do not create multiple end events. Missing terminal events after process death remain incomplete starts. Detached work retains its task attribution until its real settlement. Observer failures never interrupt a provider request.

A2 MUST provide host conformance tests for: hidden adapter retry, no-chunk failure, route fallback, duplicate usage chunk, cancellation with late usage, child propagation and transport coverage. dsh-cc probes the descriptor at mount. Missing/incompatible capability reports `logical-only`; an uncovered active transport reports `partial`. A2 cannot be substituted with a wrapper that merely counts `ctx.llm.stream` calls.

## 4. Durable event schema and storage

The package owns `schemas/{event,report}.schema.json` and generated matching types. All records include `v:1`, UUID `eventId`, UTC `ts`, task/session IDs when assigned, and kind. Kinds are `task-open`, `child-bind`, `logical-start`, `logical-end`, `attempt-start`, `attempt-end`, `task-close`, `coverage-gap`. Logical events carry attribution and actual route; end adds status and optional diagnostic usage. Attempt events use Section 3. Close records contain pending logical/attempt counts and a close reason. Error codes are bounded enum-like identifiers, not messages. Text fields cap at 256 UTF-8 bytes. Schema maximum record size is 16 KiB.

Use `<DSH_HOME>/task-accounting/v1/<taskId>/events.jsonl`, permissions 0700 directories/0600 files. Validate task IDs before resolving paths; no user-supplied relative path enters storage. An unassigned process ledger uses a server-generated process UUID in a separate `unassigned/` directory; never attach its cost by timing inference. Single-process writes serialize per task; multiple processes write separate `<processId>.jsonl` shards in the task directory, and folding merges by event IDs, not filesystem order. Start records must be enqueued before associated end records. Flush at close and orderly disposal. Last truncated line is ignored and marks the report incomplete; malformed interior records and conflicting duplicate event IDs invalidate the report. Identical duplicate events are ignored.

Storage failures set an in-memory coverage gap and warning (once per task), preserve model operation, and mark all later task reports incomplete. No durable cost claim can survive a dropped ledger write. Do not silently rotate or truncate an open task. Default retention is 30 days after close, configurable user-only 1–365 days; open/crash-incomplete tasks are not automatically deleted. Explicit task deletion removes all shards and reports. No prompt-level content is retained.

## 5. Folding, closure, and pricing

Each logical/attempt ID has at most one distinct start and end. Same-ID conflicting ends invalidate that task report. An end without a start, unknown child, unassigned request on a covered transport, or missing terminal marks coverage partial. Maintain separate totals: logical calls; attempts; input/output tokens with known usage; unknown-usage attempts; pending attempts; unattributed attempts. Never count logical and physical totals together.

`close` sets closing, prevents new root work, snapshots pending descendants, flushes, and returns immediately with `provisional:true` if any work is still running. It does not await arbitrary background agents. Late ends append normally and increment `reportRevision`; reports are derived on read. A task becomes closed when all owned logical calls and attempts settle. New root work is rejected for that scope; an already-started child can still create causally owned attempts while closing. A crash leaves provisional/incomplete evidence and never causes replay.

Reuse the existing model price resolver through its public export; add a pure public pricing function if necessary. Freeze a price table snapshot/hash for each report. Price only attempts with sufficient usage and a matching route price. With all cache fields known, price `(inputTotal-cacheRead-cacheWrite)` at ordinary input price plus the two cache subsets at their respective prices and output at output price. Validate nonnegative integer counts and disjoint cache subsets whose sum is at most inputTotal. If a provider has overlapping categories, its adapter must normalize or mark usage unknown. Unknown cache counts with different input rates yield unknown cost, even if total tokens are known. Use integer micro-USD accumulation with decimal-safe arithmetic; round only presentation. Known cost is a lower-bound subtotal when anything is unpriced, never a total.

Coverage enum is `logical-only | partial | complete`. Complete additionally requires no pending requests, no gaps, no unassigned covered requests, and a matching host descriptor. Token completeness and price completeness are separate booleans; missing prices do not erase known tokens. A provisional report cannot support a complete-cost claim.

## 6. User interface and compatibility

Keep `/cost` unchanged. Add `/cost task` (current activation's task, or most recent task in this session if idle) and `/cost task <uuid>`. Only tasks owned by the current workspace/session ancestry are readable through this command; cross-workspace lookup returns unavailable. Add `/cost task <uuid> --json` for a versioned report with counts, coverage, per-purpose/provider/model aggregates, pending work, known cost, unknown cost count, price hash and report revision. A task with no recorded scope returns actionable `task accounting unavailable`, never the session total under another label.

Settings namespace `task-accounting`: `enabled:false`, `retention-days:30`. Read enablement at mount; disabling mid-task stops future collection and marks that task partial. When enabled but the host descriptor is absent, A1 remains useful and visibly logical-only. No network calls are added. Disposal drains queued file writes, not provider work.

## 7. Implementation files and tests

Create `src/{types,scope,host-adapter,collector,store,fold,pricing,settings,index}.ts` and schemas in the new package. Modify `side-query`, current side-query consumers, child creation/call paths under `subagent/task`, and `/cost` dispatch. Add host lifecycle/transport integration in a separate harness change, with fixtures in dsh-cc proving the descriptor contract. Preset registration includes the service's isolation key and declared injections. Consumers use public package imports. Add tests before wiring.

| Acceptance case | Required result |
| --- | --- |
| Two simultaneous root sessions and children | No attribution crosses tasks |
| Logical call with three transport attempts | One logical call, three attempts, physical usage counted once each |
| Preflight failure | Failed logical call, zero attempts |
| Retry fails before any chunks | Physical failure and unknown usage recorded |
| Late auxiliary settlement after root stop | Provisional becomes final; task ID is retained |
| Missing host, missing usage, missing price | Different coverage/usage/pricing limitations remain visible |
| Identical duplicate vs conflicting duplicate | First deduplicates; second invalidates |
| Truncated tail vs corrupt interior | Incomplete vs invalid, never complete |
| Provider/write observer throws | Model outcome unchanged; coverage gap recorded |
| Cache subsets and output reasoning subsets | No double counting; invalid overlap rejected |
| Existing bare `/cost` tests | Byte-compatible existing behavior |

Run focused accounting, side-query, task, command-cost and preset composition tests, TypeScript project checks, and repository static/package checks. A2 additionally needs live local fake-HTTP transport tests exercising actual retry placement; mocked `llm/stream` tests alone cannot pass A2.
