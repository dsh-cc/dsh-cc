# SystemOne enhancement detailed design index

Status: Proposed — not yet implemented. Date: 2026-11-02. Source baseline: `31fb29eb77148e92ca8da365adcbf4994622a31d`.

This document set splits the SystemOne enhancements into twelve features that can be reviewed, developed, verified, and rolled back independently. This commit contains design only; it changes no product defaults, permission policy, model configuration, or VWA delivery tier. Where a file, interface, or command is marked "new", it refers to a later implementation deliverable and does not mean it exists in this commit.

## Formal design

Formal-design screening (session-adopted: the project rules carry no
formal-design screening clause at this revision; adoption snippet at
`<skill>/references/agents-snippet.md`):

| Feature | Decision | Backends | Model |
|---|---|---|---|
| S1-01 | not-needed | none | stateless request/response validation; the contract-boundary test matrix is the acceptance tool |
| S1-02 | enabled (FD-T2/T3/T4, FD-L2) | tla, lean | `specs/tla/decision-runtime-quota`, `specs/lean/decision-quota-accounting` |
| S1-03 | enabled (FD-T1/T2) | tla | `specs/tla/memory-recall-dispatch` |
| S1-04 | enabled (FD-T1/T2/T3/T4) | tla | `specs/tla/extraction-watermark` |
| S1-05 / S1-06 / S1-11 / S1-12 | enabled (FD-T1/T2) | tla | one shared coalescing protocol: `specs/tla/decision-gate-coalescing` |
| S1-07 | enabled (FD-T1/T2/T3; permit face shared with S1-08) | tla | `specs/tla/vwa-support-triage` (scheduling); the reserve/settle protocol it rides on is `specs/tla/decision-runtime-quota` |
| S1-08 | enabled (FD-T2/T3/T4, FD-L3) | tla, lean | `specs/tla/vwa-audit-split`, `specs/lean/audit-merge-lattice` |
| S1-09 | not-needed | none | a pure threshold policy function with no new state machine; pinned examples in tests are the acceptance tool |
| S1-10 | enabled (FD-T1/T2) | tla | `specs/tla/moa-acceptance-judge` (the placeholder guard is its own state machine; the escalation ladder and shadow precedence stay with the existing moa-cascade-routing model) |

not-needed is not permanent: a waiver covers only its recorded scope, and
behavior that later changes returns to screening. Model records live in
each model directory (design.md, implementation.md with runIds,
counterexample classifications and unverified scope).

## Existing foundations and goals

The repository already has [`@dsh-cc/systemone`](../../packages/llm-tuning/systemone/src/client.ts); the permission gauge, tool-result prompt-injection probing, and MOA routing/judging already use the native SystemOne protocol. This work does not rebuild a model provider, nor does it configure the SystemOne decision model as the main agent's chat model.

The goal is to attach selection, classification, ranking, and pre-call filtering to the existing native protocol, so as to reduce unnecessary generation calls or improve candidate discovery. Summaries, code, explanations, and formal review rationale remain the generation model's job. A type-correct answer is not a correct judgment; every probability threshold below is policy configuration still to be validated.

[TypeSafe's official coding Agent boundary](https://docs.typesafe.ai/introduction/coding-agents), [Choice](https://docs.typesafe.ai/primitives/choice), [Score](https://docs.typesafe.ai/primitives/score), [Noul](https://docs.typesafe.ai/primitives/noul), and [context limits](https://docs.typesafe.ai/models) are the protocol basis. Deployed gateway capabilities follow explicit configuration; official windows are not applied directly to internal model aliases.

## Independent deliverables

| ID | Design | Priority | Independent deliverable | Hard dependency |
|---|---|---|---|---|
| S1-01 | [Request and response validation](2026-11-02-systemone-01-contract-validation.md) | P0 | Request-aware strict validation plus a gauge missing-probability defense | none |
| S1-02 | [Runtime, budget, and metering](2026-11-02-systemone-02-decision-runtime-metering.md) | P0 | Injectable runner, persistent quota, and `/cost` decision accounting | S1-01 |
| S1-03 | [Memory recall](2026-11-02-systemone-03-memory-recall.md) | P1 | Standalone relevance selector over fixed candidate memories | S1-01/02 |
| S1-04 | [Pre-extraction memory gate](2026-11-02-systemone-04-memory-extraction-gate.md) | P1 | Bounded-incremental persistent information gate with a reliable watermark | S1-01/02 |
| S1-05 | [Semantic tool discovery](2026-11-02-systemone-05-tool-discovery.md) | P2 | Retrieval that covers lexical zero-hit cases plus selective activation | S1-01/02 |
| S1-06 | [Skill recommendation](2026-11-02-systemone-06-skill-recommendation.md) | P3 | Standalone read-only recommendation consumer that does not replace the skill provider | S1-01/02 |
| S1-07 | [VWA support triage](2026-11-02-systemone-07-vwa-support-triage.md) | P2 | Assists prioritization; does not replace the formal review record | S1-01/02 |
| S1-08 | [VWA audit split](2026-11-02-systemone-08-vwa-audit-split.md) | P2 | Separates local alignment from full-text checking; assists candidate ranking | S1-01/02, VWA permit shared module |
| S1-09 | [MOA context routing](2026-11-02-systemone-09-moa-context-routing.md) | P2 | Short follow-up context plus an explicit low-capability risk policy | S1-01/02 |
| S1-10 | [MOA per-dimension acceptance](2026-11-02-systemone-10-moa-acceptance.md) | P2 | Separately framed probability questions reusing the existing escalation state machine | S1-01/02 |
| S1-11 | [Tool summary gate](2026-11-02-systemone-11-summary-gate.md) | P3 | Skips clearly low-value summaries before TUS generation | S1-01/02 |
| S1-12 | [Compaction reducer gate](2026-11-02-systemone-12-reducer-gate.md) | P3 | Filters before the generative reducer; does not replace the verifier | S1-01/02 |

S1-03 and S1-04 do not depend on each other; S1-05 and S1-06 share no mutable directory; S1-07 and S1-08 share the VWA permit adapter module defined in S1-07, which must ship first as a separate foundational commit — the two features share no assist-decision cache and neither requires the other to be enabled; S1-09 and S1-10 do not require simultaneous enablement; S1-11 and S1-12 share no generation task. Each implementation PR delivers only the behavior of its own row; unfinished features are tested through dependency-injection stand-ins, and copying a temporary runner into business code is not allowed.

## Development order and integration boundary

Merge S1-01 first, then S1-02. The remaining features can be developed in parallel against the fixed interfaces, but both prerequisites must exist before they reach production. The first end-to-end pilot is S1-03, because it has an existing selector seam and recall evaluation; S1-04 and S1-05 follow. Deployments with heavy document load may start with S1-07/08, but assist results must never be written up as a formal pass.

The runner types and budget permit of S1-02 are the single cross-document specification. Local interfaces in other designs may not redefine the same names with different semantics; if implementation genuinely requires a change, it must first be made jointly in S1-02 and in every consumer's tests. No consumer may call SystemOne directly through `llm/stream`.

Existing behavior stays the default: every new mode is `off`. `shadow` may incur extra model cost; it records suggestions only and changes no decision (S1-10 is the documented exception: its shadow mode additionally disables the same round's legacy acceptance judge to avoid two judges racing to escalate). Failure behavior in `active` is specified by each document. S1-01 is the exception — it is a protocol defect fix with no model switch, so strict validation takes effect directly.

## Shared conventions

### Identity, isolation, and stale results

All candidates pass the existing scope, permission, path, and invocation-eligibility checks before reaching the decision service. Candidate IDs are generated by the host; the model cannot return arbitrary paths, tool names, or skill names to widen eligibility. Caches and shown state must not be reused across projects, sessions, or agents.

`DecisionScope.originSeq` denotes the persistent-log watermark that triggered this turn; if the user message has not yet been written to the log, use the log watermark of the synchronous capture and additionally use that feature's in-memory generation to identify the current turn. It is not guaranteed to be the user message's own seq. After an await, scope, generation, mode, directory, or binding version must be re-validated; a stale result may not carry into the next turn.

Directory and state hashes use canonical JSON followed by a full SHA-256. The final tie-break key in candidate ranking is a stable ID; relying on the key order of the model's answer object is forbidden. JSON is never truncated, and evaluating only some candidates is never reported as a complete filter. The per-batch limits, over-limit behavior, and failure fallback given in each document are part of the acceptance contract.

### Routing, probability, and versioning

The host returns a bound runner via `ctx.systemoneDecisions.forAgent(agent)`; the scope is obtained from `bound.scope(originSeq?)`, and business code may not forge an identity. When originSeq is omitted, the host's `agent.session.seq` is read. The runner's `identifyRoute(alias,scope)` returns a keyless provider/model/capability revision. The semantic cache must include these fields, the question and policy version, the full input/directory version, and the scope; if the identity changes after an await, the entry is discarded. When the deployment checkpoint changes, the capability revision must be updated and the thresholds recalibrated. The `gauge` alias name itself must not be treated as a model version.

Independent objects use their own Noul/Score; one Choice's competitive probabilities must not be treated as independent per-object relevance. Score is the expected value of a rubric's numeric index and may be fractional. Noul returns probability only and has no independent confidence. Each policy reads the fields that match its risk; `confidence=0.9` must not be interpreted as an observed 90% true correctness rate.

### Budget and failure

All new requests are reserved, dispatched, and settled by S1-02; each attempt is billed separately, and missing usage is retained as an unknown upper bound. VWA connects to the existing run/cycle/project budgets through the optional budgetPermit of the same runner and may not keep a separate ledger of "free cache calls".

None of the following may be presented as a favorable model judgment: missing service, missing route, missing capability, over-limit input, insufficient budget, cancellation, or malformed output. The business layer falls back to its original behavior or does nothing, per its own failure table. Fallback generation calls keep their own original budget and are not waived because SystemOne already failed.

### Privacy and authority boundary

Send only the minimal state the judgment requires. Metadata-only discovery features read no body text; evidence and summary features that need original text must list their input range explicitly. A new namespace does not authorize uploading the whole repository, environment variables, or full sessions.

Shared metering stores only hashes, versions, usage, and fixed reason codes — never request bodies, keys, or raw model errors. Formal evidence/review records held by the business layer follow the existing storage rules; assist conclusions may not become permission grants, test-pass credentials, or a formal VWA ReviewRecord.

## Design complete vs. implementation complete

This document set defines goals, interfaces, settings, state machines, failure tables, file responsibilities, tasks, tests, and release gates. Its thresholds, test counts, and performance gates are pre-registration requirements for later experiments, not results already obtained.

Later implementers should use a per-task execution style and complete red/green verification against the test matrix listed in each file. The TypeScript fragments in the specs define public contracts or pure policy; they are not claims of implemented production modules. Where integration with an external harness is needed, the current source interfaces govern; if a dependency upgrade changes an interface, this design must be updated first rather than substituting a guess.

Every implementation delivery must satisfy the following common checklist plus its own feature-specific gate:

- [ ] Off-mode regression on old behavior and call counts passes; a missing shared runtime has a defined result.
- [ ] Cancellation, concurrency, stale results, directory/mode changes, over-limit input, and insufficient budget are fully covered.
- [ ] A new package declares all direct dependencies and updates the lockfile, tsconfig, and exports.
- [ ] Tests for the owning module, typecheck, and relevant static gates pass.
- [ ] Model evaluation distinguishes replay/mock from real online data; the threshold-tuning set and the release test set are kept separate.
- [ ] All costs include SystemOne, retries, failures, and generation fallback; unknown costs are marked explicitly.
- [ ] If visible capability changes, update `docs/claude-code-capabilities.yaml` and run `pnpm docs:parity`; README changes stay paired in Chinese and English.
- [ ] Ship a reviewable kill switch, rollback steps, and known limitations; this document set itself approves no default flip.

## Acceptance for this documentation PR

All twelve designs and the index live in docs/plans. Check relative links between files, existing source links, shared type names, feature identifiers, default modes, thresholds, and failure tables, and confirm there are no mutual contradictions. References to new files are marked "new" with their code path and must not masquerade as links to something that already exists.

This PR runs no online SystemOne decision-model evaluation, implements no feature, and runs no future test command that pretends to already exist. Verification covers document completeness, reference consistency, `git diff --check`, and repository static gates that need no install. CI results must be reported independently; passing design review is not runtime verification.
