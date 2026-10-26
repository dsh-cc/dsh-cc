# Feature D: persistent guarded decisions and callback omission audit

- Status: proposed; depends on A2, B, C and a new released host capability.
- Owner: new `packages/interaction/decision-controller` (`@dsh-cc/decision-controller`).
- Parent: [implementation order and release gates](2026-10-27-guarded-execution.md).

## 1. Objective and hard boundary

Retain a graph of fixed decisions across committed tool-result boundaries. Execute an eligible action instead of issuing a redundant model request. Return control to the original actor when action semantics are unresolved. This feature implements the paper's architectural idea, but its audit is a structural execution record, not a cryptographic correctness certificate or a predicted token saving.

An ordinary post-execute hook cannot own the next model callback. D requires a new public host protocol. Do not rewrite `llm/stream`, synthesize assistant messages, suppress tool failures, call private loop scheduler methods or monkey-patch the agent driver. Without the capability, D registers no authoring tool, emits one actionable warning and leaves ordinary execution intact. B and C remain usable.

## 2. Proposed host protocol: `agent/decision-boundary-v1`

The external harness implements this protocol first (D0), releases it, and dsh-cc pins the compatible release (D1). The protocol descriptor advertises version 1, native-tool dispatch, durable automatic-tool events, atomic boundary reservation, input-generation tracking, and cancellation/limit enforcement. A descriptor missing any field is unsupported. This document specifies the behavior to implement, not a claim about an existing event name.

The host offers an optional controller registration with callbacks `onBoundary(boundary): Promise<Proposal>` and `onCommitted(commit): void`. Its exact TypeScript facade may follow upstream naming conventions, but the wire records and semantics below MUST remain unchanged or the design must be revised before integration.

```ts
interface Boundary {
  v: 1; boundaryId: string; taskId: string; sessionId: string;
  inputGeneration: number; workspaceEpoch: number; policyGeneration: number;
  toolCatalogHash: string; configHash: string;
  lastCommit: { callId: string; receiptId: string; tool: string;
    argumentsHash: string; facts: ReceiptFacts } | null;
  signal: AbortSignal;
  limits: { remainingToolCalls: number; remainingMs: number };
}
type Proposal = { kind: 'reason'; reason: string }
  | { kind: 'execute'; graphId: string; graphHash: string; nodeId: string;
      tool: string; arguments: Record<string, JsonValue>;
      expectedInputGeneration: number; expectedWorkspaceEpoch: number;
      expectedPolicyGeneration: number; expectedToolCatalogHash: string };
```

ReceiptFacts is B's structured final-result adapter projection, never rendered text. Boundary IDs are unique per session loop decision, not model-generated. The host calls the controller only after the prior entire tool-result batch and all deferred contexts are durably committed and active tool work is quiescent, but before building or invoking the next model request. No boundary is offered during pending sibling tool calls, unresolved approval, terminal successful tool result, stopping/idle state, exhausted limits or queued user input. Unexpected plugin contexts invalidate the current graph before selection; D never ignores new instructions merely because they are not user messages.

The host retains exclusive session ownership while processing a proposal. At commit-to-dispatch it atomically rechecks cancellation, input/policy/catalog generations, workspace invalidation state, limits and no queued input. A mismatch rejects the proposal without executing it and routes pending input/normal reasoning according to the ordinary loop. Async approval or tool preparation MUST recheck the generation before the body starts. The original permissions and monotonic guards run for every stored action. A denied action is a real committed failure, not permission to issue another stored action.

If accepted, the host generates a real root tool call ID, invokes the public native tool pipeline as this agent, appends an automatic-tool call/result pair, and offers a new boundary only after its normal durable commit. Native-only presentation is required for D v1. If the agent selects code or both presentation, D invalidates and abstains; do not invent a parent token to bypass Code Mode admission. B remains independently supported in those presentations.

The host's durable automatic event pair is distinct from assistant output: `controller/tool-call {v,boundaryId,callId,graphId,nodeId,tool,arguments}` and `controller/tool-result {v,boundaryId,callId,receiptId,content,isError}`. Existing secret redaction, spill handling and transcript permissions apply. Canonical values remain execution-local; durable facts use B's receipt adapter. TUI/web/session readers render the source as `stored decision`, not model reasoning. Additional contexts and terminal results follow normal loop ordering and invalidate successors when appropriate.

The commit callback reports `{v,boundaryId,disposition:'reasoned'|'executed'|'rejected',callId:null|string,receiptId:null|string,modelLogicalCallId:null|string,inputGeneration,workspaceEpoch,policyGeneration}`. For executed, modelLogicalCallId MUST be null for that boundary; reasoned identifies the actual A logical request; rejected offers no bypass claim. Physical usage still comes only from A2. The host preserves a disposition table until task close so audits can detect double dispatch or reason+execute for one boundary. A callback delivery failure disables D and returns to normal reasoning; it never repeats an already started action.

Host conformance tests MUST exercise input arriving during controller await, approval await, tool preparation, result commit, and cancellation. D0 is not complete until automatic events replay correctly, generation checks are atomic against new input, loop budgets include stored actions, and at most one disposition can commit per boundary.

## 3. Graph authoring contract

Register `register_continuation({v:1,nodes})`, reusing B's Plan schema and stricter D constraints below. It does not execute actions. It returns `{v:1,graphId,graphHash,status:'armed',expiresAfterMs:60000}` after storing the immutable graph in memory. The host gives this tool's final committed receipt to the controller as its root. `start` therefore means 'the registration result committed successfully under the captured generations', not unconditional execution at any time. Runtime captures task/session/config/catalog/policy/input and workspace generations at registration. The model cannot supply these values, receipts or hashes.

At most one graph is armed per top-level session. A second successful registration invalidates the old graph before arming the new one; failed registration leaves the old graph invalidated as well, to avoid surprise continuation. Subagent sessions are unsupported in v1. Nodes remain a linear DAG of up to eight literals, with exactly one predecessor each. First node is start, later nodes success/exit-zero as in B. Preflight validates the whole graph and adapters. Allowed native tools are the same supported/user-allowed intersection as B, further excluding any tool known to conclude a turn. No selector, arbitrary guard expressions, remote evidence, failure branches, new agent creation, automatic publishing, or cross-task reuse is added.

Settings namespace `decision-controller`: `enabled:false`, `mode:'shadow'|'on'` default shadow, `max-nodes:8` (1–8), `max-bypasses-per-task:8` (1–32), `graph-ttl-ms:60000` (1000–60000), `boundary-timeout-ms:100` (10–100). Settings are user-only. Reading a project-level graph or transcript cannot authorize execution. Timeout is for pure selection, not tool execution; exceeding it abstains before dispatch. Per-tool and task deadlines remain host-owned. A settings change invalidates every affected graph.

## 4. Controller state and invalidation

States are `empty → armed → dispatching → armed | completed | invalidated`. Node states are `pending → executing → succeeded|failed|uncertain`, then never return to pending. Before proposing a node, compare all captured generations and tool/config hashes; check TTL, task ID, host limits, previous final receipt, supported adapter and literal argument hash. Only the next pending node can be eligible. Multiple candidates indicate corrupt state and cause invalidation, not arbitrary selection. Unsatisfied or unsupported guard invalidates the remaining graph and returns reason. All semantic uncertainty returns to the main actor.

Workspace epoch advances for known mutations. After an owned node completes, adopt the host's new epoch only if that node was the sole active source of mutations and its authoritative receipt proves settlement. Unknown Bash effects, concurrent writes by another session, watcher events outside the owned action, cwd/environment changes, dirty-watch overflow or a missing workspace observer invalidate. A shell build/test can mutate its declared workspace; in v1 D conservatively invalidates after every Bash node because arbitrary command effects cannot be attributed completely. Consequently a graph can execute a fixed next Bash command, but build→test in one continuation is better served by B. Extending D past Bash requires a future declared-effect contract and is not silently inferred from exit zero.

New user input, any additional instruction context, policy/catalog/config changes, cancellation, tool denial/failure, malformed receipts, graph expiry or host capability loss invalidate the remainder. No automatic final answer or commit/push action is added by success. A passing test is not a terminal state for the agent; after graph completion, the host calls normal reasoning.

Shadow mode authorizes graph registration but always returns reason to the host. It logs candidate eligibility and proposed node IDs, records zero executed bypasses, and never executes a stored action. Do not advance node completion by guessing what a hypothetical fast path would have done. Normal actor actions can only be matched as diagnostic observations by exact action/argument hash; they do not count as graph executions or savings.

## 5. Audit and persistence

For each accepted execution, persist a `substitution` record containing v1, task/session, boundary ID, graph ID/hash, node ID, predecessor receipt ID, exact argument hash, real native call ID, final receipt ID, captured/rechecked generations and host commit disposition. Full arguments live in the ordinary protected host call event, not a duplicate unredacted ledger. Audit verifies the immutable graph hash, exact argument binding, predecessor causal completion, guard facts, unique boundary disposition, committed native receipt, and no associated model logical request at that boundary. Hashes provide integrity linkage only; a malicious process can rewrite local files and no signature/trust service is implied.

Run the full hash/receipt audit online while original immutable arguments remain available. Historical re-audit requires the original protected registration/call events; if redaction or retention has removed the material needed to recompute a hash, return audit-unavailable rather than treating a stored hash as independent proof. Do not bypass redaction to preserve auditability.

No guessed `tokensSaved` field is stored. `/cost task` may show `executedBypasses`, `shadowEligible`, `rejectedProposals`, and `auditFailures` as separate counters derived from matched records. Total cost comparison comes from E. An incomplete audit reports an unverified substitution, never certified savings. If receipt/audit persistence fails before dispatch, abstain. If it fails after effects, mark node uncertain, invalidate graph and expose the possible executed action to the main actor; never retry it.

Graph state is live-memory only and dies on disposal/restart. Persist a redacted graph registration event for debugging plus hashes/audits, but NEVER re-arm from disk. A crash between dispatch and result is uncertain and requires normal actor/user inspection on resume. This intentionally provides at-most-once scheduling in one live activation, not exactly-once external effects. No filesystem transaction can guarantee the latter for arbitrary tools.

## 6. Implementation map and acceptance

D0 modifies the external harness agent loop/driver, task attribution lifecycle, input queue generations, public descriptor, native result commit and transcript events. D1 adds `src/{index,settings,authoring,state,eligibility,host-adapter,audit,workspace-observer}.ts` in the new package, public integrations with B/C/A, optional service composition and automatic event rendering in TUI/web readers. Persist original tool visibility and native permissions; never import the private scheduler symbol for dispatch.

| Case | Required outcome |
| --- | --- |
| Registration → unique supported next action | Native call once, ordinary policy, one matched bypass audit |
| New input during selection or approval | No stale body invocation; graph invalidates |
| Hidden/replaced tool or policy update | Proposal refused; no stale authority |
| False/unknown guard or malformed predecessor | Normal actor, no automatic branch |
| Multiple candidates/cycle/tampered hash | Registration reject or graph invalidation |
| Cancellation/terminal predecessor/limits reached | No new boundary dispatch |
| Additional contexts from child | Delivered in normal order; successors invalidated |
| Bash node settles | Node recorded, remaining graph invalidated conservatively |
| Resume after process death | No graph reactivation or replay |
| Duplicate host commit | Detected; no second execution |
| Host executes and reasons at same boundary | Audit fails; complete savings claim blocked |
| Shadow mode | Zero stored effects and zero executed bypasses |
| Unsupported host/code presentation | Controller disabled/abstains, B and ordinary execution intact |

Use deterministic host contract tests plus real loop integration with a fake model that counts actual logical and physical requests. Assert no request at executed boundaries and normal final reasoning after completion. Add state-machine property tests for cancellation, invalidation and commit ordering. Formal-design may model this state machine, but is supplementary to executable host tests. D's on-mode pilot waits for E1 and A2; default enablement is a separate decision.
