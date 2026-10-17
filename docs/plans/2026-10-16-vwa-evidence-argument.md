# dsh-cc VWA: Design for Evidence and Argumentation Reviewability Extensions

- Document version: 1.1
- Date: 2026-10-16
- Status: Design specification; reviewed by three blind seats (see § Review ledger); not implemented. This document defines target behavior; it does not claim that any feature is implemented or has been tested.
- Scope: VWA lane 2 — historical analysis, literary criticism, research syntheses, and argumentative essays that require evidence support.
- Code baseline: `dsh-cc/dsh-cc@29a157b71194e274db47cdd551092e0c714b562f`. The baseline and the working branch MUST be re-diffed before implementation begins.
- Preceding design: [Verifiable Workspace Agent (fixed baseline)](https://github.com/dsh-cc/dsh-cc/blob/29a157b71194e274db47cdd551092e0c714b562f/docs/plans/2026-10-12-verifiable-workspace-agent.md). The blob SHA of the original design file is listed in Section 25, for content identification only.
- Deliverable shape: this document, a machine-readable argument graph, review records, a reader-facing review report, and runtime receipts.

## 0. Reading conventions and decisions

In this document MUST / MUST NOT are mandatory requirements; SHOULD marks a recommendation from which deviation is permitted when documented. TypeScript types and rule tables together form the contract; where a field's semantics could be read two ways, the field's rules win. All new functionality is gated by the `semantic-enabled` setting, which defaults to off and changes neither the existing cc preset nor lane 1 behavior.

This specification leaves no architectural branches for the implementer to choose from: storage uses immutable JSON snapshots plus an atomic HEAD; schemas use JSON Schema Draft 2020-12; the validator is Ajv 8 in strict mode; v1 sources accept only UTF-8 workspace text; review uses the host's existing model-invocation service; one new package, `@dsh-cc/vwa-argument`, is added; the existing `@dsh-cc/vwa-evidence` remains the sole receipt writer. Build and dependency installation follow the repository's existing rules; no in-house LLM client is introduced.

"Unambiguous" here means that program behavior, data flow, and failure handling can be implemented deterministically; it does not mean that a model's judgment on literary or historical questions can be proven correct with certainty. All model judgments MUST retain the input version, the review basis, and the unchecked items.

## 1. Problem statement and success conditions

VWA today verifies citation locations and the mechanical rules of a document, but it cannot adequately answer four questions:

1. Which conclusions are supported by which material, and to what degree?
2. How does material, through explicit premises and inference rules, give rise to a conclusion?
3. When there is a dispute, does it concern the material, a premise, an inference step, or the conclusion?
4. Which material is still missing, which conclusions does that absence affect, and what specifically should be looked up next?

This extension MUST make every core conclusion expandable into `Claim → Evidence / Argument → Source`, alongside its associated Issues, search scope, and review status. When the body of the document forms a new claim, strengthens a tone, or broadens a scope, the independent review process MUST detect it. Once sources, claims, arguments, the body, review rules, or model configuration change, affected prior reviews MUST no longer count as current reviews.

Success is not conditioned on "no disputes" or "all A grades". A paper that honestly presents competing explanations and unresolved questions can pass; a paper that presents unchecked content as established fact cannot.

### 1.1 Non-goals

- Not proving the objective truth of historical events or literary interpretations, and not assigning uncalibrated truth/falsehood probabilities.
- Not emitting or storing the model's internal chain of thought; only publicly inspectable argument summaries are stored.
- Not implementing automated publication, automated user sign-off, academic-originality proof, or full plagiarism detection.
- Not implementing PDF/OCR, web scraping, or external search engines; existing tools are reused to produce text snapshots.
- Not introducing new subagent types, graph databases, general-purpose theorem provers, or an ASPIC+ solver.
- Not treating vote counts across models or source counts directly as credibility.

## 2. Existing implementation boundaries and compatibility strategy

The following are observations of the fixed code baseline, not new features:

| Location | Existing behavior | Extension action |
| --- | --- | --- |
| `packages/interaction/vwa-evidence/src/verify.ts` | The `marked-ok` check validates paths, files, and line ranges; no semantics | Types unchanged; UI states explicitly "citation location valid" |
| `src/marker.ts` (same package) | Four rule classes plus explicit-marker-triggered extraction | Kept; lane 2 adds a separate full-text semantic extraction. `parseMarkerInner` MUST recognize the `claim:<id>` prefix: on the lane-1 mechanical surface, `〔claim:<id>〕` is treated as non-marker text — skipped, no `invalid-marker` raised, and all offsets preserved |
| `src/pipeline.ts` | Only the first source of a claim is stored; `provenance.inputs` initialized empty | v2 records all sources with their revision hash |
| `src/receipt.ts` | v1 JSONL, artifact hash, read-back | Add a v2 to the discriminated union, discriminated by `v` (v1=`1`, v2=`2`), written to the SAME session JSONL ledger `<dshHome>/vwa-receipts/<encodeSegment(sessionId)>.jsonl`; old records are neither migrated nor rewritten. Type names reuse the existing `NumberEntry`/`GateEntry` exports |
| `src/evaluator.ts` | Turn-stopping, write/edit event discovery, self-repair budget | Hook in lane-2 status checks; explicitly register body-completion discovery |
| `docs/vwa/writing-guidance.md` | Lane-1 marker discipline | Add a lane-2 guidance fragment without overriding lane 1. The fragment MUST state that bound paths are hash-watched — writes from any editor trigger re-evaluation — while unbound paths remain editing-tools-only |
| `packages/evaluation/vwa-eval` | Gold set and sampling basis | Add semantic samples, evaluation scripts, and a human-annotation protocol |

In the table, `src/…` refers to that package only; later sections always use the full path.

A v1 `overall: pass` MUST NOT be interpreted as semantic review passing. Old receipts display `semantic: not-run (legacy)`. The v2 reader MUST be able to read v1; a v1 reader encountering a v2 row MUST skip the unknown version and MUST NOT deserialize it as v1. All v1 read points (`staleAgainst`, `nudgeBudgetConsumed`, evaluator `readJsonl` consumption) MUST filter `row.v===1` before casting; v2 read-back compares both `(receiptId, receiptHash)`, while v1 rows remain byte-identical with their last-line `artifactHash` read-back path unchanged. Before release, update every receipt consumer and fixture in the repository; if an unupgradable consumer is found, the semantic switch stays off. 
## 3. Overall architecture and module boundaries

New package: `packages/interaction/vwa-argument`. Its public entry exports only `contracts`, `service`, `review-adapter`, and `report`, plus the plugin face (`apply`); deep imports across packages are not allowed.;

| Module | Input | Output | Forbidden behavior |
| --- | --- | --- | --- |
| `schema/` | Tool requests, snapshots, model results | Validated objects or stable error codes | Silently ignoring unknown fields |
| `store/` | Mutations with `expectedRevision` | New immutable revision | Overwriting a committed revision in place |
| `sources/` | Text files and provenance metadata | source/evidence | Passing model-generated text off as independent external evidence |
| `graph/` | Claims, evidence groups, arguments, issues, paragraph mappings | A reference-complete graph and dependency index | Letting cyclic dependencies become support for conclusions |
| `review/` | Frozen revisions, model configuration, budget | Review records, findings, and derived assessments | Accepting review results written by the author itself |
| `policy/` | Current review records | Grades, statuses, delivery predicates | Letting an overall average score offset severe errors |
| `report/` | Current graph, assessments, receipt status | Deterministic Markdown/JSON | Fabricating missing explanations on its own |
| `wiring/` | Presets, commands, tools, turn-end | Service registration, nudges | Writing the receipt ledger directly |

`vwa-evidence` calls `checkForDelivery(projectId, artifactId)` through a new service and, once it has the pure result, writes the v2 receipt. The package-cycle is broken structurally: `vwa-evidence` (the sole receipt writer) does **not** import `vwa-argument`. It declares a structural interface `VwaArgumentDeliveryProvider { checkForDelivery(projectId, artifactId): Promise<{evaluationId:Id; bindingDigest:Hash; check:DeliveryCheckLike}> }` (the same frozen-handle shape as Appendix A) in its own package, where `DeliveryCheckLike` is a minimal structural type declared on the vwa-evidence side (fields matching the `DeliveryCheck` structure of vwa-argument); at runtime the service is obtained via cordis `ctx.get` duck typing. TS structural typing guarantees neither side needs to import the other — no workspace cycle. The `ReceiptV2` type is defined in `vwa-evidence` (owned by the writer); `vwa-argument` only produces pure results. Heavy search and review run only on explicit `argument.review` invocation; turn-end does not start unbounded network research and does not re-review the whole article.

`vwa-argument/*` events are emitted via cordis events (not `session.append`), with the payload table `{projectId, runId?, revision, seq, code?}`.

## 4. Coordinates, identity, versioning, and serialization

All files MUST be valid UTF-8; NUL and unpaired UTF-16 surrogates are not accepted. Body text supports only Markdown/MDX; review treats MDX as text and does not execute code embedded in it.

- `Hash`: SHA-256, lowercase, 64 hex characters; object hashes are computed over the UTF-8 bytes of `stableJson`. stableJson recursively sorts object keys in Unicode code-unit order, preserves array order, and emits no whitespace; NaN, Infinity, and undefined are forbidden.
- Raw text hashes are computed over the original file bytes with no line-ending or Unicode normalization. After reading, it MUST be checked that re-encoded bytes equal the original bytes.
- Character positions are uniformly UTF-16 code units, `[start,end)`, counted from 0; line numbers start at 1 and are inclusive. Evidence canonical positioning is by character position; line numbers are a runtime-derived display field.
- Quote and span definitions are unified: `quote === decodedSnapshot.slice(span.start, span.end)` — a UTF-16 code-unit slice of the decoded string, with no mixing of byte slices. A paragraph/block is normatively the root-level children of a CommonMark parse of the text (parser AST children, not a naive blank-line split — they diverge on lists with blank lines between items, block quotes, and HTML blocks).
- IDs are runtime-generated UUID v4 with `prj_ / src_ / ev_ / cl_ / grp_ / arg_ / iss_ / art_ / rec_ / run_ / task_ / search_ / finding_ / sig_` prefixes; users cannot specify IDs for new objects. Existing IDs may only modify same-project, same-type objects. The mapping of ID types for entities and metadata MUST be validated in the schema; `requestId` is a prefix-less UUID v4.
- `revision` is a project-wide incrementing integer starting at 1; `entityVersion` is a per-object incrementing integer. They increment only when object content changes; objects are not merged by model-text similarity.
- Time uses RFC3339 UTC with millisecond precision. Ordering uses an explicit `seq` first, then ID; timestamps do not participate in causal ordering decisions.
- All schemas set `additionalProperties:false`; an omitted optional field simply does not exist, null is not accepted unless the type explicitly allows it.
- Empty arrays MUST be provided explicitly; narrative fields must be non-empty after trim. Body text, original text, and `quote` are not trimmed.
- String limits are counted in UTF-16 code units: unless otherwise specified in the type, single-line fields cap at 512, explanation fields at 4000, claim text at 2000; `quote`/context cap at 12000, occurrence `exactText` at 12000, contract question at 4000. A single array holds at most 1000 items; project entity arrays such as sources/claims are bounded by the `maxEntities` total rather than the 1000-item limit. Tool payloads cap at 2 MiB.

The JSON Schema `maxLength` is not the sole implementation of UTF-16 length: the schema validates types first, then the runtime enforces the code-unit limits above via `string.length`. All integers MUST be safe integers; spans must satisfy 0≤start<end≤the corresponding string's `.length`; revision/version≥1; token/count≥0.

## 5. Authoritative data model

The interfaces in this section are normative types. Implementations MUST generate or validate the corresponding TS types from the same schema; maintaining two sets of validation rules that can drift is not allowed. `Entity` system fields are filled in by the runtime; tool input uses the body with system fields removed.

```ts
type Hash = string;
type Id = string;
type Span = { start: number; end: number };
type Entity = {
  id: Id; entityVersion: number; createdAt: string; updatedAt: string;
};
type Ref = { id: Id; entityVersion: number };
type ClaimKind = 'fact' | 'source-report' | 'interpretation'
  | 'causal' | 'intent' | 'evaluation';
type Scope = {
  subject: string; corpus: string[]; time: string;
  geography: string; exclusions: string[];
};
type Source = Entity & {
  snapshotPath: string; snapshotHash: Hash;
  acquisition: {kind:'tool-event'|'user-file'|'unverified';
                capturedAt:string;eventRef?:string};
  title: string; creators: string[]; publication: string;
  originalLocator: string; edition: string; language: string;
  origin: 'external' | 'user-provided' | 'agent-generated';
  material: 'primary' | 'secondary' | 'literary-text' | 'other';
  lineage: { relation: 'independent' | 'derived' | 'unknown';
             parentSourceIds: Id[]; note: string };
  authenticity: 'unverified' | 'documented' | 'questioned';
  authenticityBasisEvidenceIds: Id[];
};
type Evidence = Entity & {
  sourceId: Id; sourceSnapshotHash: Hash;
  span: Span; quote: string; contextSpan: Span;
  originalLocation: string;
  transformation: 'none' | 'translation' | 'transcription' | 'extraction';
  transformationNote: string;
};
type Claim = Entity & {
  text: string; kind: ClaimKind; scope: Scope;
  importance: 'core' | 'supporting';
  stance: 'asserted' | 'qualified' | 'hypothesis' | 'attributed';
  evaluationCriteria: string[];
};
type EvidenceGroup = Entity & {
  targetClaimId: Id; evidenceIds: Id[];
  mode: 'all' | 'any'; rationale: string;
};
type Argument = Entity & {
  premiseClaimIds: Id[]; evidenceGroupIds: Id[];
  conclusionClaimId: Id;
  scheme: 'deductive' | 'causal' | 'abductive'
        | 'interpretive' | 'generalization' | 'evaluative';
  warrant: string; assumptions: string[]; limitations: string[];
};
type Issue = Entity & {
  targetId: Id;
  kind: 'source-reliability' | 'counterevidence'
      | 'alternative-explanation' | 'missing-evidence' | 'inference-gap';
  description: string; evidenceIds: Id[];
  relatedClaimIds: Id[];
  proposedImpact: 'qualify' | 'downgrade' | 'invalidate';
  response: string;
  resolution: 'open' | 'addressed' | 'unresolved';
  gap?: { needed: string; distinguishes: string[];
          nextAction: string; ifUnresolved: string };
};
type SearchLog = Entity & {
  purpose: string; targetIds: Id[];
  corpus: string[]; query: string; tool: string;
  performedAt: string;
  state: 'executed' | 'failed' | 'planned';
  resultSourceIds: Id[]; inaccessible: string[];
  finding: 'relevant-found' | 'none-found' | 'inconclusive';
  executionEventRef?: string;
  externalAttestation?: string;
};
type Occurrence = {
  claimId: Id; span: Span; exactText: string;
};
type Artifact = Entity & {
  path: string; contentHash: Hash;
  occurrences: Occurrence[];
  outline: { section: string; goal: string; claimIds: Id[];
             argumentIds: Id[]; qualifications: string[] }[];
};
```

### 5.1 Field rules

When a `Scope`'s time/geography is unconstrained, the literal `unspecified` is used; empty strings are not permitted. `corpus` stores concrete Source IDs; planned material not yet ingested is recorded in the project contract — arbitrary strings must not be fabricated into source IDs. Unconstrained does not mean universally applicable: review MUST check whether the body makes sweeping universal statements on its own.

When a Source's `publication`/`edition` is unknown, write `unknown` and surface it in the report. `originalLocator` is the original URL, bibliographic locator, or user statement; it is not proof of accessibility. `documented` MUST have a non-empty `authenticityBasisEvidenceIds`; those evidence items only prove that authentication grounds were recorded — the runtime must not claim the sources are absolutely authentic. A Source's authentication references to evidence do not participate in the claim-support DAG.

Source independence is derived from `parentSourceIds` as undirected connected components; mutually connected sources belong to the same lineage cluster. `unknown` must not be counted as verified independence; `independent` is metadata pending review and only counts toward the independence condition after the current source review confirms it. `agent-generated` sources must not provide independent support for external facts; they may serve as research subjects for analysis or as fictional text explicitly requested by the user.

An Evidence's `quote` MUST equal `decodedSnapshot.slice(span.start, span.end)` — a UTF-16 code-unit slice of the decoded snapshot string, with no mixing of byte-slice results. `contextSpan` must contain `span`; by default it takes the full paragraph covering the quote plus one paragraph before and after. If it exceeds 12000 characters it MUST NOT be silently truncated: create `CONTEXT_TOO_LARGE`, require an explicitly smaller range, and have review judge contextual sufficiency. `translation` and the like refer to transformation of the snapshot relative to the original material; such transformations must not break the exact match between `quote` and the snapshot. When the original text is unavailable, the report states "only the translated/transcribed text was verified.";

`EvidenceGroup.evidenceIds` is non-empty and deduplicated. `all` means the evidence must be read jointly to support the claim; review is forbidden from misjudging overall non-support because each fragment individually does not entail the conclusion. `any` means each evidence item is an independent candidate path; review must judge them one by one and must not let "any one is relevant" excuse the remaining erroneous citations.

An `Argument` has at least one premise or evidence group; the conclusion is forbidden from being its own direct or indirect premise. All `evidenceGroupIds` must have a `targetClaimId` equal to the `conclusionClaimId`. Premise support is expanded separately. If a necessary assumption of the inference is a verifiable worldly fact, it MUST be built as a premise Claim and must not be hidden only in the `assumptions` string. `assumptions` holds only methodology, interpretive frameworks, and explicitly conditional assumptions.

An Issue of kind `missing-evidence` MUST have a `gap`; all other kinds are forbidden from having one. `addressed` means the author submitted a response, not that review agrees; effective resolution is decided by the review record. `response` may be an empty string when `open`, and must be non-empty when `addressed`/`unresolved`. Opposition claims may enter `relatedClaimIds`; rebuttal edges do not participate in the support DAG, and mutual contestation is allowed.

An `Occurrence` MUST exactly match the body slice; the same span may correspond to multiple atomic claims. Storing only the first 200 characters of the original text is not allowed. Once the body changes, all old occurrences MUST be re-validated and re-reviewed; their continued validity must not be guessed by positional shifting.

### 5.2 Project and research contract

```ts
type ProjectContract = {
  question: string; language: string;
  domain: 'history' | 'literature' | 'research';
  requiredQuestions: { id: string; text: string }[];
  plannedCorpus: string[];
  expectedCoreTopics: string[];
  mode: 'draft' | 'reviewed';
};
type ProjectSnapshot = {
  schemaVersion: 1; projectId: Id; revision: number;
  workspaceIdentity: Hash; contract: ProjectContract;
  sources: Source[]; evidence: Evidence[]; claims: Claim[];
  groups: EvidenceGroup[]; arguments: Argument[];
  issues: Issue[]; searches: SearchLog[]; artifacts: Artifact[];
};
```

`workspaceIdentity` is computed from the root realpath at initialization plus a random workspace nonce; it is not a portable content hash. The nonce is persisted in `.dsh/vwa/<projectId>/workspace.json` — generated at init, rebound by import. Copying the project to another root requires `/vwa import` to verify the path and rebind; directly trusting the old root is forbidden.;

Modifying the contract MUST increment `revision` and mark all semantic reviews stale. `expectedCoreTopics` is a scope constraint preventing hard questions from being deleted to raise the pass rate; the body may answer "cannot be determined," but silently omitting topics is not allowed. The contract is the visible structured explanation of the user's request; the report MUST display it and the user may modify it. No extra confirmation is required before starting.

Review-facing normative types referenced by later sections — `ExtractionRecord`, the per-stage `ReviewResponse` discriminated union, `ReviewJobStatus`, and `AdjudicationRecord` — are defined in the §5/§6 normative type blocks; this slice references them forward. Budget and settings values (per §13) are frozen into the project contract at init as inputs to `reviewerConfigHash`; later settings changes do not affect already-created projects' frozen runs.;;
## 6. Review data and responsibility boundaries


Author tools MUST NOT write Assessment, Finding, ReviewRecord, Receipt, or Signature. Model output may only enter an unvalidated `ReviewResponse`; the runtime validates it and forms immutable records.

```ts
type Verdict = 'pass' | 'fail' | 'needs-review' | 'not-run';
type Support = 'direct' | 'inferential' | 'partial'
             | 'contradicted' | 'irrelevant' | 'unknown';
type Finding = {
  id: Id; code: string; targetIds: Id[];
  severity: 'blocker' | 'major' | 'minor';
  explanation: string; evidenceIds: Id[];
  artifactSpans: Span[];
  repair: 'add-evidence' | 'narrow-claim' | 'qualify'
        | 'repair-argument' | 'address-issue' | 'remove' | 'manual-review';
};
// R1-29: 'minor' is retained in the enum for forward compatibility,
// but no rule in `humanities-v1` currently emits minor findings.
type ReviewJobStatus = 'queued' | 'running' | 'completed'
                     | 'incomplete' | 'cancelled' | 'budget-exhausted';
type Check = { ruleId: string; result: Verdict; rationale: string;
               evidenceIds: Id[] };
type Adequacy = 'robust' | 'adequate' | 'weak' | 'none';
type ResponseBase = { rubricVersion: string; findings: Finding[] };
type ResponseTarget = { targetId: Id; checks: Check[] };
type SourcesResponse = ResponseBase & { stage: 'sources';
  targets: ResponseTarget[] };
type ClaimsResponse = ResponseBase & { stage: 'claims';
  targets: (ResponseTarget & { searchSufficiency:
    'checked' | 'not-checked' })[] };
type SupportResponse = ResponseBase & { stage: 'support';
  targets: (ResponseTarget & { support: Support; adequacy: Adequacy;
    evidenceRelations: { evidenceId: Id; support: Support;
                          rationale: string }[] })[] };
type ArgumentsResponse = ResponseBase & { stage: 'arguments';
  targets: (ResponseTarget & ({ adequacy: Adequacy } |
    { issueImpact: 'none' | 'qualify' | 'downgrade' | 'invalidate';
      issueResolution: 'accepted' | 'rejected' | 'unresolved' }))[] };
type ReviewResponse = SourcesResponse | ClaimsResponse
                     | SupportResponse | ArgumentsResponse;
// The audit and extract response variants are defined in §11.4/§12
// (audit adds alignment; extract returns {items:ExtractedItem[]}).
type MechanicalStatus = 'pass' | 'fail' | 'not-run' | 'inapplicable';
type ReviewRecord = {
  runId: Id; stage: 'sources' | 'claims' | 'support' | 'arguments' | 'audit';
  targetRefs: Ref[]; dependencyDigest: Hash;
  artifactHash?: Hash; contractHash: Hash; policyHash: Hash;
  reviewerConfigHash: Hash; promptHash: Hash; inputHash: Hash;
  responseHash?: Hash; response?: ReviewResponse;
  status: 'completed' | 'error' | 'cancelled' | 'budget-exhausted';
  inputTokens: number; outputTokens: number; startedAt: string; endedAt: string;
  errorCode?: string;
};

// One extracted atomic claim (runtime-derived). The extract-stage
// response wrapper that carries {items:ExtractedItem[]} is separately
// named `ExtractionRecord` in §11.4 — the two names must not be
// conflated.
type ExtractedAtomicClaim = {
  extractionId: Id; claimId: Id; span: Span; quote: string;
  kind: 'fact' | 'source-report' | 'interpretation' | 'causal'
      | 'intent' | 'evaluation';
};
type AdjudicationRecord = {
  adjudicationId: Id; findingId: Id;
  decision: 'accept' | 'reject';
  reason: string; signer: 'user'; ts: string;
  dependencyDigest: Hash;
  overrides: { ruleId: string; targetId: Id; runId: Id };
};
type Assessment = {
  claimId: Id; supportGrade: 'A' | 'B' | 'C' | 'U';
  opposition: 'not-checked' | 'none-found' | 'material' | 'decisive';
  disposition: 'supported' | 'contested' | 'underdetermined' | 'refuted';
  reviewState: 'current' | 'stale' | 'not-run' | 'incomplete';
  reviewRunIds: Id[]; rationale: string[];
};
```

The review adapter MUST validate, per stage, the target set, the ruleId set, and the fields required for each target kind. (R1-03) There is a single rule for a missing required ruleId: adapter validation that finds a required ruleId missing or a set-schema mismatch produces `REVIEW_INVALID` — an error record that is not cached, is not counted as a semantic finding, and is retryable once. By contrast, when the model returns `result:'needs-review'` for a rule that *is* present, that check is recorded as `needs-review` inside a `completed` record. Referenced IDs, spans, and quotes MUST exist in the input; hallucinated evidence invalidates the response. Finding IDs are generated and substituted by the runtime. `rationale` retains only the review conclusion and its grounds, not the model's step-by-step internal reasoning.

`Support` describes "the relation of a passage to the claim", not the truth of the material itself. A memoir directly asserting event X only directly supports "the author claims X"; if the claim is "X actually happened", the review must additionally apply source and inference rules.


## 7. Grading, opposition, and propagation rules


### 7.1 Grade algorithm

Grades are support grades relative to the registered material and this rule set — not true probabilities, and no claim of a unified scholarly standard. The runtime executes the following algorithm; it MUST NOT accept model output of A/B/C/U directly:

0. **Definition of "path"** (R1-04): a *path* (support path) is a maximal support tree. An `all` group is one path; each member of an `any` group is one independent candidate path. A group cited by an Argument is an *input* to that argument's path, not a sibling path of it. Direct group paths and argument paths take the strongest grade at the conclusion claim.
   *Worked example:* with `G1 (all) [E1, E2] → C1` coexisting with `A1 (premise C0, group G2) → C1`, C1 has exactly two paths: the direct G1 path and the A1 path (G2 is an input to the A1 path and is not listed as a separate path).
1. A path with no current complete review, or all of whose paths are `irrelevant/unknown/contradicted`: U. 
2. Each direct EvidenceGroup path maps by its completed support review: robust→A, adequate→B, weak→C, none→U. direct/inferential may reach A/B; partial caps at C; irrelevant/unknown/contradicted are U.
3. Each Argument path's grade is the weakest of: the weakest required-premise grade, the weakest grade among its cited evidence groups, and the adequacy-mapped grade of the argument. Only inputs that exist participate in the min; a missing required premise is ruled a failure by ARG-01 and that path is U.
4. Among alternative paths, take the strongest path grade. Mutually reinforcing material MUST be placed explicitly in one `all` group or one new Argument for unified review; quantity alone MUST NOT raise a grade.
5. Causal, intent, interpretation, and evaluation claims without a current Argument through the corresponding scheme cap at C. The claim-kind→scheme mapping is:

   | Claim kind | Scheme |
   | --- | --- |
   | fact | deductive \| generalization |
   | source-report | deductive |
   | interpretation | interpretive |
   | causal | causal |
   | intent | interpretive |
   | evaluation | evaluative |
   

6. When a source's authenticity=questioned and SOURCE-02 has not passed, paths depending on that source cap at C. Paths over external facts that are agent-generated or acquisition=unverified cap at C and cannot be granted A/B. This cap does not prevent a source-report verifying that "this sentence does appear in the input text"; such a source-report MUST NOT be converted into an external fact without additional evidence.
7. Additional conditions for A: all applicable type rules pass; the relevant core opposition searches have actually been executed and reviewed in scope; there are no unresolved material/decisive Issues; and source limitations have been disclosed. If a condition is unmet but not failed, downgrade to B; if core type rules were not checked, cap at C.
8. A path with an invalidate Issue accepted by review is U; a downgrade Issue caps that path at C; qualify does not change the grade, but the corresponding qualification MUST appear in the body. Issues on the Claim itself apply to all of its paths.

**Rule-failure → grade consequence table** (R1-12; this table is part of the policy and enters `policyHash`):

| Rule failure | Consequence |
| --- | --- |
| EVID-01 (blocker) | the affected evidence is unusable → dependent paths U |
| SOURCE-01 / SOURCE-02 / SOURCE-03 fail | dependent paths cap at C |
| EVID-02 fail | that group's paths U |
| SUP-01 fail | that group's paths U |
| SUP-02 fail | that group's paths cap at C |
| ARG-01 fail | that argument's path U |
| ARG-02 fail | that argument's path caps at C |
| HIST-01 / CAUSE-01 / INTENT-01 / INTERP-01 / EVAL-01 fail | all paths of that claim cap at C |
| ISSUE-01 fail | the issue remains unresolved and applies per §7.2 |
| AUDIT-01..05 fail | audit-layer fail — does not alter already computed grades, but blocks `reviewed` |

Adapter validation MUST reject contradictory combinations: on the same target, `result:'fail'` together with adequacy `robust`/`adequate` → `REVIEW_INVALID`.

A base A may come from a single high-quality primary literary source directly supporting "this sentence does appear"; facts are not mechanically required to have two independent sources. Claims of "multiple sources mutually corroborating" MUST satisfy SOURCE-03. Taking the min across complex interpretive paths is a conservative engineering rule of this product, not a general epistemological law. 

### 7.2 Opposition status


Aggregation runs only over current complete issue reviews. issue resolution=accepted means the author's resolution response is accepted and the issue no longer counts as unresolved opposition; rejected/unresolved remain in force. Open issues MUST be reviewed and MUST NOT be ignored merely because they were not responded to.

Opposition is aggregated per claim over the required searches and the current complete issue reviews, as one fixed total order (R1-31): (1) a current decisive issue (an accepted invalidate) → `decisive`; (2) otherwise a current material issue (downgrade/qualify) → `material`; (3) otherwise any required search missing or not executed → `not-checked`; (4) otherwise → `none-found` derived from the executed set (it MUST carry the search scope and MUST NOT be presented as "no controversy").

Disposition rules execute in order:

1. decisive and support grade U → refuted (limited to the current material/rules; not shown as absolute falsification).
2. material/decisive and a usable support path exists → contested.
3. A/B and opposition not material/decisive → supported.
4. Otherwise → underdetermined.

A new Issue or new counter-evidence immediately marks the affected claim and downstream assessments stale, awaiting review, rather than directly re-grading by the author's proposed impact. 

## 8. Fixed review rule set `humanities-v1`


Applicability of each rule is decided by the runtime; the model MUST NOT declare an applicable rule inapplicable on its own. All rule severities follow the table below; the model MUST NOT lower them.

| ID | Applies to | Pass requirement | Failure level |
| --- | --- | --- | --- |
| SOURCE-01 | all cited sources | provenance, edition, transformations, and access limits suffice to identify it; unknown information is disclosed | major |
| SOURCE-02 | sources where authenticity or stance matters | distinguishes authenticity, author stance, and what the material merely asserts; "first-hand" is not substituted for a reliability judgment | major |
| SOURCE-03 | claims of multi-source corroboration | not same-source retelling; independence not claimed when it is unknown | major |
| EVID-01 | all evidence | quote exact, span legal, snapshot hash matches | blocker, deterministic |
| EVID-02 | evidence/group | context has not changed meaning; negation, paraphrase, irony, qualification, and speaker are handled | major |
| SUP-01 | group | actual support relation identified faithfully; the body does not dress relevant, unknown, or contrary material as support | major |
| SUP-02 | group | `all` jointly supports sufficiently; each `any` candidate recorded separately, irrelevant citations not hidden | major |
| ARG-01 | argument | required factual premises registered and supported; no circularity or equivocation | major |
| ARG-02 | argument | warrant supports the conclusion; the conclusion does not exceed the premises in scope/stance | major |
| HIST-01 | fact/source-report | "the material says X" and "X happened" are not conflated | major |
| CAUSE-01 | causal | sequence, mechanism, and alternative explanations all explicit; correlation not written as sufficient causation | major |
| INTENT-01 | intent | character, narrator, work meaning, and author intent distinguished; speculation made explicit when intent evidence is insufficient | major |
| INTERP-01 | interpretation | analytic scope explicit; contrary readings/competing interpretations actually checked or explicitly marked unchecked | major |
| EVAL-01 | evaluation | evaluationCriteria non-empty; arguments support the evaluation against explicit criteria | major |
| ISSUE-01 | each issue | the response actually addresses the attacked object, not merely restating the original conclusion | major |
| AUDIT-01 | body | checkable assertions, core interpretations, and direct quotes extracted and mapped | major |
| AUDIT-02 | body occurrences | body stance and scope not stronger than the Claim; citation locations correspond to actual assertions | major |
| AUDIT-03 | body | core issues/limitations/gaps disclosed in the body or immediately adjacent notes; the end report cannot substitute for required qualifications | major |
| AUDIT-04 | body | covers all requiredQuestions/expectedCoreTopics; explicit uncertainty allowed | major |
| AUDIT-05 | body core conclusions | at least one explanatory step given, or a statement that it is only direct fact; material dumps cannot substitute for an answer | major |

A group marked irrelevant/contradicted but still treated as support in the body MUST generate a SUP-01 finding. A fabricated direct quote is an EVID-01 blocker. Insufficient budget, inaccessible material, or a rule the model cannot judge MUST return `needs-review`; the model MUST NOT be forced into a binary guess. 

### 8.1 Distinguishing "Conclusion Undetermined" from "Review Incomplete"


Rules judge whether expression and argumentation are honest and limitations are fully disclosed; they do not require every research question to have a definite answer. The following are normative distinctions:

- Having actually examined the material, concluding "the available evidence is insufficient to determine X" may be rule=pass with claim grade=U; a gap and qualifying wording are required.
- If the reviewer did not examine the material or stopped due to budget, it MUST be rule=needs-review/not-run; a bare "uncertain" MUST NOT earn a pass.
- When counter-evidence genuinely exists but the author has presented it accurately, ISSUE-01 may pass while issueResolution=unresolved and disposition=contested. Only misrepresentation, evasion, or omission of counter-evidence yields a major.
- Causal/intent claims explicitly framed as hypotheses, with missing items registered as gaps and not disguised as established causation/intent, may pass their type rules — but cap at grade C; such hypotheses MUST NOT serve as unconditional factual premises.
- A missing required factual premise inside an argument while the conclusion is still accepted is an ARG-01 fail. When the author explicitly places the whole argument under conditional assumptions and shows this in the body, pass/weak is allowed, but the support grade is not upgraded.

issueImpact describes the opposition's effect on the original support path; issueResolution describes whether the author's response removed that effect. Unresolved does not automatically become a review error; the report and body MUST retain it. A claim's U/C does not automatically generate a finding; hiding its limitations or falsely claiming grounds does. 

### 8.2 Required rule applicability matrix


- Every Source used by the body or core arguments always runs SOURCE-01/02; when a claim has two or more sources, or the body contains corroboration phrasing, add SOURCE-03 for those sources.
- Every Evidence runs EVID-01; every EvidenceGroup runs EVID-02, SUP-01/02.
- Every Argument runs ARG-01/02; every Issue runs ISSUE-01, regardless of open/addressed/unresolved.
- All fact/source-report Claims run HIST-01, all causal run CAUSE-01, intent run INTENT-01, interpretation run INTERP-01, evaluation run EVAL-01 — not only core ones. Only evaluation may have non-empty evaluationCriteria; all other kinds MUST have an empty array. (R1-10) These type-rule and search checks are scheduled exactly once per applicable claim as claim-level tasks of the `claims` stage, independent of argument tasks; claim-level checks of an argument's conclusion claim are owned by the `claims` stage, and the `arguments` stage only evaluates ARG-*. 
- Every Artifact always runs AUDIT-01..05; AUDIT-01/02 run per extracted item, AUDIT-03..05 aggregate at the full-text level.
- Core counter-evidence search sufficiency is a required sub-check of the corresponding type rule; source-report uses HIST-01. Supporting non-core Claims are not forced to run a separate search, but if they enter the core inference dependency closure they inherit the core search requirement.

The applicability matrix and the ordering of the actually executed rule set both enter `policyHash`. A review response that reports an unknown rule is `REVIEW_INVALID`; one that omits a listed requiredRules entry is `REVIEW_INVALID` (R1-03, single semantics). A legal `needs-review` return is a complete response with an incomplete review. The model MUST NOT output `not-run` to dodge an assigned task: an assigned but unexecutable task uses `needs-review`; `not-run` is produced by the runtime for tasks never dispatched. 

## 9. Search and counterevidence contract

The system never claims on its own that "all the literature has been surveyed." Core causal/intent/interpretation/evaluation claims MUST have at least one executed SearchLog whose targetIds cover the claim, aimed at finding counterexamples or competing explanations. Core conclusions of historical fact must also record searches that check rival accounts or source reliability. Retrieval may be in-text lookup; network access is not mandatory.

When a tool execution record is verifiable, executionEventRef points to an actual search/read event in the current session, and the runtime validates that the event exists and that the tool name and timing match; the model MUST NOT fill in events that do not exist. When the user provides offline retrieval instructions, externalAttestation is used and the report is marked "externally claimed, not verified by the runtime." Such records may help review but do not satisfy the runtime-executed search condition for grade A.

Eligible capture events are fixed to the whitelist `web_fetch` and `read` (host FS reads). The byte source is the tool-result body — the full text of the `tool/result` message, **before truncation**; if the result carries a truncated marker, the result is `acquisition=unverified`.

A SearchLog being executed still does not mean retrieval was sufficient; review MUST check whether the query/corpus actually targeted real alternative explanations. Repeating the original conclusion as a search term while never looking for counterevidence is needs-review. The minimum behavior allowed by budget: one retrieval aimed at counterexamples/counterarguments, plus one check of the key original-text context; both may be completed within a single actual tool event. Query count is never used as a sufficient condition for sufficiency.

SearchLog execution validation: the record MUST reference an in-session `tool/call` seq plus a paired **successful** (non-error, not aborted-before-dispatch) `tool/result`; the recorded query/corpus MUST correspond to the fields in that call's `arguments` (per the tool-specific field mapping table below). Cross-session, aborted, or failed calls do not count.

Tool-specific query/corpus field mapping. The corpus entry is validated against the tool's `arguments` field (the URL or path actually requested); the paired result body is the capture byte source (R1-05), not a corpus validation input:

| tool | query field | corpus field (validated against `arguments`) |
| --- | --- | --- |
| `web_fetch` | `url` | `url` (the requested URL identifies the corpus) |
| `read` | `path` | `path` (the read file identifies the corpus) |



Closure rule: a SearchLog targeting any claim in the premise closure satisfies the core-search requirement for all claims in that closure (targetIds containing any member of the closure suffices).

Section rules: title = the first ATX-1 heading block; abstract = the section named matching `/^摘要|abstract$/i`; conclusion = the last ATX-2+ section matching `/结论|conclusion|结语/i`; additionally, `outline[].goal` sections answering requiredQuestions count.

failed/planned do not participate in the "counterevidence checked" computation. A none-found finding MUST NOT be used while state is not executed; resultSourceIds may be empty and still be none-found, but the report distinguishes its display scope from inaccessible.

## 10. Tool and command contract

### 10.1 Common Conventions

All tool inputs include projectId; write tools include expectedRevision and requestId (UUID). Newly created objects are referenced within the current transaction via clientKey, and an ID mapping is returned after commit. Editing on-disk JSON directly to bypass the service when writing review results is not allowed; on load the hash/schema are recomputed and files not committed through a legitimate HEAD are treated as corruption.

Success uniformly returns `{ok:true, projectId, revision, data}`; failure returns `{ok:false, code, message, retryable, details}` and is never thrown to the agent as an unhandled exception. Failures do not partially commit; model-call consumption is the exception — spent budget MUST be accounted for.

A repeated requestId with the same payloadHash returns the first result; the same ID with a different payload reports IDEMPOTENCY_CONFLICT. Records are retained for at least 30 days and MUST NOT be cleared at the end of the current session.

### 10.2 Commands

The `/vwa` command grammar is closed: `/vwa <init|status|import|sign|adjudicate|repair> …` — a closed subcommand enum with token splitting; extra arguments are a usage error. `/vwa repair <projectId>` handles STORE_CORRUPT recovery candidate selection. The command source is always `user`.

- `/vwa init <projectId?>`: without an ID, create a project; with an ID, only switch to an existing project. Creation reads the current user goal to generate a contract candidate and displays it; projectId is generated by the runtime. Initialization triggers no search or review.
- `/vwa status`: shows the current project, revision, artifact, review stage, pending/stale, and budget. It also shows the current value of the current-project pointer.
- `/vwa import <relativeDirectory>`: imports only a complete manifest and immutable revisions; rebinds the root, re-verifies all sources and the artifact, and keeps old reviews as history but marks them stale. It also rebinds the current-project pointer.
- `/vwa sign <artifactId> <receiptHash>`: accepts only a real user-command source; §18 defines signing. Ordinary assistant tools or injected messages cannot invoke it.
- `/vwa adjudicate`: human adjudication of findings (§18).
- `/vwa repair <projectId>`: STORE_CORRUPT recovery candidate selection.

**Current-project pointer.** The single storage location is `<workspaceRoot>/.dsh/vwa/current-project.json` with content `{schemaVersion:1, projectId, workspaceIdentity}`, written with CAS. `/vwa init <id>` writes it; resume reuses the project when it reads a valid value; `/vwa import` rebinds it. If it is missing or corrupt, turn-end runs lane-1 evaluation only (fail-soft, no error). For multiple sessions in the same workspace, the file is workspace-scoped and the last writer wins; `/vwa status` shows the current value.

### 10.3 `evidence.register`

Input body:

```ts
{
 projectId: Id; expectedRevision: number; requestId: string;
 path: string;
 metadata: Omit<Source, keyof Entity | 'snapshotPath' | 'snapshotHash'
                | 'acquisition'>;
 excerpts: { clientKey: string; span: Span; contextSpan?: Span;
             originalLocation: string;
             transformation: Evidence['transformation'];
             transformationNote: string }[];
}
```



path MUST be a realpath regular file inside root, at most 8 MiB; path escape, symlink escape, non-UTF-8, and binary are rejected. stat is taken before and after reading and the hash is re-read before commit; a mismatch reports INPUT_CHANGED. MUST generate an independent immutable snapshot and MUST NOT add frontmatter to or change line numbers of the original file.

The metadata fields snapshotPath/snapshotHash/acquisition are not accepted as input; authenticityBasisEvidenceIds must reference existing evidence. The tool schema allows omitting lineage/authenticity; the runtime, before schema validation, fills them with an explicit wrapper into `{relation:'unknown',parentSourceIds:[],note:'尚未核实来源关系'}` and `unverified`; the tool input type is accordingly an Omit with the corresponding fields optional, and the remaining metadata is required; Ajv implicit defaults are not enabled. The service deduplicates by full equality of hash plus completed metadata and returns the existing source; identical text with a different original location may register a distinct Source, but is automatically flagged as a suspected duplicate for SOURCE-03 review.

acquisition is derived by the runtime as a projection from trusted events: when an existing fetch/read tool (whitelist `web_fetch`/`read`) actually captured the text for that file and the hash can be verified, it is tool-event; when a user-attachment or explicitly user-specified input-file event can be verified, it is user-file; otherwise unverified. A file MUST NOT be marked as fetched merely because a URL is written inside it. When the host has no verifiable capture record, it MUST be unverified — never guessed. Research notes newly written by the agent may be registered, but must not be laundered into original external evidence via metadata.origin=external. unverified is insufficient to support A/B grades for external-world facts (that path caps at C); it can still directly support a source-report that "the currently provided text says this sentence," whose provenance limitation MUST be disclosed. user-file proves the input came from the user, not that a publication is genuine. The register deduplication comparison excludes the runtime capturedAt and compares only the capture kind/eventRef and author metadata.

Trusted read here means specifically reading existing user input or existing trusted capture artifacts; it does NOT include "the model writes a file and then calls read." The create/update chain MUST be traced: if the original text written by the agent cannot be matched byte-for-byte against an independent fetch response or user-attachment bytes, the effective origin is fixed as agent-generated and cannot be changed to external via metadata. Upgrade rule: after a fetch/read, if a same-session `write`/`edit` produces a file whose bytes are byte-identical to the captured body, that file source may be marked `tool-event`; otherwise unverified. There is no "match the original HTTP" comparison obligation. When a transformed snapshot cannot be matched byte-for-byte against the original response, acquisition=unverified until a replayable transformation record exists; v1 does not implement transformation proofs. This conservative restriction is displayed in the report rather than silently relaxing the A/B threshold.

excerpts may be empty; if non-empty, evidence is created in the same transaction, and the quote is read by the runtime from the span, never passed in by the model. Returns sourceId, the evidenceIds/clientKey mapping, the new revision, and snapshotPath/hash. Later changes to the original imported file do not alter the snapshot; a source update must register again, producing a new Source, with references updated by the graph.

### 10.4 `evidence.search_log`

Input is the common write fields plus `entries: Omit<SearchLog,keyof Entity>[]`, 1–50 entries. After validating the §9 rules, it commits atomically. Returns search IDs. This tool does not perform searches; it only records and verifies already-executed events; planned MUST NOT be auto-promoted to executed.

### 10.5 `argument.update`

Input: the common write fields plus one of the following discriminated unions:

```ts
type Mutation =
 | { op:'set-contract'; contract:ProjectContract }
 | { op:'upsert'; creates:CreateEntity[]; updates:UpdateEntity[];
     deletes:Id[] }
 | { op:'bind-artifact'; artifactId?:Id; path:string;
     occurrences:Occurrence[]; outline:Artifact['outline'] };
// CreateEntity = {clientKey, type, body}; type is limited to
// claim/group/argument/issue; body is the corresponding §5 object minus Entity.
// UpdateEntity = {id, expectedEntityVersion, body}; likewise; full body replacement.
// References to new objects within a transaction use {$new:clientKey},
// allowed only in ID fields.
```



upsert MUST NOT create Source/Evidence/SearchLog/Artifact/review results. deletes do not cascade; if other objects or artifact occurrences still reference the entity, REFERENCE_IN_USE is reported. Removing all references and then deleting in the same transaction is allowed. Source material is retained as historical evidence; no hard-delete tool is provided; references may simply be dropped.

bind-artifact reads the artifact, computes contentHash, validates occurrences, and creates or updates the Artifact. Only one artifactId may be bound to the same path project-wide; the path is restricted to `.md/.mdx`, excluding `.dsh/vwa/**` and the snapshot/report output directories, so reports or evidence are never mistaken for the artifact. The artifact may be written via the shell, but once bound it enters the explicit artifact registry; turn-end no longer relies solely on editing-tool events for discovery.

Every write performs full-graph reference/type/cycle/quota validation on completion. Commit only if everything succeeds. Returns the changed entity IDs, the new revision, and affectedClaimIds.

### 10.6 `argument.review`

Input `{projectId, expectedRevision, requestId, artifactId?, targetClaimIds:Id[], stage:'sources'|'support'|'claims'|'arguments'|'audit'|'all'}`. Empty targetClaimIds means all claims involved in the project's currently bound artifact; if no artifact is provided and the list is empty, all project claims.

sources/support/arguments are expanded along dependency closures. audit and all MUST specify artifactId. all executes sources→support→claims→arguments→audit in order; if any stage is incomplete, completed records are retained and `completion:'incomplete'` is returned — downstream passes are never fabricated. Returns run IDs, current assessments, findings, check coverage, and actual budget consumption. A retry with the same requestId does not call the model again; continuing requires a new requestId.

The effective core set is frozen at review-plan creation (§12.1); no online reclassification. Review MUST NOT modify the artifact or the author graph. It may produce "pending-adopt claim/issue proposals," returned to the agent and accepted via argument.update before re-review; model proposals are never automatically mixed into the author's original graph.

### 10.7 `argument.report`

Input `{projectId, artifactId, format:'markdown'|'json', write:boolean}`. The read-only report consumes no model budget. write=true uses a deterministic renderer to write `docs/vwa-reports/<projectId>/<artifactId>.review.md` or the same-named `.json`; this is a derived output and is never treated as the artifact. Returns the path, reportHash, bindingDigest, and deliveryState. File content MUST be consistent with the current HEAD and the review records; the model MUST NOT be allowed to polish the file and still claim the same hash.

### 10.8 Stable Error Codes

| code | meaning | retryable |
| --- | --- | --- |
| SCHEMA_INVALID | field/range/type violates the contract | false |
| REVISION_CONFLICT | expectedRevision is not HEAD | true, re-read and redo |
| ENTITY_VERSION_CONFLICT | object version mismatch | true |
| REFERENCE_INVALID / REFERENCE_IN_USE | dangling reference, type mismatch, or still referenced | false |
| SUPPORT_CYCLE | support-graph cycle | false |
| PATH_OUT_OF_BOUNDS / INVALID_ENCODING | path or encoding violation | false |
| INPUT_CHANGED | file changed during read | true |
| CONTEXT_TOO_LARGE / LIMIT_EXCEEDED | fixed boundary exceeded | false |
| STORE_CORRUPT / STORE_IO_FAILED | storage corrupt or write failed | true, only after repair |
| LOCK_BUSY | project concurrent write lock held | true |
| IDEMPOTENCY_CONFLICT | requestId used with a different payload | false |
| REVIEW_UNAVAILABLE / REVIEW_INVALID | model unavailable or response invalid | true |
| BUDGET_EXHAUSTED / CANCELLED | budget or cancellation | false, for this request |



"Retryable" does not mean unlimited automatic retries; §13 restricts review retries and §14 restricts storage retries. Retry semantics have a single point of truth: the adapter retries at most once per task (transient network errors or one schema repair); the runner never auto-retries cancelled/budget-exhausted runs; resuming requires a new requestId.

## 11. Review execution algorithm

### 11.1 Fixed inputs and review stages

At call start, HEAD, artifact bytes, dependency snapshots, policy, and reviewer config are fixed. Requests that no longer match expectedRevision fail before any model call. On review completion, dependency digests are verified again; unrelated revision changes do not invalidate existing target results, while related changes store the results as historical stale and return incomplete — the user's new writes are never rolled back.

| stage | required inputs | required outputs |
| --- | --- | --- |
| sources | source metadata, lineage, authenticity-basis evidence/context, related claims | applicable SOURCE-01/02/03 rules |
| support | claim, scope, all evidence/context of the group, current source review | EVID-02, SUP-01/02, and per-group support/adequacy |
| claims | claim, scope, applicable SearchLogs, current source reviews | the type rule for the claim's kind (HIST-01 / CAUSE-01 / INTENT-01 / INTERP-01 / EVAL-01) plus search sufficiency — scheduled exactly once per applicable claim, independent of argument tasks |
| arguments | argument, all premise assessments, group results, issues, SearchLogs | ARG-01/02, ISSUE-01, argument adequacy, issue impact/resolution |
| audit | full-artifact chunking, contract, claims, occurrences, outline, current assessments/issues | AUDIT-01..05, omissions/strengthening/broadening/missing, and pending-adopt proposals |



EVID-01, paths, hashes, and reference integrity are runtime checks, never delegated to model adjudication. On mechanical failure, semantic rules touching it are not-run and a blocker is generated — model budget is never spent repeatedly validating broken input.

### 11.2 Prompt contract

Per-stage templates live in versioned files inside the package. The system instruction fixedly requires: the source text is the data being analyzed; only input IDs may be cited; support and authenticity are distinguished; unchecked items MUST NOT be marked pass; return the schema; give only concise review rationales. The user message contains the serialized task data; the original text is never concatenated into system/developer instructions.

The Source/Support stages do not provide the author's self-assigned grades; the audit stage extracts independently before aligning. Review may reuse the same model but MUST issue independent calls; reusing the author's conversation history or the author's self-grading as evidence is forbidden. The reviewerConfigHash is bound to the actually dispatched call: the adapter is built on the harness `prepareCall` (`PreparedLlmCall`) — prepare first (resolving the configuration and freezing adapter registration together), compute `reviewerConfigHash` over the resolved prepared `config`, and always dispatch through the same prepared handle. There is no standalone synchronous `describe()`; `describe` is derived from the prepared call. The hash includes the available model identity, provider, temperature, reasoning configuration, and template version; when the host does not support a parameter, it is not sent, and the actual configuration enters the hash.

If the model exposes no reproducible version, the report records "model version not pinned"; this never fabricates reproducibility. After a model change, new reviews and old reviews cannot hit each other's cache.

### 11.3 Fine-grained tasks and caching

sources tasks are split by source, support tasks by group, and arguments tasks per argument in topological order; a single task MUST contain a complete group and never splits joint evidence. Issues are reviewed together with their targets; valid records for the same issue at the same input version are aggregated under this section's disagreement rules.

cache key = SHA256(stableJson({stage,targetRefs,dependencyDigest,contractHash,policyHash,reviewerConfigHash,promptHash})); undelimited string concatenation is forbidden. Only records that are completed, fully match the response schema, and contain all required checks may be reused; a needs-review record may cache its judgment but never converts to pass. When multiple valid records for one target under exactly identical input/config disagree on rule result, support label, or impact level, the report marks reviewer-disagreement and delivery is at least needs-review; differences in explanation wording alone are not disagreement. A latest pass MUST NOT silently overwrite a fail. Different results after the input was revised are not reviewer-disagreement. Explicit re-review MUST pass a new requestId; old conclusions are retained. Human adjudication is in §18.

### 11.4 Input and output field closure

Each stage MUST serialize the following envelope, never leaving missing fields for the model to fill in: `{stage,runId,taskId,rubricVersion,requiredRules:[{targetId,ruleId}],contract,targets,dependencies,budget:{maxOutputTokens}}`. dependencies contains the actual quoted text/context, current valid reviews, and reference metadata; handing over only file names without reading the content is not allowed.

- The sources target is a Source and MUST output the applicable SOURCE rules; support/adequacy and similar fields MUST NOT appear.
- The support target is an EvidenceGroup; support, adequacy, and evidenceRelations are required, and evidenceRelations MUST cover exactly that group's evidenceIds. For any groups, group support strength takes the strongest single item, and a finding is still required for wrong citations; for all groups, the overall support relation is decided by joint review and is never mechanically replaced by the weakest single item.
- The arguments target is an Argument or an Issue. An Argument MUST have adequacy; an Issue MUST have issueImpact/issueResolution and MUST NOT output adequacy. A core Claim without an argument still serves as a type-rule target: the corresponding HIST/CAUSE/INTENT/INTERP/EVAL rules and search sufficiency MUST be evaluated; complex claims without a reasoning basis are subject to the §7 grade cap.
- audit's extract/align use the §12 schema and this section's ReviewResponse respectively; extract does not return a ReviewResponse. align returns `alignment:[{extractedId,claimIds,relation,rationale}]` in addition to findings, with each extracted item appearing exactly once. extractedId is generated by the runtime from taskId, span, and atomic sequence number. The audit variant of the schema MUST include alignment; other stages MUST NOT include that field.
- Finding.code may only take a §8 rule ID or `AUDIT_NEW_CLAIM / AUDIT_STRONGER / AUDIT_BROADER / REVIEWER_DISAGREEMENT`. The latter three AUDIT codes are fixed major, mapped to AUDIT-01/02/02 respectively; reviewer-disagreement findings carry severity `major` for display but are categorized `kind:'disagreement'` and are excluded from the major→fail counting in §17.2 — they aggregate to needs-review, never to fail. Runtime errors are ReviewRecord.errorCode and are never fabricated into semantic findings.
- evidenceRelations=unknown or an applicable rule of needs-review leaves the corresponding path's review incomplete; being explicitly judged irrelevant/contradicted is a completed negative judgment, not a missing review.
- A reviewer's invalidate judgment on counterevidence MUST cite evidence; inference-gap may cite the reviewed argument itself together with an explicit reasoning contradiction, without requiring external material. Objections with no location and no rationale MUST NOT be treated as decisive counterevidence.

This section's conditional fields are defined through the JSON Schema's discriminated unions; the §6 base types are their common fields, and implementations MUST NOT degrade this into a lax "all fields optional" schema.

extract's response is stored independently as an `ExtractionRecord` with the same system fields as ReviewRecord, stage fixed to `extract`, and response changed to `{items:ExtractedItem[]}`. `ExtractedItem={span,exactText,atomicClaims:[{text,kind,scope,importance}],isQuotation}`; extractedId and atomic sequence numbers are derived by the runtime. reviewRunIds include the runs of both extract/align; with either stage unfinished, audit cannot count as pass. align's relation may only be exact/equivalent/stronger/broader/new; for new, claimIds MUST be empty, and for the others they MUST be non-empty and valid.

policyHash covers the schema version, the rule applicability matrix, the grade mapping, importance/aggregation/delivery predicates, limit semantics, and all per-stage prompt hashes; merely raising the available budget does not expire completed judgments, but changing the review ruleset MUST expire them. dependencyDigest is a stableJson hash over ID-sorted targets and their recursive dependencies `{id,entityVersion,contentHash}`, the used upstream review recordHashes, and the artifact hash (audit only). A Source/Claim's authenticity or rebuttal references are used only as review input and do not recursively participate in support-strength computation, preventing rebuttal cycles from making the algorithm non-terminating.

## 12. Full-text reverse extraction and alignment

The author-filled occurrences MUST NOT be treated as the full extraction set. audit runs as two independent call stages:

1. **Extract**: given only the artifact, the contract, and chunking context — never the author's claims/grades; extraction covers checkable facts, source statements, causality, intent, core interpretation/evaluation, and direct quotations. Pure transition sentences, questions, and explicitly fictional narration are not treated as facts, but non-fiction provenance statements are still checked.
2. **Align**: given the extraction results, the author graph, and occurrences; mark exact/equivalent/stronger/broader/new. Only exact/equivalent counts as aligned; the rest generate findings and never automatically overwrite author claims.

The extraction unit is the root-level child of a CommonMark parse of the artifact (parser AST children, per §4). If the artifact exceeds `review-max-artifact-chars`, full audit is rejected (incomplete); the artifact MUST NOT be truncated and then claimed as fully checked. A single over-long block is split at sentence boundaries; if none is found, hard-split, keeping 512 characters of context before and after. Context is not part of the block's extraction target, and returned spans MUST fall entirely within the target block; a cross-block claim is owned by the block where its first starting character lies, and neighboring blocks may provide context. Returned spans at a target's end may extend into the following context, and the runtime deduplicates by span/text; this exception applies only to boundary-crossing sentences.

Extraction result `{span,exactText,atomicClaims:[{text,kind,scope,importance}],isQuotation}`; span exact-match is verified by the runtime. Semantic equivalence is judged by the review model and its rationale retained. Every extracted atomic claim MUST map to one or more existing claims; the same claim may map to multiple artifact locations. Discovered omissions return only proposals; after the agent accepts and updates the graph, the new graph and the affected passages MUST be re-reviewed.

When the artifact is unchanged and the dependency graph is unchanged, the complete audit is reused. When the artifact changes, v1 re-extracts the entire text without attempting semantic diff to skip passages; later optimizations MUST NOT change this coverage contract.

### 12.1 Coreness and anti-cheating

The effective core set is frozen at review-plan creation: core = author-marked core ∪ plan-time extraction findings ∪ all atomic claims located in the title/abstract/conclusion sections ∪ claims elsewhere that answer requiredQuestions. The section rules are those of §9: title = first ATX-1 heading block; abstract = the section named matching `/^摘要|abstract$/i`; conclusion = the last ATX-2+ section matching `/结论|conclusion|结语/i`; additionally, `outline[].goal` sections answering requiredQuestions count. Model disagreement defaults to core; strict checks MUST NOT be bypassed by lowering importance. There MUST be at least one core, and all requiredQuestions MUST have a response mapping; otherwise AUDIT-04 fails. If audit execution discovers a new core claim, that run is marked needs-review and a new run is required (terminating monotonicity); online reclassification is not allowed.

Deleting a difficult conclusion can be a legitimate revision, but if it leaves a contract topic missing, it cannot pass. Changing the conclusion to "current evidence cannot determine this" can pass, provided its gap explanation, the retrieval scope actually searched, and the unchecked items are genuinely visible.

## 13. Budget, cancellation, and retry

Default configuration, all registered in the `vwa-argument` namespace and read via settings (flat kebab keys):

| setting | default | range/meaning |
| --- | --- | --- |
| semantic-enabled | false | mounted only in the VWA preset; explicitly enables lane 2 |
| semantic-mode | draft | draft / reviewed; the effective value is fixed in the project contract |
| review-max-calls-per-run | 40 | 1–200, including failed and repair calls |
| review-max-input-tokens-per-run | 160000 | 1000–1000000 |
| review-max-output-tokens-per-run | 24000 | 1000–200000 |
| review-max-output-tokens-per-call | 3000 | 256–16000 |
| review-max-wall-ms | 180000 | 1000–900000; async task, non-blocking turn |
| review-call-timeout-ms | 45000 | 1000–120000 |
| review-concurrency | 2 | 1–4, only mutually independent tasks concurrently |
| review-max-artifact-chars | 120000 | full audit rejected when the artifact exceeds this |
| review-max-context-chars-per-task | 48000 | needs-review when exceeded; evidence is never truncated |
| project-max-entities | 10000 | total across all author entities |
| repair-max-rounds-per-artifact-turn | 1 | fixed cap; reuses the existing session nudge budget |



All budget values are overridable via settings. At project creation, the then-current values are frozen into the project contract (as one input to reviewerConfigHash); later settings changes do not affect the frozen runs of already-created projects. Precedence for `semantic-mode`: the project contract's mode is the per-project override, seeded from settings defaults at init — later settings changes do not affect existing projects; `semantic-enabled` is always read from settings (the global gate).

Structured output: review calls always use the forced-tool-call form — a single tool named `respond` whose `parameters` JSON Schema is the response schema, with no other tools attached; the response is validated client-side with Ajv, and on failure one repair retry within budget; a further failure is REVIEW_INVALID.

Before each model call, input is estimated via the host tokenizer or host counting interface: when the host token-meter heuristic (chars/4) is available it is labeled `method:'tokenizer'`; otherwise the UTF-8 byte count is used, labeled `method:'bytes-upper-bound'`. This call's output cap is reserved; if the total budget would be exceeded, the call is not sent. When actual usage is available, actual values are used; otherwise the full reserved value is charged. Retries also consume budget. DeepSeek `max_tokens` counts as a forced output cap; if the provider cannot force an output cap, the call cannot be enabled and REVIEW_UNAVAILABLE is returned.

Each model task is retried at most once, only for transient network errors or one schema repair; a normal fail judgment is never retried to turn it into a pass. Timeout/cancellation/budget exhaustion leaves the corresponding record incomplete; completed tasks may be saved and reused. The runner never auto-retries cancelled/budget-exhausted runs; resuming requires a new requestId.

Review runs as a host background job registered via the jobs adapter: `start→jobs.start(kind:'vwa-review', label=runId)`, `cancel→kill`, `get→get`, `emitProgress→updateProgress` plus a cordis event; when the per-owner cap (10) overflows, REVIEW_UNAVAILABLE is returned. The call returns runId/taskId immediately; results are later queried via host task progress or `argument.review` with the same requestId; calling with a running requestId returns `{completion:'running',taskId}`. Stage completion, budget stop, and cancellation all emit progress events. The turn MUST NOT synchronously block for up to 3 minutes waiting; turn-end only shows pending for a running review.
## 14. Storage, atomicity, and recovery

### 14.1 Layout

```text
.dsh/vwa/<projectId>/
  HEAD.json
  revisions/<revision>-<graphHash>.json
  review-runs/<runId>/request.json
  review-runs/<runId>/records/<taskId>.json
  review-runs/<runId>/usage.jsonl
  operations/<requestId>.json
  signatures/<signatureId>.json
  locks/write.lock
  workspace.json
docs/vwa-sources/<projectId>/<sourceId>.md
docs/vwa-reports/<projectId>/<artifactId>.review.md
```

Source snapshots `.md` are exact copied text bytes (the input may be `.txt`; the `.md` output does not imply semantic transcoding) with no headings added. The registry lives under `.dsh` so it is not mistaken for citable external fact; whether the snapshot directory is committed to version control or ignored is decided by the user's project — this feature MUST NOT auto-upload sources or commit git.

HEAD = `{schemaVersion:1,projectId,revision,graphHash,revisionPath,operationId}`. graphHash is computed over the full ProjectSnapshot stableJson and excludes review-derived results. Review input dependency digests are computed over the relevant entities' content, so unrelated revisions do not invalidate all reviews.

`workspace.json` under `.dsh/vwa/<projectId>/` stores the workspaceIdentity nonce (generated at init, rebound at import). 

### 14.2 Commit protocol

Single writer per project; the lock is an exclusive create recording `{pid, startedAt, nonce}` (a random process-start nonce stands in for a bootId, since no host bootId API exists). Wait at most 2 seconds, then LOCK_BUSY; reclaim only after the lock-holding process is confirmed dead — never by lock timeout alone. 

Transaction order: read and verify HEAD → expectedRevision/CAS → apply and verify the full transaction in memory → write temporary source snapshots (if any) → fsync → rename final immutable sources → write immutable revision temp file, fsync, rename → write operation result temp file, fsync, rename → atomically replace HEAD, fsync parent directory → read-back HEAD/revision hash → return success. 

An operation result that exists before HEAD update is marked prepared; it counts as committed only if HEAD points at that operation or the historical revision chain contains it. A revision additionally wraps parentGraphHash and operationId; the wrapping envelope does not participate in the ProjectSnapshot graphHash. Recovery relies on chain verification. The implementation MUST persist that chain, not just the latest HEAD.

Orphaned snapshots/revisions after a crash are uncommitted files and are excluded from the project; the next lock-holding recovery cleans unreferenced temp files older than 24 hours, and never auto-deletes committed history. When HEAD is invalid, the store MUST NOT silently adopt the newest file; it MUST return STORE_CORRUPT with verifiable recovery candidates, from which the explicit `/vwa repair <projectId>` command chooses.

Invalid schema, hash mismatch, or externally modified review records MUST NOT enter current. The hash chain is for integrity and error detection; it does not claim to prevent a malicious user with workspace write access from forging the whole project.

### 14.3 Review concurrency and read-back

Author write transactions and review result writes are serialized separately; review results do not increment the author graph revision. Each review task holds immutable inputs and, on completion, writes a temp file + fsync + rename, then read-back verifies the record hash.  The usage ledger is append-only; after writing, verify the record ID — do not merely compare artifactHash, which would mistake a same-content duplicate write for this write's success.

Run (job-level) status moves queued→running→completed/incomplete/cancelled/budget-exhausted, matching `ReviewJobStatus`; the record-level `ReviewRecord.status` stays its own set (completed/error/cancelled/budget-exhausted) and the two levels are never conflated. After a process restart, running always becomes incomplete; completed records are retained, and in-flight budgets are charged with the full reserved usage to avoid a reset on restart. Continuing a task requires a new requestId. 

## 15. Dependency invalidation and incremental rules

Build reverse indexes: source→evidence→group→claim; premise claim→argument→conclusion claim; issue→target/downstream; claim→artifact occurrences/outline. 

| Change | Must invalidate |
| --- | --- |
| source bytes/hash or metadata, lineage | that source's source/support reviews and all downstream |
| evidence quote/context/location/transformation | related support and downstream |
| claim text/kind/scope/stance/criteria | that claim's support and argument, downstream, and body alignment |
| importance | core coverage, search requirements, body review, delivery decision |
| argument warrant/inputs/assumptions/limitations | that argument, its conclusion, and downstream |
| issue or search log | the corresponding target's contested/sufficiency review and downstream |
| artifact bytes/occurrences/outline | that artifact's audit, report, receipt, and signature |
| contract/policy/reviewer config | all project semantic reviews |

Source snapshots must not change; if a file is externally modified, the mechanical check fails — not merely stale. Fetching new content at the same original URL never silently overwrites an old snapshot. Old references can still reproduce old material, but the report MUST disclose the snapshot time used; this version does not auto-refresh external web pages.

Stale never deletes old results; reports may show history, but it MUST NOT enter the current denominator or pass decisions. Before computing current, re-verify the body and the snapshot hashes used each time — never trust an in-memory cache alone. 

## 16. v2 receipt and turn-end integration

### 16.1 v2 structure

v2 keeps v1's semantics for ts/sessionId/artifactId/artifactPath/artifactHash/numbers/gates/nudge and provenance, but v2's claims become multi-source; do not smuggle new fields into v1's claims and still call it v1. 

```ts
type ReceiptV2 = {
 v:2; receiptId:Id; ts:number; sessionId:string;
 projectId:Id; projectRevision:number;
 artifactId:Id; artifactPath:string; artifactHash:Hash;
 graphHash:Hash; policyHash:Hash; reviewerConfigHash:Hash;
 claims:{claimId:Id; spans:Span[];
         sources:{sourceId:Id; snapshotHash:Hash; evidenceIds:Id[]}[];
         assessment:Assessment}[];
 numbers:NumberEntry[]; gates:GateEntry[];
 checks:{mechanical:MechanicalStatus; evidence:Verdict; argument:Verdict; audit:Verdict};
 metrics:{mappedAtomicClaims:number; extractedAtomicClaims:number;
          reviewedCoreClaims:number; coreClaims:number};
 reviewRunIds:Id[];
 pendingRunIds?:Id[]; // present when review runs are queued/running
 findingCounts:{blocker:number;major:number;minor:number};
 report:{path:string;hash:Hash};
 provenance:{inputs:{sourceId:Id;revisionHash:Hash}[];parentHash:Hash|string};
 delivery:'draft'|'reviewed'|'delivered-unverified'|'delivered-reviewed';
 overall:'pass'|'fail'|'abstained';
 nudge:{round:number};
};
```

`NumberEntry`/`GateEntry` are the exact existing exported types from `@dsh-cc/vwa-evidence`; no drifted Legacy-prefixed duplicates are defined.  v2 MUST NOT treat a numeric placeholder as a computed verified value; the report keeps its "lane 3 not run" note.

receiptHash=SHA256(stableJson(row)) and is not written into the row itself. provenance.parentHash points to the receiptHash of the previous successfully read-back receipt; the first is `''`. provenance.inputs is the deduplicated, sorted list of all sources actually used for this artifact; recording only each claim's first source is not enough. 

Read-back verification MUST compare both receiptId and the full receiptHash; a write failure MUST NOT be presented as if the receipt exists. The new v2 read-back does not alter historical v1 bytes.

v2 rows are written to the same session JSONL ledger, `<dshHome>/vwa-receipts/<encodeSegment(sessionId)>.jsonl`, as a discriminated union typed by the `v` field (v1=`1`, v2=`2`). All v1 read points in `vwa-evidence` (`staleAgainst`, `nudgeBudgetConsumed`, the evaluator's `readJsonl` consumption) MUST filter `row.v===1` before casting; v1 readers skip v2 rows (not counted in the v1 semantic faces of budget/staleness), while `nudgeBudgetConsumed` counts `nudge.round` from both versions.  The v1 last-line `artifactHash` read-back path stays as-is.

### 16.1a Avoiding the report / receipt circular dependency

The report's bindingDigest = SHA256(stableJson({artifactHash,graphHash,dependencyDigest,policyHash,reviewerConfigHash,reviewRecordHashes,activeAdjudicationHashes})); active adjudications enter all downstream caches, reports, and receipt validation. The report contains no receiptHash of the current run, no receipt read-back result, and no later delivery/signature state; it may only say "the following are the current check results; receipt status is provided by the delivery summary". So the report is written first, then reportHash is written into the receipt — no hash self-reference. 

"Delivery status in the report" in this document means the candidate status computed from content checks; the formal delivery summary is a separate runtime message carrying receiptHash, read-back result, and signature status. The report renderer does not call the receipt writer. Section 17's final sealing of reviewed requires a successful read-back, but delivery=reviewed inside the receipt is a candidate status pending read-back; only after the write succeeds does the runtime announce formal reviewed externally.

A receipt is an immutable event snapshot and is never rewritten for delivery. A delivery event writes a separate event record referencing the receiptHash; if delivered status must also be wrapped as a receipt, a new receipt row must be appended (with a new receiptId and parentHash) reusing the same reportHash. A signature binds only an existing receipt and never writes back to the report, which would change its hash again. 

### 16.2 turn-end order

1. Reuse the existing genuine-user/turn guard; a cancelled turn writes no success receipt.
2. Collect editing-tool paths ∪ currently project-bound artifacts ∪ last pending; dedupe by realpath.
3. Body with semantic-enabled=false or no bound lane 2 goes through the original v1.
4. Lane 2 body checks current hash, snapshot, graph, review caches, report; record gaps as stale/pending. 
5. No heavy model calls are made here; when review is needed the nudge gives exact targets and a suggested tool request.
6. Compute checks and delivery status per section 17; after deterministic report generation, write the v2 receipt and read it back.
7. Only if budget allows and fixable problems remain, synchronously inject one fix nudge. One nudge may carry multiple findings, ordered blocker→major→minor, capped at 10, remainder pointed to the report. 
8. The agent may run argument.review and stop again; the receipt updates. When budget is insufficient or checks still fail, deliver an explicitly unverified state; score-farming loops are forbidden. 

Semantic fixes share the existing vwa-evidence nudge budget of ≤1 per artifact per turn, ≤2 per turn, and 4 per session by default — two packages must not each consume 4. The nudge marker is still written to the receipt only by the single evaluator; a review task never injects a fix message itself. 

The trigger predicate is a closed boolean: a bound artifact nudge fires when (mechanical fail) ∪ (semantic overall fail ∪ active blocker/major finding not of kind disagreement) ∪ (stale/pending critical dependency) — any true. The coverage<threshold clause applies only to unbound lane-1 artifacts; for a bound lane-2 artifact whose review has never run or is pending, the row is `overall:abstained` with `pendingRunIds` and no nudge fires. Injection stays at the single vwa-evidence evaluator point (source kind remains `vwa-evidence`; the message template shows targets plus a suggested `argument.review` payload). When review has never run or is pending, the receipt row gets `overall:abstained` plus `pendingRunIds`, with no nudge in draft mode and unmet items shown in reviewed mode. `EvaluatorState` is not a public API; the integration contract is the §16.2 step table. 

## 17. Check aggregation and delivery predicates

### 17.1 Check aggregation

Each check layer first looks for fail; otherwise any needs-review/stale/error/pending yields needs-review; otherwise a missing required check yields not-run; otherwise pass. A rule that does not apply is removed from the required set by the runtime — never a fake pass.

reviewer-disagreement is aggregated separately as needs-review rather than a determined fail; it still blocks reviewed. A reviewed claim at grade U is not an unfinished review. If a layer's applicable set is genuinely empty, it aggregates to pass only after upstream type/scope review confirms "not applicable", with checked=0/applicable=0 attached; a pass MUST NOT result merely from extraction missing the set. 

The mechanical layer consists of path/hash/quote/schema/reference integrity plus documentation-applicable gates. Lane 2 does not require a humanities article to contain executable code: an exec gate with no executable fence is judged inapplicable by the runtime; an unloaded style ruleset is not-run and disclosed, and by default does not block semantic reviewed. The link gate and all used exec gates are required gates — missing/abstained MUST NOT count as pass.  `GateEntry` bytes are unchanged; inside v2 `checks.mechanical` this is a pure mapping: style abstained with no ruleset → `not-run`; exec with no code fence → `inapplicable`. 

The evidence layer covers Source/Group current checks; the argument layer covers applicable arguments, type rules, and issues; the audit layer covers full-text extraction and AUDIT rules. 

### 17.2 reviewed hard conditions

reviewed requires ALL of:

- Body, graph, sources, policy, reviewer, and report are all current, and the receipt read-back succeeded.
- All four checks layers are pass; no required rule was skipped.
- blocker=0 and major=0, counting only findings not categorized `kind:'disagreement'` (disagreement findings aggregate to needs-review per §11.3); minor may exist but must be disclosed.
- extractedAtomicClaims > 0; mappedAtomicClaims/extractedAtomicClaims = 1.
- coreClaims > 0; reviewedCoreClaims/coreClaims = 1.
- Every body assertion has a current claim assessment; asserted claims of external fact grade at least B; C/U may appear only as clearly qualified hypotheses, paraphrases, undetermined conclusions, or views discussed but not adopted.
- Core claims all have an explicit support path or an explicit "cannot determine" gap explanation, and all requiredQuestions are answered.
- contested does not block passing, but important counter-evidence, competing explanations, and necessary qualifications are disclosed in the relevant body. refuted may never serve as an asserted conclusion the author adopts.

"100%" refers only to the set the current extractor identifies and does not claim coverage of all real claims. The report MUST show both the human-calibrated extraction recall and the labeled-set version; until calibration completes, reviewed stays flagged experimental and never shows "guaranteed hallucination-free". 

overall: any fail, or any blocker/major finding not categorized `kind:'disagreement'` → fail; no failure but the conditions above unmet → abstained; all machine predicates satisfied → pass. If the receipt read-back fails there is no reliable overall for this run; the UI shows write failure. 

### 17.3 Delivery status

draft is the working state below the reviewed conditions; reviewed is the state where the machine predicates are met but delivery has not occurred. Once the user actually receives the body and report paths/hashes and the runtime records the corresponding delivery event, they become delivered-reviewed or delivered-unverified. Delivery MUST NOT be recorded because the assistant said "sent to the user". 

The only accepted delivery event is the host `deliverables/presented` event (produced by the model `present` tool), and the paths must include both artifact and report with hashes matching the current binding. Otherwise the state stays reviewed/draft with "delivery unconfirmed" in the report.  Events are never fabricated to complete the state machine. Body/dependency changes return the current state to draft; historical delivery records are retained.

mode=draft may deliver delivered-unverified but must show the unmet items; mode=reviewed also does not block the user from obtaining files indefinitely — when budget is exhausted an unverified draft may be provided, explicitly marked as having missed its target. mode never changes the grading algorithm or review honesty. 

## 18. Human adjudication and signature

Human signature is the upper-layer status for lane 2, orthogonal to machine reviewed, and is not part of model tool permissions. 

`/vwa sign <artifactId> <receiptHash>` verifies that receipt/artifact/graph/source/policy are currently consistent and generates the Signature `{signatureId,artifactId,artifactHash,graphHash,receiptHash,policyHash,signer:'user',ts}`. If the machine checks did not pass, the signature only means "the user reviewed the version with known gaps"; it does not change checks, grades, or overall. The message MUST show this. 

The human adjudication command `/vwa adjudicate <findingId> accept|reject <reason>` requires a real user source and a non-empty reason; it applies only to semantic findings and cannot override deterministic failures such as path, hash, or quote mismatch. It generates a separate adjudication record and never rewrites the model's original review. An AdjudicationRecord `{adjudicationId, findingId, decision:'accept'|'reject', reason, signer:'user', ts, dependencyDigest, overrides:{ruleId, targetId, runId}}` is scoped to a single finding; other findings for the same rule are unaffected. reject removes that finding from the active set and marks the rule `pass (human-adjudicated)` — a display state only; the `Verdict` enum is neither changed nor widened, and grades are fully recomputed by policy — while keeping the original finding. accept means the finding stays active and still needs fixing; it is not ignore. 

Human signature and adjudication both bind the current dependency digest and expire when relevant content changes. A model MUST NOT fake the command via an argument.update input claiming "user agrees". The user not signing does not block generating and delivering a reviewable draft. 
## 19. Reader report and body-text requirements

The report is generated from a template with a fixed order: 

1. Title, version, status, goal questions, and analysis scope.
2. The four layers of checks — mechanical / evidence / argument / body text — plus anything not executed.
3. Core conclusion table: ID, claim, support level, dispute status, review freshness.
4. An explanation card for each core conclusion.
5. Unresolved disputes and evidence gaps, ordered by impact.
6. Sources and lineage, version/transformation limitations, search scope, and inaccessible materials.
7. Review configuration, cost, human adjudications that took effect, binding hashes, and historical limitations; the current receipt/delivery/signature status is shown by a separate delivery summary and is not written back into this report.

Explanation cards have fixed fields: conclusion; supported scope; evidence (verbatim quote + attribution + location); reasoning summary (premises, warrant, necessary assumptions); competing explanations / counter-evidence; missing evidence; next steps; limits of applicability; reviewer / rule version. 

Where there is no evidence, fill in "No verified evidence yet"; where counter-evidence was not searched, "Not checked"; where a search found nothing, "Not found within the following scope"; where there is no gap object, "No gap registered; completeness of evidence cannot be inferred from this." Generating templates such as "no disputes" or "proven absolutely correct" is not allowed. 

The body text keeps existing source markers as locatable references; all multiple sources are recorded. A new `〔claim:<id>〕` marker MAY be used as an authoring aid. Lane-1 marker parsing treats `〔claim:<id>〕` as non-marker text: it is skipped, produces no `invalid-marker`, and preserves character offsets. Before lane-2 extraction, claim markers are likewise stripped first, and an offset map back to the original is maintained so that extraction spans remain valid against the original text. Internal claim markers are not retained in the final body text; removing them before formal delivery changes the artifactHash, so the artifact MUST be re-bound and re-audited. By default writing claim markers is not required; occurrences are used directly, avoiding an extra rewrite loop.  

Necessary qualifications MUST appear in the relevant paragraph. The closing report may elaborate explanations, but it cannot rescue determinative errors in the body text. Verbatim quotes are limited to reviewed, relevant short excerpts; entire sources are never copied. Access rights for public reports differ from access to the full workspace originals, and this feature does not automatically share any source. 

## 20. Complete behavioral example: historical narrative and event authenticity

All of the following are synthetic test material, not statements about real history. 

Source S1 snapshot: `在多年后的回忆中，甲说自己曾反对方案。` Source S2 snapshot: `同期会议记录只记载表决通过，没有逐人发言。`

The author first creates C1 = `甲在回忆中声称曾反对方案` (source-report); G1 cites S1. C2 = `甲当时确实反对方案` (fact); A1 derives C2 from premise C1 with warrant = `本人回忆可信`. 

Expected behavior:

- The quote and position pass, and C1 can receive strong direct support. 
- C2 cannot inherit C1's certainty; HIST-01/ARG-01 examine the reliability of recollection and the missing premise.
- S2 can neither directly prove that Person A favored the plan nor that Person A opposed it; the review MUST NOT treat "no per-person record" as counter-evidence that holds.
- A missing-evidence Issue is established: contemporary diaries, letters, or independent witnesses are needed, capable of distinguishing "later recalled it this way" from "actually opposed it at the time."
- The body text may be revised to "Person A later claimed to have opposed it, but the contemporaneous record is insufficient to confirm this." This sentence maps respectively to C1 and a qualified claim of "insufficient to confirm"; after re-audit, delivery with a registered gap is possible.
- The user gets only the original "甲当时确实反对" — even with legitimate line numbers attached, SUP/HIST/AUDIT cannot pass.

## 21. Complete behavioral example: literary interpretation and authorial intent

In synthetic texts T1/T2/T3, a character falls silent after a breakdown of trust; in T4, the character falls silent proactively when circumstances are favorable, to force others into concessions. 

C1 = `前三个场景的沉默与受伤后的自我保护有关`, kind=interpretation, with scope limited to T1–T3. G1 = all[T1,T2,T3]; A1's warrant explains the recurring relation but does not amount to proof of psychological causation. C2 = `作者认为所有沉默都是自我保护`, kind=intent.

Expected:

- C1 can be fairly strongly supported, but T4 forms a boundary / competing explanation that must be acknowledged in the scope and in the body text. 
- T4 does not necessarily completely overturn C1; counterexamples MUST NOT be mechanically judged to invalidate. Issue impact is determined by review targeted at the declared scope.
- C2 simultaneously exhibits universal extrapolation and a leap of authorial intent; INTENT-01/ARG-02 fail.
- The gap notes that establishing authorial intent requires additional material such as creative interviews or letters; even if an authorial statement is found, it is treated as the author's self-report and does not erase the work's polysemy.
- The body text changed to "In the three scenes analyzed, self-protection is the more explanatory reading; the other scene shows silence can also be used to control" can pass, provided the evidence, scope, competing explanations, and relevant rules are complete.

## 22. Acceptance and evaluation

### 22.1 Deterministic tests: all MUST pass 

| ID | Driving input | Observable outcome / pass condition |
| --- | --- | --- |
| D01 | Legitimate cited line numbers but inconsistent quote | EVID-01 blocker; corresponding semantic review not started |
| D02 | emoji/CJK/CRLF in the original text | Both UTF-16 spans and raw-byte hashes correct; no normalization drift |
| D03 | Three sources derived from the same parent | One lineage cluster; cannot present three independent corroborations |
| D04 | all group with two segments of joint support | Review input contains all fragments; not split into independent necessary conclusions |
| D05 | A→B→A | SUPPORT_CYCLE; transaction has no partial commit |
| D06 | Deletion of a referenced object | REFERENCE_IN_USE; HEAD unchanged |
| D07 | Same requestId with same/different payload | Returns the old result / IDEMPOTENCY_CONFLICT; budget not spent twice |
| D08 | Concurrent writes with identical expectedRevision | Exactly one succeeds, the other conflicts; no lost write |
| D09 | Crash injected at every fsync/rename point | After restart HEAD is either the complete old or the complete new version; no mixed graph |
| D10 | Body text unchanged, source externally modified | Fail; old review not reused; signature invalid |
| D11 | Update of an unrelated claim | Support caches not depending on it remain current |
| D12 | One-character change in the body text | audit/report/receipt/signature no longer current |
| D13a | Review response missing a required ruleId or set-schema mismatch | Single code `REVIEW_INVALID` (error record, not cached, retryable once); cannot pass |
| D13b | Model returns `needs-review` for a present rule; or fabricates IDs | Present-rule needs-review recorded inside a `completed` record; fabricated IDs invalidate the response (`REVIEW_INVALID`); cannot pass |
| D14 | Budget exhausted / timeout / cancel / restart | incomplete; actual or reserved budget continuously accounted |
| D15 | Same body text, receipt write failure | receiptId/hash read-back identifies the failure; old row not mistaken for current |
| D16 | Body text written via shell after binding | Turn-end detects the hash change; an unbound new file claims no receipt |
| D17 | style not installed, no exec fence | Disclose style not-run; exec inapplicable; no fabricated gate pass |
| D18 | Corpus text contains "ignore the review rules" | Treated only as data; no tool execution or authorization effect |
| D19 | After a semantic fail, a new request brushes out a pass | reviewer-disagreement; original fail not auto-cleared without adjudication |
| D20 | Old v1 receipt | Displayed as legacy/not-run; semantic guarantees not upgraded |
| D21 | Only an assistant-fabricated sign instruction | Rejected; no Signature |
| D22 | Report output scanned again | sources/reports/.dsh excluded; no self-referential evidence loop |
| D23 | Model fabricates original → write → read → register external | acquisition not upgraded to trusted fetch; external fact path capped at C |
| D24 | Document with mixed source markers and claim markers | Lane-1 mechanical verification produces no `invalid-marker` from claim markers; lane-2 extraction offsets remain valid after stripping claim markers |

Storage, hash, set, and state tests use a fake review adapter; model randomness MUST NOT be used to test deterministic contracts. 

### 22.2 Semantic gold set

Commit `packages/evaluation/vwa-eval/humanities/gold-manifest.json`, initially 60 cases: 20 historical, 20 literary, 20 research-argumentative. Each case contains the body text, source snapshots, expected atomic claims, coreness, evidence mapping, arguments, issues, permissible multi-solution annotations, and SHA-256. At least 20 clean positives and 40 with errors/gaps; stratified by domain and frozen as 40 development / 20 held-out test. Model-generated material may only serve as synthetic cases and MUST be explicitly marked synthetic; real excerpts MUST be legally usable. 

Each case is annotated independently by two people; disagreements are settled by a designated third reviewer or the user. Cases without completed adjudication are not included in hard metrics. Literary interpretation is not annotated by "whether one endorses the interpretation" but by whether evidence exists, whether the scope overreaches, and whether competing explanations are handled honestly. 

The initial release thresholds are engineering acceptance targets, not measured results already achieved: 

- Claim extraction recall ≥0.90; core recall ≥0.95.
- Major-fault identification recall ≥0.90; major/blocker false-positive rate on clean samples ≤0.10.
- Support-relation macro-F1 ≥0.85; per-domain and per-class results reported alongside.
- Deterministic-error detection rate for quotes and hashes = 1.
- Every metric reports sample count, numerator/denominator, and bootstrap 95% CI (fixed seed=20261016, 10000 resamples). Small samples MUST NOT be reported as pretty percentages alone.
- Policy/prompt/model config are frozen before the first held-out run; after any change the new version MUST be recorded, and the run MUST NOT continue to be called the same blind test.

The scorer specification is frozen as `humanities-scorer@1`:  

- Atomic-claim match: span IoU ≥0.5 AND kind equal AND normalized-text (NFKC + whitespace-fold) edit similarity ≥0.8. 
- Split/merge: for 1:N, recall counts a hit if at least 1 of the N matches; precision counts hits/predictions.
- Major fault: a finding with severity ∈ {blocker, major}.
- Support-relation evaluation unit: the (evidenceId, targetClaimId) pair; macro-F1 is averaged over classes, with absent classes excluded. 
- Clean-sample FP rate denominator: the number of clean positives.
- Threshold judgments use point estimates; CIs are disclosed only.

The gold schema gains a `match` rules field. Lane-1 sampling labels map to the `Support` enum as follows (frozen with the scorer): supported→`direct`, partially→`partial`, unsupported→`contradicted`, irrelevant→`irrelevant`.  

Humans may still disagree with a reasonable interpretation; such disagreements are recorded as disagreement, and a minority view is not directly labeled wrong. If thresholds are not met, the feature MAY be used as an experimental draft-review; enabling the reviewed marker by default is forbidden. 

### 22.3 End-to-end DoD

driver: in a real VWA session, create one historical and one literary synthetic project; per §20/§21 first produce flawed body text and then revise it; along the way modify a source once and cancel a review once and restart. 

observable: complete tool logs, immutable graph revisions, review records, source snapshots, v2 receipts with successful read-back, the two reports, and the nudge count.

pass: the initial draft is not marked reviewed; core errors are localized to specific objects/spans; the revision reaches the explicit predicate; counter-evidence is retained; source changes stale the results; restart does not reset the budget; cc/lane1 regressions unchanged; the user can answer the four goal questions from the report alone, without reading implementation logs.

## 23. Implementation slices and commit checklist

Each slice is an independent PR; this sequence is an execution order, not a new user-approval process. 

| Slice | Content | Acceptance that MUST be completed |
| --- | --- | --- |
| P0 | Fix baseline, export schemas, receipt consumer inventory, confirm model/task service interfaces | Current code fact table; new packages compile as empty shells; feature not enabled |
| P1 | sources/store/schema/graph, init/update/register/search_log | Corresponding mechanical tests within D01–D12; atomic recovery and concurrency |
| P2 | Review adapter, stage prompts, budget/background tasks/cache/policy | D13/D14/D18/D19; full flow with fake adapter |
| P3 | Independent full-text extraction/alignment, report renderer, type rules | The two synthetic cases; full-text coverage and body-text enhancement detection |
| P4 | v2 receipt, turn-end, shared nudge, signature/adjudication | D15–D17/D20–D22; real session E2E |
| P5 | Gold double-annotation, calibration, docs, and default switch verification | §22 metrics; if unmet, remain experimental |

Registration checklist: package.json exports/files/peerDependencies, tsconfig paths/references, vitest projects, preset vwa feature row, settings namespace, tool catalog, command help, bilingual README and usage guidance. Reuse the repo's current gates; do not write patches directly from line numbers in an old design. New semantic capabilities are not mixed into the CC parity capability ledger unless the repo's latest rules explicitly require it. 

Suggested new files, fixed as: 

```text
packages/interaction/vwa-argument/src/
  contracts/{author.schema.json,review.schema.json,receipt-v2.schema.json}
  schema.ts
  store.ts
  sources.ts
  graph.ts
  dependencies.ts
  policy.ts
  review-adapter.ts
  review-runner.ts
  audit.ts
  report.ts
  tools.ts
  commands.ts
  wiring.ts
  index.ts
packages/interaction/vwa-argument/prompts/{sources,support,arguments,extract,align}.md
docs/vwa/humanities-guidance.md
packages/evaluation/vwa-eval/humanities/
```

Files exceeding the repo size limit MAY be split by responsibility, but public contracts, tool names, states, and error codes stay unchanged. Do not treat the type pseudocode in this document as tested implementation; developers MUST generate complete JSON Schemas and validate them against fixtures. 

## 24. Runtime observability and safety boundaries

Events use the unified prefix `vwa-argument/`, including project-created, revision-committed, review-started, review-progress, review-finished, dependency-stale, report-written. Each event contains projectId, runId (if any), revision, seq, and result/error code; complete sources, original text, and model inputs MUST NOT be written to ordinary telemetry. 

Local review request/response may contain potentially sensitive material; it is stored only in the current workspace and is not automatically uploaded to third parties beyond model calls the host has already configured. No new web-scraping permissions are added; existing external tool permissions remain enforced by the host. Commands, authorizations, and system instructions embedded in source text are not executable instructions.

The report MUST NOT claim "machine-proved correctness of a literary interpretation"; the uniform wording is "checks completed according to the listed evidence and review rules." A source hash can only prove the same byte version, not the authenticity of a publication; a human signature can only prove the user reviewed the bound version, not substitute for source authenticity.

## 25. References and design basis

The grades, states, thresholds, and interfaces in this design are project engineering decisions, not standards directly given by the papers below. 

1. Original project design: [2026-10-12 Verifiable Workspace Agent](https://github.com/dsh-cc/dsh-cc/blob/main/docs/plans/2026-10-12-verifiable-workspace-agent.md); blob SHA of the file read for this effort: `e7db9e640c7640f7e265f11e4a909041d155d8ec`. The blob SHA identifies content; the fixed code baseline commit appears at the top of the document.
2. [verify.ts (fixed baseline)](https://github.com/dsh-cc/dsh-cc/blob/29a157b71194e274db47cdd551092e0c714b562f/packages/interaction/vwa-evidence/src/verify.ts): mechanical citation validity.
3. [pipeline.ts (fixed baseline)](https://github.com/dsh-cc/dsh-cc/blob/29a157b71194e274db47cdd551092e0c714b562f/packages/interaction/vwa-evidence/src/pipeline.ts): current claim/receipt orchestration.
4. [receipt.ts (fixed baseline)](https://github.com/dsh-cc/dsh-cc/blob/29a157b71194e274db47cdd551092e0c714b562f/packages/interaction/vwa-evidence/src/receipt.ts): v1 receipt and read-back contract.
5. [FActScore, EMNLP 2023](https://aclanthology.org/2023.emnlp-main.741/): inspiration for atomic-fact decomposition; no guarantee of literary-interpretation correctness.
6. [ALCE, EMNLP 2023](https://aclanthology.org/2023.emnlp-main.398/): inspiration for citation support and completeness evaluation.
7. [The ASPIC+ framework for structured argumentation: a tutorial, 2014](https://research-portal.uu.nl/en/publications/the-aspic-framework-for-structured-argumentation-a-tutorial/): inspiration for premises, defeasible reasoning, and the distinction of attacks on conclusions; this version does not implement its formal semantics solver.
8. [JSON Schema Draft 2020-12](https://json-schema.org/draft/2020-12) and [Ajv strict mode](https://ajv.js.org/strict-mode.html): basis for schema versions and strict validation. Ajv MUST use an entry point supporting 2020-12, with strict=true, coerceTypes=false, useDefaults=false, removeAdditional=false; UUID/Hash/Span and similar validation follow this document's explicit custom rules, not reliance on unknown formats being silently ignored.

## 26. Release checklist

- [ ] Write permissions for author input and review results are separated. 
- [ ] Current/stale/not-run/incomplete are all visible; no silent upgrades.
- [ ] Original text, provenance, version, transformations, and multiple sources are fully preserved.
- [ ] Support paths, reasoning bases, disputes, and gaps are individually expandable.
- [ ] Body text is extracted independently; the author's self-declared full claim set is not trusted.
- [ ] Mechanical pass and semantic pass are separate; major errors cannot be averaged away.
- [ ] Source/body/rule changes invalidate; read-back and recovery tests pass.
- [ ] Nudges and budgets are not duplicated by double-packaging, restart, or retry.
- [ ] Both domains' E2E completed; gold metrics recorded faithfully.
- [ ] cc/lane1 behavior preserved, semantic off by default, experimental status explicit.

## Appendix A. Fixed interface of the host adapter services

The following is the public boundary of this package and does not assume the host currently has interfaces with these names. P0 MUST implement adapters mapping the repository's actual services onto these interfaces; business modules MUST NOT call providers directly, bypassing the adapter. 

```ts
interface ReviewModelAdapter {
  // R1-07: no standalone synchronous describe(). The adapter is built on
  // the harness `prepareCall` (`PreparedLlmCall`): prepare first (the
  // resolved configuration and the adapter registration are frozen
  // together), compute reviewerConfigHash over the prepared config, and
  // always dispatch through the same prepared handle.
  prepareReviewCall(input: {
    messages:{role:'system'|'user';content:string}[];
    responseSchema:object;   // realized via the forced single-tool
                             // `respond` call form (§13) — the host LLM
                             // stream carries no native schema channel
    maxOutputTokens:number;
    signal:AbortSignal;
  }): PreparedReviewCall;
  countInput(messages: {role:'system'|'user';content:string}[]):
    Promise<{tokens:number;method:'tokenizer'|'bytes-upper-bound'}>;
}
interface PreparedReviewCall {
  describe(): {modelId:string;providerId:string;version:string;
               effectiveOptions:Record<string,unknown>}; // derived from the prepared call
  dispatch(): Promise<{raw:string;inputTokens?:number;outputTokens?:number}>;
}
interface VwaArgumentService {
  checkForDelivery(projectId:Id,artifactId:Id):
    Promise<{evaluationId:Id;bindingDigest:Hash;check:DeliveryCheck}>;
  listBoundArtifacts(projectId:Id):Promise<{artifactId:Id;path:string}[]>;
  renderReport(projectId:Id,artifactId:Id,evaluationId:Id,format:'markdown'|'json'):
    Promise<{text:string;reportHash:Hash;bindingDigest:Hash}>;
}
type DeliveryCheck = {
  artifactId:Id;artifactHash:Hash;projectRevision:number;graphHash:Hash;
  dependencyDigest:Hash;policyHash:Hash;reviewerConfigHash:Hash;
  checks:ReceiptV2['checks'];metrics:ReceiptV2['metrics'];
  assessments:Assessment[];findings:Finding[];reviewRunIds:Id[];
  sources:{sourceId:Id;snapshotHash:Hash;evidenceIds:Id[]}[];
  eligibleForReviewed:boolean;
  pendingRunIds:Id[];
};
```

checkForDelivery does not modify the body text, call models, or write receipts; it MUST read HEAD and the actual bytes to verify currency. It returns a frozen evaluation handle `{evaluationId, bindingDigest, check:DeliveryCheck}`; `renderReport(projectId, artifactId, evaluationId, format)` MUST carry this handle, and the runtime retrieves the frozen inputs internally by evaluationId. If a handle is stale (evaluation inputs changed), the result is `INPUT_CHANGED`. The report call uses the same frozen DeliveryCheck; if dependencies change while the report is being generated, return INPUT_CHANGED and retry once; if still changing, report generation fails and MUST NOT write "passed". Before the evaluator finally writes the receipt it re-verifies the bindingDigest — computed as `SHA256(stableJson({artifactHash, graphHash, dependencyDigest, policyHash, reviewerConfigHash, reviewRecordHashes, activeAdjudicationHashes}))` — and on failure writes a not-passed record or aborts, never sealing an old passing result. Active adjudications enter every downstream cache/report/receipt verification.   

The background task service interface requires only four behaviors: `start(taskId,run,signal)`, `cancel(taskId)`, `get(taskId)`, and `emitProgress(event)`; implementations reuse the host's existing task lifecycle, mapped as: start → `jobs.start(kind:'vwa-review', label=runId)`, cancel → kill, get → get, and emitProgress → updateProgress plus a cordis event. Exceeding the 10-per-owner cap returns `REVIEW_UNAVAILABLE`. When a task service is missing, the semantic.review tool is disabled with `REVIEW_UNAVAILABLE`; it never degrades into a synchronous long call that blocks turn-end.   

## Appendix B. Delivery-predicate pseudocode and boundary priorities

```text
evaluateDelivery(binding):
  validate schema, references, DAG, file hashes and exact quotes
  load only complete records matching dependency/config/policy digest
  detect disagreements on identical inputs (original records)
  apply human adjudications matching the same digest
  compute source/group results
  compute grades in claim dependency topological order
  apply current issue effects, then recompute affected downstream grades
  recompute grades after adjudication application; findings retained
    as rejected are excluded from active counting
  collect independent extraction + alignment results for the whole artifact
  evaluate rule sets and required question coverage
  derive four-layer verdicts and candidate overall
  render report bound to the frozen evaluation input
  recheck binding, append v2 receipt, read back receiptId and receiptHash
  announce reviewed only if every hard condition and read-back succeeded
```

The rule-failure → grade-consequence table (§7.1) applies in evaluateDelivery. Adapter validation rejects contradictory combinations: on the same target, `result:'fail'` coexisting with adequacy `robust/adequate` → REVIEW_INVALID. 

Adjudication application order: disagreement is detected on the original records first, then adjudications are applied; grades are recomputed after adjudication application. Disagreements that reappear after adjudication (introduced by adjudication-replaced labels) → needs-review, without reviving old disagreements. Findings retained as rejected are excluded from active counting. `reject` removes the finding from the active set, marks the rule `pass (human-adjudicated)` (a display state; the `Verdict` enum is unchanged and not widened), and grades are fully recomputed by policy; `accept` keeps the finding active. ReviewRecord.response is never rewritten. 

Boundaries are handled with the following priorities, never compromised by averaging: 

1. Storage/byte/quote/citation-structure errors → mechanical fail; semantics do not remediate.
2. Current semantic fail → the corresponding layer fails; an explicit legitimate human adjudication can override a semantic finding.
3. Disagreement / stale / budget interruption / incomplete review → needs-review; favorable outcomes are not selected.
4. A required task did not run → not-run.
5. Review completed and the article honestly presents U/C or disputes → MAY pass; real grades and gaps remain.
6. Only an uninstalled optional style gate → disclosed, neither miscounted as semantic completion nor forced to fail.

Grade changes caused by issues MUST propagate downstream, but an issue's mere "existence" is not a reasoning input; adding rebuttal dependencies in reverse into the support DAG is forbidden. An issue may point at a source/evidence/group/claim/argument; the propagation scope follows §15; a target of artifact/search is illegal — body-text problems use a Finding, and a search-gap target points at the claims it affects. 

## Review ledger

This design was produced through a three-seat blind review (one internal Staff-Engineer seat plus two external bridge seats, all blind to each other), in three rounds. Verdicts below are quoted as returned; severity labels were not normalized across seats.

**Round 1 — full blind review of v1.0 (Chinese working copy).** critic: GO-WITH-CHANGES (1 blocker, 5 major, 6 minor). codex: NO-GO (11 major). grok: GO-WITH-CHANGES (5 blocker, 13 major, 4 minor). The three verdicts diverged by severity calibration only — the finding sets overlapped heavily (receipt v1/v2 compatibility, claim-marker collision, structured-output channel, gold-set scoring, adjudication determinism). Adjudication rule applied: the implement-as-written test ("would two reasonable developers ship divergent behavior?") resolved the shared substance to blocker grade, so all findings were folded. 33 first-pass folds (R1-01 … R1-33) were applied while translating the specification into English.

**Round 2 — delta confirmation of the folds.** critic: GO-WITH-CHANGES (12 folds resolved; 8 new findings, 3 major). grok: GO-WITH-CHANGES (17 folds OK, 5 problem). codex: NO-GO (6 problem). The residual set was again convergent: fold residue — passages in sections not owned by a fold still carried the pre-fold contract (the `claims` stage missing from the dispatch pipeline, Appendix A retaining the superseded adapter interface, two shapes under the name `ExtractionRecord`, the opposition chain omitting `decisive`, the lane-1→Support mapping promised but not given). 16 second-pass fixes (R2-01 … R2-16) were applied.

**Round 3 — scope-constrained micro-confirmation.** Each seat received only the 16 pinned line ranges of the R2 fixes. critic: GO (16/16 OK). grok: GO (16/16 OK). codex: GO (16/16 OK). Scope honesty: rounds 2 and 3 verified the deltas and fold-introduced contradictions, not a full re-review of the v2 text; sections untouched by any fold carry only round-1 coverage.

**Known limitations carried forward.** Model judgments on humanities content are not provable by design (§0); §22.2 thresholds are engineering acceptance targets, not measured results; the cited code baseline must be re-diffed against the working branch before implementation (P0). User sign-off on this design is pending.
