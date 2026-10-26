# Feature B: bounded literal action chains

- Status: proposed; depends on Feature A's attribution and logical collection.
- Owners: new `packages/core/continuation-contracts` (`@dsh-cc/continuation-contracts`) and `packages/core/tool-continuation` (`@dsh-cc/tool-continuation`).
- Parent: [implementation order](2026-10-27-guarded-execution.md).

## 1. Problem and scope

A build result can merely authorize a test command that the model already selected. Another request to regenerate that command is unnecessary. Provide a typed, bounded composite tool named `execute_continuation`. It executes fixed actions with deterministic readiness checks and returns all settled outcomes. It does not interpret output, edit arguments from results, choose a new action, repair failures, resume after process death, or declare task completion.

Code Mode already executes programs containing the same sequence. The new tool earns its place through constrained schemas, common receipts, explicit stop reasons, and reuse by C/D. It MUST NOT be enabled by default or described as proven cheaper until E compares it with Code Mode. It requires no host callback interception and records zero certified bypasses.

## 2. Wire contract and validation

The contracts package owns `schemas/{plan,receipt,result}.schema.json`, canonical serialization, hashing, validator, pure guard evaluator, and exported types. It has no Cordis, provider or shell dependencies. Input is:

```ts
interface Plan {
  v: 1;
  nodes: Node[];
}
interface Node {
  id: string;
  tool: string;
  arguments: Record<string, JsonValue>;
  after: string | null;
  guard: { kind: 'start' } | { kind: 'success' } | { kind: 'exit-zero' };
}
```

All object schemas have `additionalProperties:false`. Node IDs match `^[a-z][a-z0-9_-]{0,31}$`, are unique, and are local to this plan. There are 1–8 nodes, in execution order. The first node has `after:null` and `guard:{kind:'start'}`. Each later node references exactly the immediately previous node and uses success or exit-zero. This v1 is a linear DAG, not a branching scheduler. Reject forward references, disconnected nodes, duplicate IDs, arbitrary expressions, template interpolation, JSON pointers into future results, and function/code payloads. Arguments are literal JSON, maximum nesting depth 16, maximum 64 KiB for the canonical complete plan. Strings inside arguments are opaque literals; a shell string is not evaluated by the chain but is still interpreted by the native shell tool. Explicitly do not reject ordinary literal `${...}` text merely because it resembles a template.

Before any action, validate the whole plan, enforce byte/node limits, resolve each tool in the calling agent scope, validate arguments against its current registered parameter schema, and confirm the selected guard has a registered receipt adapter for the predecessor. Runtime validation is repeated by native dispatch. No automatic tool loading or search occurs. Missing tools or adapters reject the complete plan with zero child calls.

An allowlist in user-only `continuation` settings owns eligible tool names: default empty. A built-in hard exclusion forbids nested `execute_continuation`, `run_code`, agent spawning/messaging tools, turn-concluding tools, plugin/config/preset mutation tools, and dynamically loaded MCP tools in v1. Initial tested adapters support only `read`, `edit`, `write`, and `bash`; configured names outside that supported set are rejected at settings load. Shell commands remain subject to native policy; approval for the outer tool never grants approval to a child. This is a product scope bound, not a shell sandbox.

`guard:success` requires a final canonical non-error predecessor. `exit-zero` requires the predecessor's versioned native `bash` adapter to expose a numeric zero exit code, `timedOut:false`, and no cancellation/signal termination, plus a final non-error result. Inspect actual canonical output schema in implementation and map it in one adapter; do not parse rendered prose or a compressed result. If the runtime cannot provide those facts structurally, reject exit-zero during preflight with `UNSUPPORTED_RECEIPT`. A shell tool can return non-error for a nonzero command exit; success and exit-zero therefore intentionally differ. Examples that require a successful build MUST use exit-zero.

## 3. Invocation state machine

Create a server UUID `graphId` and SHA-256 `graphHash` over the canonical Plan. Canonical JSON sorts object keys recursively, preserves array order, encodes UTF-8, rejects non-JSON values and lone surrogates, and does not normalize string content. Use this algorithm consistently in C/D; do not use an abbreviated hash for authority.

States are `validating → running → completed | stopped`. Validation errors return a structured tool error, no child effects. Once running, node state is `pending → executing → succeeded | failed`; an unexecuted node becomes `skipped` only on stop. No retries or rollback. Execute nodes strictly sequentially; tool `isConcurrencySafe` returns false. A session-local mutex prevents overlap with another continuation; refuse the second invocation as `BUSY` rather than queue it. Host scheduler exclusivity prevents sibling model tool calls in the same session from overlapping; other sessions remain independent and are handled conservatively by C/D.

For each node: check deadline and cancellation, evaluate its guard from the prior final receipt, re-resolve the allowed tool, compare definition/parameter-schema generation with preflight, then call `ctx.tools.execute` with the current agent, original `rootCallId`, `parent:outerExec.token`, derived `callId:<outerCallId>:continuation:<index>`, exact arguments, and a signal combining outer cancellation and the chain deadline. Definition changes, new queued user steering (when the host exposes it), or allowlist changes stop before the next dispatch. No private scheduler calls or direct tool body calls.

After child settlement, forward every `additionalContexts` exactly once with `outerExec.deferContext`, in node order, including contexts on failure. A child `concludesTurn` is an unexpected terminal boundary: forward `outerExec.concludeTurn()` only for an authoritative successful child and stop immediately; no later nodes execute. This is defense in depth for tool replacement after preflight; preflight excludes known turn-concluding tools.

Guard false, failure, denial, unknown receipt, deadline, unsupported tool change and cancellation stop the chain. A prompt-to-approve may be serviced only by normal native policy; elapsed approval time counts against the deadline. Cancellation waits for owned child work to quiesce before returning. A deadline is cooperative, not proof that external work was killed. Do not race a child promise and start recovery while it remains active.

Settings: `enabled:false`, `allowed-tools:[]`, `max-nodes:8` (1–8), `timeout-ms:120000` (1000–120000), `max-result-bytes:16384` (4096–65536). Caps are user-only; a model cannot raise them. The original tool's timeout still applies. An outer cancellation may normalize the outer result to a native error; durable per-node receipts survive and remain inspectable in the transcript.

## 4. Results and receipts

The successful composite transport returns a canonical value with fields `v:1`, graph ID/hash, `status:completed|stopped`, `stopReason:null|guard-false|child-failed|cancelled|deadline|tool-changed|unexpected-terminal|receipt-unavailable`, `lastNodeId:string|null`, and a `nodes` array. Stopped execution is a successful transport report about a partial workflow, never a claim that all actions succeeded. Failures in the transport itself remain native tool errors. Each row records node ID, `state`, tool, child call ID or null, canonical argument hash, receipt ID or null, and bounded model-facing content preview. Pending nodes become skipped with the common stop reason. Content preview truncation never changes guard facts.

Each dispatched child has a durable receipt:

```ts
interface Receipt {
  v: 1; receiptId: string; graphId: string; nodeId: string;
  sessionId: string; taskId: string; childCallId: string;
  tool: string; argumentsHash: string; adapterVersion: string;
  isError: boolean;
  exit: { code: number | null; timedOut: boolean; signalled: boolean } | null;
  resultHash: string; startedAt: string; endedAt: string;
}
```

Result hash covers the final canonical value on success or bounded structured error code on failure; raw symbol tokens are never serialized. Guards consume the in-memory frozen result and adapter facts, not reloaded receipts. Receipts are attribution/audit facts, not permission to replay a child. No export to cross-task reusable executable memory is added.

Because native nested calls are not necessarily appended by the agent loop, the composite MUST log an explicit versioned nested-dispatch record for each child with its rendered content and call identity, using a new public host session event contract if required. Preserve the existing Code Mode behavior; do not falsely log these as `run_code` dispatches. A required `continuation/dispatch-v1` event capability is checked before tool registration, and a missing event capability disables B with one actionable warning. Its proposed event payload is `{v:1, outerCallId, childCallId, graphId, nodeId, tool, argumentsHash, receipt, content, isError}`; it contains no canonical value. Host transcript/UI readers MUST render it without treating it as an assistant-authored tool call.

Persist full rendered content under the host's existing spill/redaction policy, not arbitrary new unredacted files. The result's aggregate preview respects max-result-bytes and always retains node identity/status and omission markers. Large canonical values remain execution-local. Preview truncation cannot remove the durable receipt or change success/exit facts. Failure to commit a child receipt after effects stops further execution with receipt-unavailable; report possible effects and never retry automatically. When the host cannot persist nested records, the feature does not execute effects.

## 5. Composition and installation

Optional Cordis plugin; requires `tools`, accounting attribution, and nested event capability. Register in the CC services realm only when enabled and compatible. Register the tool through `defineTool` with a complete output schema and an exclusive classifier. The tool contributes its schema normally, so native and both presentations work; Code Mode can call it through the SDK if allowed, although E compares unwrapped Code Mode separately. Do not modify the default presentation or system prompt globally. A short tool description explains that new semantic decisions require a model turn and that shell pipelines may already be simpler.

`continuation-contracts` exports only schema, types, canonical/hash, guard and receipt-adapter contracts. `tool-continuation` owns `src/{index,settings,preflight,executor,receipts,render,adapters}.ts`. New public receipt adapter API is `supports(toolDefinition):boolean` and `extract(finalResult):ReceiptFacts|undefined`; the tested native adapter is pinned to the supported tool schema hash. A schema mismatch is unsupported, never a fallback to text parsing. Update package/public export/alias/reference/lockfile checks. No modifications to `context-crusher` canonical values are needed.

## 6. TDD acceptance and release gate

| Test | Required assertion |
| --- | --- |
| Fixed build → tests → diff | Exact arguments dispatched in order; exit-zero checks native exit fact |
| Nonzero exit, timeout, signal or policy denial | No successor dispatched; stop reason accurate |
| Malformed final node or unsupported adapter | Whole plan rejected before first child |
| Denial/approval on child after approved outer | Child policy still runs and can deny |
| Hidden tool, alias, changed definition | No authority gained from stored names |
| Pre-abort and mid-child abort | No dispatch vs child drained; no later effects |
| Additional context on error; unexpected terminal | Context forwarded once; terminal signal preserved; chain stops |
| Huge output/compression | Preview is bounded; canonical guard outcome unchanged |
| Event persistence failure after child effect | Stop, report uncertain effect, never replay |
| Code Mode vs new tool | Both preserve scoped admission and parent/root correlation |
| No event capability/feature disabled | No tool schema and no effects |

Run contracts/tool-continuation tests plus core/tools, post-edit-verify, transcript/UI event readers, and preset composition suites. Add a fake cooperative shell integration test without a paid model. Live benchmark and deployment are E, not acceptance shortcuts. Acceptance MUST verify actual host nested event persistence, not just a mocked emitter.
