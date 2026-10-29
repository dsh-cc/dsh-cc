# VWA Batch Autonomous Page Review (vwa-batch-autonomous)

## Status: Implemented (slices A-D, F — PR open, pending merge; slice E task-grant chain ships as a separate follow-up PR). Design — three-lane blind review converged (r1 full review: 1 GO-WITH-CHANGES + 2 NO-GO; r2 delta verification: all r1 findings folded, residuals fold-precision only; r3 micro-confirmation: all seats GO; r3b single-item confirmation: GO).

All code anchors cite tree `b3dfb054` (v0.9.3-rc.3), verified 2026-10-28.

## 1. Problem and goals

Today, VWA per-page evidence review (one page = one independent VWA project:
init → graph building (sources/claims/arguments + bind-artifact) →
`argument.review` → fix the page → write the report → git commit/push → CI
confirmation) requires the user to be present at every step. A 44-page list
means 44 manual inits, a hundred-plus per-command approvals, manual
adjudication of every REVIEWER_DISAGREEMENT, and a report pipeline whose
INPUT_CHANGED rejection is inverted in time (fixes happen after review, but
the report refuses to render after fixes).

Goal: given a page list plus a target instruction, the agent completes the
whole batch loop with zero user interaction under one task-scoped grant;
everything that genuinely requires a human (REVIEWER_DISAGREEMENT, final PR
merge, the grant itself) is collected into one end-of-batch ledger; every page
carries a cost and verdict record; a page that fails the same checkpoint
twice is skipped automatically.

Security master invariant: **the agent can never authorize itself and can
never forge human adjudication.** Every relaxation comes from an explicit
user action (the grant slash command); every disputed verdict is written only
by the human `/vwa adjudicate` lane.

Non-goals:
- No machine adjudication tool (disputed conclusions stay human).
- No automatic PR merge.
- No unconditional "md-only diff auto-allow" without a grant (the synchronous
  permission layer has no diff visibility).
- No cross-session grant persistence (a resumed batch in a NEW session needs
  a fresh grant — §2.8).
- `/vwa init` (the human command) is unchanged.

## 2. Feature 1 — agent-callable project creation: `argument.init`

### 2.1 Vehicle decision

A standalone new tool `argument.init`, registered beside `registerArgumentTools`
(tools.ts:143), wrapped in `withSchemaEnvelope(defineTool(...))` (PR #262
lesson: tool parameters must go through defineTool's compiled schema layer).
Not an op on `argument.update` (its guard requires an existing projectId and
`expectedRevision ≥ 1`, tool-input.ts:50-68 — an init special case would break
the uniform pre-validation). Not a CLI (no vwa package has a bin surface).

### 2.2 Input/output

Top level: `requestId` (UUID v4, required, idempotency key), `input` (object,
required, closed key set):
- `mode?: 'draft' | 'reviewed'` — default `'draft'` (same defaultMode
  semantics as commands.ts:229).
- `reviewSettings?: PatchReviewSettings` (key set = the allowed keys after
  the §4/§5 extensions). Semantics: first take the complete frozen baseline
  `base = freezeReviewSettings(settings())` (the settings provider is
  injected the same way as for `/vwa init`, command-host.ts:15 precedent),
  then apply the patch **on the frozen object** key by key
  (`frozen = { ...base, ...pickDefined(patch), budget: deepMerge(base.budget, patch.budget ?? {}) }`;
  the new keys `disagreementPolicy`/`projectBudget` overwrite their slots
  directly). Do NOT translate the patch into flat settings keys first —
  `freezeReviewSettings` only knows the existing flat keys and would drop
  the new ones. `ProjectStore.init`'s second parameter is a complete
  `FrozenReviewSettings` (store.ts:200-202). Freezing at init avoids the
  "set-review-settings only revises the latest cycle" compensation path.
- `setPointer?: boolean` — default `true` (parity with `/vwa init`: writes
  `.dsh/vwa/current-project.json`, commands.ts:148-155). Batch loops are
  documented to pass `false`: every VWA tool takes an explicit projectId and
  never reads the pointer; this avoids the batch rewriting the user's
  interactive pointer on every page.

Output: the Ok envelope `{ok:true, projectId, revision:1,
data:{workspaceIdentity}}` (RESULT_SCHEMA, tool-input.ts:19-32).

### 2.3 Behavior

1. `root = deps.workspaceRoot(exec.agent)` (same as the five tools,
   tools.ts:123-126).
2. Idempotent reservation (reserve-before-create, §2.4): exclusive-create
   `.dsh/vwa/inits/<requestId>.json` → adopt the reserved projectId; already
   exists with matching payloadHash → adopt; mismatch → `IDEMPOTENCY_CONFLICT`
   (same code as §2.4).
3. `newId = 'prj_' + randomUUID()` (same format as commands.ts:242);
   `contract = { ...defaultContract(...), mode }`.
4. `ProjectStore.init(contract, frozenSettings)` (store.ts:200-220),
   **executed under the project write lock** (`locks/write.lock`): the
   HEAD-exists check alone is not a create transaction — two adopters of the
   same reservation can both pass it and write diverging workspaceIdentity
   values (issue #312; the TLA+ model `specs/tla/vwa-batch-run` pins this as
   the intended transaction). On-disk
   layout identical to `/vwa init` (except id/nonce/time):
   `.dsh/vwa/<projectId>/{HEAD.json, workspace.json, revisions/, operations/,
   locks/}`, `docs/vwa-sources/<projectId>/`, revision 1. When init returns
   "already exists" (the original creator is still alive or finished), the
   recovery path applies: read HEAD and workspace.json, projectId matches →
   success; mismatch → STORE_CORRUPT.
5. `setPointer` per §2.2; idempotent replays never rewrite the pointer
   (first result wins).

### 2.4 Idempotency protocol (durably idempotent)

- `.dsh/vwa/inits/<requestId>.json` = `{schemaVersion:1, requestId,
  payloadHash, projectId, ts}` with `payloadHash = sha256(stableJson(input))`.
- Order: **first** exclusive-create the reservation via `openSync(path,'wx')`
  and write the full JSON in a **single writeSync + fsync on that fd** (the
  file is tiny; one write is effectively atomic; never write in fragments) →
  **then** `ProjectStore.init` → init failure does not delete the reservation
  (the projectId is fixed; retries take the recovery path). A reservation
  write failure fails the whole init (no best-effort — otherwise the
  idempotency promise breaks). A retry that reads an **unparseable**
  reservation (a crash remnant of the single write) → `STORE_IO_FAILED` with
  a delete-to-recover message (the requestId is dead but the batch is not
  bricked — the agent uses a fresh requestId; an orphaned reservation has no
  side effects).
- Crash windows: crash between reservation and init → retry adopts the
  projectId and init runs normally; crash after init → recovery reads HEAD.
  Concurrent same requestId → the second caller fails `openSync wx`, reads
  the reservation, takes adopt/recovery. **No window exists that produces a
  duplicate project.**
- Payload mismatch (same requestId, different input): return the existing
  code `IDEMPOTENCY_CONFLICT` (already in the store Fail union) — no new
  project.
- **Retry adoption is a required protocol action** (forced by the TLA+
  model `specs/tla/vwa-batch-run`): the only way back from a crash between
  the reservation and `ProjectStore.init` is re-reading the reservation,
  adopting its projectId and continuing the init — not an optimization, so
  the implementation must provide that path and a test.
- **The reservation is consumed at the first successful create**: once init
  has succeeded no process may rewrite or truncate that file (exclusive
  create already guarantees one writer at a time; this rule closes the
  post-success window).
- The batch layer persists each page's init requestId into state.json
  (§8.3) so a crash replays the same requestId.

## 3. Feature 2 — task-scoped authorization (task grant)

### 3.1 Current state and gaps (verified in r1)

- Present: settings rules (bare-prefix `Bash(git push)` = any command starting
  with that text; the `X:*` form is a literal prefix INCLUDING the colon and
  does not match `git push origin x` — parser.ts:32-39), session-scoped
  SessionAllowlist (session-allowlist.ts:100), the deterministic risk table
  (classifier.ts:85-98: plain commit/push are LOW; force-push/reset --hard are
  MEDIUM), auto-mode LLM arbitration (pre-execute.ts:293:
  `autoStage.maybeEscalate` runs before mapPostWaterfall).
- Missing: any task-scoped authorization object; the sandbox escalation seam
  carries no argv (only {agent, toolName, callId?, reason?, signal?}).
- Pre-existing hole (hardened by this design, §3.7):
  `.dsh/vwa/<projectId>/adjudications.json` and `signatures.json` are plain
  JSON with a string `signer` (report.ts:346-391) — the agent's Write tool
  can forge human adjudication today.

### 3.2 TaskGrant object (all trust-bearing fields are host-derived)

```ts
type TaskGrant = {
  grantId: 'grant_' + uuid
  root: string            // host-derived: workspace realpath
  branch: string | null   // host-derived: git rev-parse --abbrev-ref HEAD at grant time
  goalId: string | null   // host-derived: active goal, if any
  expires: { kind: 'session-end' | 'goal-complete' | 'manual' }  // host-derived
  // ---- capability face (what the descriptor declares and the user approves) ----
  rules: string[]          // bare-prefix rule syntax, e.g. 'Bash(git add)', 'Bash(git commit)', 'Bash(gh run watch)'
  tools: string[]          // 'argument.*' | 'evidence.*' | exact names; only prefix.* and exact forms
  writePaths: string[]     // root-relative normalized path prefixes; MUST be derived from the manifest page list + 'docs/vwa-reports/' + '.dsh/vwa/batches/'
  sandboxEscalation: boolean
  modeCeiling: 'workspace-write' | 'danger-full-access'  // default 'workspace-write'; danger-full-access must be declared in the descriptor and highlighted in the approval view
  contentScope: 'tracked-md-only' | 'any'  // conditional default: tracked-md-only when sandboxEscalation=true AND rules contain git commit/push prefixes (§3.6 has something to check); otherwise 'any'. In the former case 'any' requires explicit opt-in highlighted in the approval view
  createdBy: 'user'
  ts: string
}
```

**writePaths hard exclusion:** nothing under `.dsh/vwa/**` except
`.dsh/vwa/batches/**` may ever appear in writePaths (the grant validator
rejects it) — adjudications.json, signatures.json, revisions/, review-runs/,
review-cycles/, evaluations/ are only mutable through the VWA tools. Page
repair edit rights come from the manifest page list (the user sees every
path when approving the grant).

Storage: a new session event `permission/task-grant` (payload = TaskGrant;
the `cleared` marker MUST carry a grantId — revoke one grant, never copy
foldSessionAllows' cleared=wipe-all semantics), registered into
KNOWN_SESSION_EVENT_TYPES (same as session-allowlist.ts:26-28); an in-memory
TaskGrantStore that lazy-loads on first use, mirroring the
`sessionAllowMatches` seed-on-first-use pattern (foldSessionAllows is not a
generic event fold). Expiry: session end / goal-complete (grants linked to a
goal are cleared when the goal reaches a terminal phase) /
`/permissions revoke <grantId>` / automatic revocation on contentScope
violation (§3.6).

### 3.3 Creation: user-typed slash command ONLY

The r1 draft's agent-initiated `permissions.request_grant` tool is dropped.
Reason: serviceAsk's `approval.request` payload is a fixed field set
(runtime-code.ts:165-172 — no `kind` discriminator), and a PermissionRequest
hook can return allowed-once — "an agent-initiated ask was allowed" cannot
prove human authorization, so `createdBy:'user'` would be forgeable.

New form:
- `/permissions grant <descriptorPath>`: reads the descriptor file (the
  agent may pre-write it, e.g.
  `.dsh/vwa/batches/<batchId>/grant-descriptor.json`, containing only the
  capability-face fields), the host derives root/branch/goalId/expires, and
  renders the **complete post-derivation view** to the user (every rule,
  every writePath line by line, expiry conditions, contentScope). The user
  confirms; the TaskGrant is created.
- `/permissions grants` (list + revoke), `/permissions revoke <grantId>`.
- Agent-side contract: at batch start the agent pre-writes the descriptor and
  asks the user to run the command in its reply; no grant ⇒ the batch aborts
  before any page starts. This is the single user action in the whole flow
  (two inputs counting the initial instruction), matching the requirement of
  "a task-level whitelist instead of per-command escalation".

### 3.4 Consumption point 1 — the pre-execute waterfall (before LLM arbitration)

- Placement: inside the pre-execute listener, AFTER classifier/rule denies,
  BEFORE `autoStage.maybeEscalate` (pre-execute.ts:293). Fixed order:
  ① deny rules and HIGH risk decide first (a grant never lifts any deny)
  ② task-grant match ③ no match → the current auto-stage LLM arbitration
  path, unchanged.
- Match semantics:
  - bash: **grant rules are fed as a rule list into the SAME evaluation path
    as the existing shell evaluator** (matchAllowForSegment semantics reused
    verbatim: assignment-bearing segments match on `raw` only, tainted
    segments are never admissible, opaque syntax fails closed — no separate
    "strip env prefix" bypass semantics). For compound commands
    (&&/||/;/|), **every segment** must be admitted by some grant rule; any
    unadmitted segment → not a grant match, fall back to the current path.
  - **Token boundary**: a prefix hit must land on a token boundary — the
    command equals the prefix, or the prefix is immediately followed by
    whitespace; `Bash(git commit)` must not match `git commit-tree`. The
    grant rule validator also rejects whole-tool bash rules, wildcards, `:*`
    colon-prefix forms, and commands where `-c`/`--config-env` appears before
    the git subcommand.
  - **Structured push matching**: `git push` commands do NOT use bare-prefix
    matching; they use argv-structure matching — exactly `<remote> <refspec>`
    two arguments, the refspec's target branch must equal grant.branch
    (`<branch>` or the same-name `<branch>:<branch>` form); multiple or other
    refspecs, and non-fast-forward flags (--force/-f), never match. commit,
    add, and other git write commands keep bare prefix + token boundary.
  - Classifier interaction: a grant allow applies only to calls whose
    post-classifier risk is LOW; pattern-derived MEDIUM (force-push,
    reset --hard, clean -f — classifier.ts:85-98) falls back to ask even
    inside grant prefixes, and pattern-derived HIGH stays DENY — a grant
    relaxes "the LLM arbiter's ask", never a deterministic risk verdict.
  - Edit/Write/NotebookEdit path-writing tools: the write target (after
    realpath normalization) matches some writePath — **both sides are
    normalized the same way**: the writePath is resolved as
    `join(root, writePath)` then realpath-normalized, and compared as a
    prefix against the normalized target → allow; otherwise the current
    path.
  - VWA/MCP tools: exact toolName or `prefix.*` match against tools → allow.
- A grant hit is a deterministic allow (no LLM arbitration).

### 3.5 Consumption point 2 — sandbox escalation (registry bound to execution identity, one-shot)

- When the decide side grant-allows a bash call and grant.sandboxEscalation
  is true, register in the EscalationRegistry:
  `{executionToken, sessionId, agentId, toolName, commandHash, grantId,
  modeCeiling, ts}` — bound to the **execution token and command hash**
  (not bare callId; runtime-execute.ts:56-78 distinguishes token vs callId),
  `commandHash = sha256(normalized command text)`.
- modeCeiling: default `workspace-write`; auto-approval only applies to
  escalations whose requested mode ≤ modeCeiling. The escalation reason text
  is `escalate sandbox to ${mode}: ${justification}` (verified at harness
  escalation.ts:192 — the mode IS present; the listener parses the
  `escalate sandbox to <mode>:` prefix; **if the reason prefix does not match
  the known form → no auto-approval, fall back to the user** — fail-closed
  for other reason variants). `danger-full-access` only matches when the
  grant explicitly declares it.
- The approval-listener handles a sandbox escalation by auto-answering
  allowed-once only when ALL hold: the request's execution identity hits a
  registry entry, the commandHash matches, the grant is still active, the
  requested mode ≤ modeCeiling, and the branch guard passes (the listener
  **spawns git directly** — `git -C root rev-parse --abbrev-ref HEAD`, never
  through the shell service, to avoid approval/request re-entrancy; result
  == grant.branch; git failure or branch drift → fall back to the user).
  The registry entry is consumed and deleted on use (all terminal paths
  clean up).
- Fallback semantics: **while any task grant is active**, sandbox
  escalations that miss the registry fall back to the USER (an unexpected
  escalation inside a granted batch is itself an anomaly worth a human
  look), not the current blanket allowed-once; with no grant active, current
  behavior is unchanged. A grant is a relaxation within the task and a
  tightening within the task; it does not change the no-grant baseline.
  **Two re-validation rules pinned by the TLA+ model
  (`specs/tla/task-grant-authorization`, v2 review folds)**: ① the
  baseline path re-validates grant-ABSENCE at consume time — a grant CREATED
  between the approval check and the consumption must not be bypassed by a
  baseline approval; ② **registrations die with their grant** — revoke,
  expiry and reset clear the escalation registry, so a grant that died and
  was re-created never consumes a stale entry (the new grant's ceiling and
  branch are what the consume checks).

### 3.6 contentScope: tracked-md-only (conditional default)

Before auto-approving git commit/push escalations the approval-listener
verifies (G-12 precise forms):
- commit: `git -C root diff --cached -z --name-status`, class by class —
  `M`/`A` require the path to end in `.md`/`.mdx`; `R` is judged by the new
  path; `D` (deletion) and untracked files entering the commit are
  violations.
- `git commit -a` (stages at commit time, invisible to diff --cached):
  after the pre-check passes and the commit executes, verify post-hoc with
  `git -C root diff-tree --no-commit-id --name-status -r -z HEAD`; violation
  ⇒ revoke the grant (cleared event, reason content-scope-violation),
  prominently report to the user (the commit has happened and cannot be
  rolled back — this residual is declared honestly), the batch stops on
  that page as failed.
- push: `git -C root log -z --name-status origin/<branch>..HEAD` (same
  class rules — only `--name-status` has the A/M/R/D status column; the
  status field may be `R100`-shaped, parsed by its first-letter segment);
  only M/A of .md/.mdx allowed; renames by new path; an empty set is an
  idempotent push and passes.
- `A` (addition) semantics: regardless of prior tracked status, `A` with a
  `.md`/`.mdx` path passes (adding new md pages is legitimate); `D` and
  non-md paths always violate.
- Pre-check violation ⇒ this escalation falls back to the user + the grant
  is revoked. `any` must be explicitly declared in the descriptor and
  highlighted in the approval view.

### 3.7 Hardening of the pre-existing hole: authoritative VWA state default-ask

- New settings default rule: Edit/Write/NotebookEdit on `.dsh/vwa/**`
  (ONLY `.dsh/vwa/batches/**` exempt — exactly the §3.2 writePaths
  exclusion, current-project.json included) default to **ask** (not deny —
  a human can still manually allow legitimate one-off cases). The VWA tools
  write via fs directly and are unaffected.

### 3.8 Boundary statement

- Grants are session-scoped: session-event folding keeps a grant alive
  across resumes of the same session; a NEW session resuming the same batch
  needs the user to run `/permissions grant` again (the batch tail ledger
  says so). No cross-session persistent authorization — that would widen
  "task-scoped" into "repo-scoped", beyond this design's semantics.

## 4. Feature 3 — non-blocking REVIEWER_DISAGREEMENT (deferred)

### 4.1 Current state (including a known defect)

- Production: disagreementFinding() (review-run-store.ts:347-358); the
  runner saves a marker record (review-runner.ts:416-419); aggregation
  reuses markers (review-current.ts:66-73).
- Blocking surface: currentReviews forces record-level needs-review
  (review-current.ts:89-97, and this function takes no adjudications);
  delivery-check then adds `if (selected.findings.length) checks.argument =
  'needs-review'` (delivery-check.ts:316) and unconditionally drops
  disagreement from `active` (:293); policy.ts:446 excludes it from major
  counts.
- Defect (confirmed by two seats in r1): activeAdjudications
  (delivery-check.ts:44-53) + the :293 unconditional exclusion together
  mean an adjudication of a disagreement finding can never discharge the
  needs-review it causes.
- `/vwa adjudicate`: AdjudicationRecord {adjudicationId, findingId, decision,
  reason, signer:'user', ts, dependencyDigest, overrides:{ruleId, targetId,
  runId}} (commands.ts:427-436).

### 4.2 New setting: disagreementPolicy

- PatchReviewSettings gains the top-level key `disagreementPolicy:
  'blocking' | 'deferred'` (default 'blocking'). Write surfaces: the
  applyReviewSettingsPatch allowed-key set (review-settings-revision.ts:53-65;
  same class as the budget keys, excluded from identity hashes) and
  `argument.init`'s reviewSettings.
- Read point: delivery-check's DeliveryInputs gains an independent
  `disagreementPolicy` field (like reviewerConfigHash), taken from HEAD at
  call time — never read from the snapshot under evaluation (the as-of path
  evaluates frozen state; the two would diverge).

### 4.3 Deferred mode (policy-aware post-pass; currentReviews stays pure)

The needs-review lift is a **post-pass inside delivery-check** (adjudications
are only available there); currentReviews keeps its signature:
1. currentReviews still returns record-level needs-review including
   disagreement.
2. delivery-check applies a policy-aware correction after `selected` is
   computed (new step, before checks assembly):
   - disagreement markers are collected as `markers`.
   - `excludedFromForce` (markers that do not drive needs-review) =
     ① (deferred mode AND no active adjudication) ∪ ② (an active
     adjudication exists — its effect flows through the §4.4
     prevailing/superseded rules instead of a marker force).
   - blocking mode: only ② enters excludedFromForce (current behavior —
     unresolved markers keep blocking).
   - `selected.findings` is filtered by excludedFromForce before the
     `if (selected.findings.length)` force; a stage whose needs-review was
     driven **only** by excluded markers is upgraded to the stage's real
     verdict from its remaining records.
   - New return field `deferredDisagreements: Finding[]` = ① (the unresolved
     set); adjudicated markers do not appear there (their state is expressed
     by §4.4 prevailing semantics).
3. Invariant (both modes): **an unresolved disagreement exists ⇒
   eligibleForReviewed = false.** Deferred unblocks reports and the batch;
   reviewed eligibility always waits for the human. report-render renders
   deferredDisagreements as a dedicated "Pending adjudication
   (machine-deferred)" section (findingId/target/the two conflicting
   verdicts/runId per entry) and a header line `machine-deferred: N pending`.

### 4.4 Adjudication semantics — the human picks which record stands

- **Command grammar extension**:
  `/vwa adjudicate <projectId> <findingId> <accept|reject> <prevailingRunId> <reason>`
  — the grammar gains an explicit projectId segment (commands.ts:29/:107-114;
  the pointer form remains the fallback when projectId is omitted; batch
  mode runs setPointer:false so the pointer is unusable and batch-tail
  suggested commands MUST carry the projectId). The command validates
  prevailingRunId ∈ the disagreement's two conflicting runs.
- AdjudicationRecord gains `overrides: {ruleId, targetId, runId:
  prevailingRunId, supersededRunId}`.
- Effect rules (delivery-check post-pass, both modes): when an active
  adjudication hits a disagreement finding — the needs-review force lifts;
  on that (targetId, ruleId), **only the prevailingRunId record's verdict
  counts** toward the effective verdict/findings; the supersededRunId
  record's same-slot verdict is marked superseded (rendered struck-through/
  as a footnote, never deleted). accept = the finding keeps its force
  (severity re-enters activeMajorCount — policy.ts:446's exclusion is
  conditioned the same way); reject = the finding is removed from active.
- **Liveness extension**: a disagreement adjudication is active when
  dependencyDigest matches AND the findingId appears in a current record of
  EITHER overrides.runId OR supersededRunId (the marker lives on the
  detecting run; requiring it on the prevailing run would make every
  cross-run adjudication permanently inactive).
- **Precise eligibility flip**: reject (the human rules the failing verdict
  spurious) ⇒ the finding is removed ⇒ eligible may flip to true; **accept
  (the failing verdict stands) ⇒ the finding keeps its major force ⇒
  eligible stays false** — this is correct semantics, not a defect: a
  confirmed major should block reviewed status; the repair path is fix +
  rebind + reaudit.
- No "discard both" third option: a disagreement is by definition two
  mutually exclusive verdicts on one (target, rule); the human must pick a
  side. "The finding should not exist at all" scenarios go through the
  existing `/vwa repair` lane.

### 4.5 End-of-batch adjudication queue

A derived view, no new storage: the batch tail aggregates each project's
deferredDisagreements into the batch document's "Pending human
adjudication" section — per entry: projectId, artifactId, findingId, the two
conflicting runIds, and the suggested `/vwa adjudicate` command line (with
prevailingRunId placeholder). After the human adjudicates, an as-of
re-render (§6.2 step 3's adjudication overlay) reflects it: reject ⇒ the
finding is removed and eligible may flip; accept ⇒ the finding keeps its
force and eligible stays false (§4.4).

## 5. Feature 4 — budgets and long-run control

### 5.1 Project-cumulative budget (in-lock reservation)

- PatchReviewSettings gains `projectBudget: { maxCalls?: number;
  maxOutputTokens?: number; maxInputTokens?: number }` (all optional;
  unset = unlimited). Stored in snapshot.contract.reviewSettings (revisable
  via set-review-settings); settable once at init (§2.2).
- Enforcement: a new `projectUsage(root, projectId)` — per-run through
  `ReviewRunStore.loadRequest` (the authoritative reconciled read of
  usage.jsonl, not a raw request sum), not filtered by cycle.
  `PROJECT_BUDGET_EXHAUSTED` joins the Fail code union (store.ts:36-43).
  **Check location = inside the withBudgetLock critical section**
  (review-cycle.ts:72-77):
  - reserveCycleRequest (admission): `projectUsage + this request's
    estimatedWithRetries ≤ limit`, else `PROJECT_BUDGET_EXHAUSTED`
    (retryable=false).
  - reserveCycleCall (per call, :258-274): `projectUsage(excluding this
    run) + this run's spent + 1 ≤ maxCalls` (tokens likewise), else refuse.
  - In-lock checking removes the concurrent-overspend window: two runs
    passing admission cannot both pass the per-call reservation.
- Implementation trap: applyReviewSettingsPatch **rebuilds** an explicit
  four-field object (review-settings-revision.ts:67-76) — the new keys must
  enter BOTH the allowed-key set AND the rebuilt literal; adding only the
  former silently drops the fields on the next set-review-settings.
- Relation to cycle budgets: they coexist. The cycle sidecar governs a
  single wave's peak (freeze semantics unchanged); projectBudget is a live
  ledger (reads durable usage rows), effective immediately and across
  cycles.

### 5.2 Explicit audit skip (skipAudit)

Baseline correction (r1): a committed set-review-settings already rewrites
the LATEST cycle's sidecar (review-settings-revision.ts:123-134 →
review-cycle.ts:288); subsequent reservations read the new value; only a
running run's locally frozen per-call settings are unaffected. Raising
limits does not require a new cycle.

- `argument.review` input gains `skipAudit?: boolean` (default false):
  - admission (feasibility.ts:62-77): audit counts are zeroed in the
    estimate; passing skipAudit together with an explicit `stage:'audit'`
    is SCHEMA_INVALID (mutually exclusive declarations).
  - Persistence: the admission request record (feasibility.ts:216) gains
    `skipAudit: boolean` plus `artifactHash` and `entityVersion` identity
    fields (binding the skip declaration to one artifact binding — an old
    declaration auto-expires after a rebind), persisted with the request
    record, excluded from every identity hash.
- **Effective predicate (five call sites, one predicate)**:
  `auditSkipInEffect(projectId, artifactId, artifactHash, entityVersion)` =
  "the most recent admission for this artifact (by request order) whose
  record carries matching artifactHash and entityVersion has skipAudit=true"
  AND "no complete audit run for that artifactHash exists after it
  (extract+align in one run, delivery-check.ts:176-185 candidate
  conditions)". A later complete audit or a later non-skip admission flips it
  back.
  - report side: check.audit renders `not-run (skipped by request <runId>)`;
    the header renders `audit: SKIPPED (declared at <runId>)`;
    eligibleForReviewed=false; **the report succeeds**.
  - continue side: planContinueTasks/continueHasWork (review-continue.ts:123/
    :159) reuse the same predicate — while a skip is in effect, audit is not
    re-planned; when it stops being in effect (e.g. after a rebind), it is.
  - feasibility and the batch completion rule (§8.3 checkpoint 3) use the
    same predicate.
- Agent guidance: prefer narrowing targetClaimIds / batched continues;
  skipAudit only when infeasible.

### 5.3 Resume

- Within a page: existing machinery (durable records + continue reuse + the
  budgetRevision fence, review-continue.ts / review-cycle.ts:206-211),
  unchanged.
- Review async recovery: the batch contract persists per page
  {requestId, runId, phase}; a resumed run **first replays the same
  requestId** (obtains running/terminal state) and only issues a
  continue with a NEW requestId after the previous run is terminal — never
  overlapping a live run.

## 6. Feature 5 — as-of report (FrozenEvaluation two-step)

### 6.1 Vehicle decision (r1 pivot)

The r1 draft's bind-time byte snapshots + asOfRevision recomputation are
dropped. Reason: checkForDelivery already freezes the complete evaluation
input (FrozenEvaluation: check, snapshot, adjudications, gates, and the
FULL artifactText bytes — report.ts:211-228, persisted under
`.dsh/vwa/<projectId>/evaluations/` with hash-verified read-back). The
correct vehicle for "the state at review time" already exists. The r1
recomputation path would additionally have had to freeze gates, reviewer
config, and the record set's time boundary (codex r1); the two-step design
avoids all of it.

### 6.2 Flow (the batch standard sequence)

1. **Freeze before fixing**: after the review passes and BEFORE touching
   the page, the agent calls `argument.report {projectId, artifactId,
   format, write:false}` — this call creates FrozenEvaluation E
   (checkForDelivery computes over the current live bytes = exactly the
   review-time state) and returns `evaluationId` and `bindingDigest`.
   write:false writes no report file; it only freezes. E gains a frozen
   field `disagreementContext: {findingId, targetId, ruleId, runA, runB,
   verdictA, verdictB}[]` (the minimal conflicting-verdict context the
   adjudication overlay needs, step 3).
2. Fix the page (**without committing** — the commit comes after step 3,
   one commit per §8.3).
3. **As-of re-render**: `argument.report {projectId, artifactId,
   evaluationId: E, format, write:true}` — renders E, **skipping the
   layer-B live recheck loop** (report.ts:245-259 is not executed in as-of
   mode); instead the current disk bytes are hashed to
   `currentArtifactHash` and compared with E.check.artifactHash, and the
   report header renders `as-of evaluation <E>; reviewed artifact hash H₁;
   current disk hash H₂; diverged: true/false`; when diverged, a prominent
   note: "artifact was modified after review; findings apply to the
   reviewed revision".
   - **Adjudication overlay (the DoD-4 flip channel)**: the as-of
     re-render replays the §4.3/§4.4 post-pass with the **live adjudication
     state at render time** — inputs are E's frozen findings/check +
     E.disagreementContext + the live adjudication records; outputs are the
     overlaid checks/eligible/findings (the report notes `adjudication
     overlay: applied at render time; all other inputs as-of E`). The
     overlay consumes only excludedFromForce rule ② (adjudicated markers,
     mode-independent, unrelated to disagreementPolicy) — no live policy
     read, no §4.2 read-point split. Non-adjudication changes after E's
     freeze (new review records, graph revisions) never appear in an as-of
     render — an inherent boundary of as-of semantics, declared honestly.
4. The existing single-step usage is completely unchanged: without
   evaluationId, behavior is byte-identical to today (hard regression
   constraint).

### 6.3 Tool and error semantics

- report-tool input gains `evaluationId?: Id`; when present, the as-of path
  applies.
- **Typed error pass-through**: report-tool's catch-all (report-tool.ts:62-63
  folds every throw into retryable INPUT_CHANGED) becomes a per-type
  mapping — InputChangedError → INPUT_CHANGED (retryable);
  evaluation-read-back hash failure → STORE_CORRUPT (not retryable);
  unknown evaluationId → REFERENCE_INVALID (not retryable). Report
  publication becomes atomic (temp+rename on the write path).
- Declared limitation: as-of requires E to have been frozen before the
  fixes. If step 1 was skipped, as-of is impossible (no snapshot to return
  to); the only recovery is the existing rebind+reaudit path. The batch
  contract makes "freeze the evaluation" checkpoint 4 (§8.3) so it cannot
  be skipped.
- Retention: FrozenEvaluations are never garbage-collected (same lifetime
  as revisions/); each report call creates one evaluation file; a batch page
  produces one (the re-render reuses the passed evaluationId and does not
  call checkForDelivery).

## 8. Feature 6 — batch manifest and state contract

### 8.1 Vehicle

The driver is the agent itself (a `vwa-batch` skill); no resident runner.
The deliverables are the state contract (file schemas + invariants +
transitions) and the skill, so any implementer or future session advances
by the same contract and resumes from breakpoints.

### 8.2 File layout

`.dsh/vwa/batches/<batchId>/` (batchId = `batch_<yyyymmdd>_<8hex>`):
- `manifest.json` (written once at start, then read-only; schemaVersion:1):
  {batchId, target, branch, pages: [{page}], policy: {maxPageAttempts: 2
  (default), disagreementPolicy: 'deferred', projectBudget?,
  skipAuditFallback: boolean}, grantDescriptorFile: 'grant-descriptor.json'}
- `grant-descriptor.json` (agent pre-writes; capability-face fields only;
  writePaths derived from the page list).
- `state.json` (atomically written per milestone, temp+rename, serialized
  through `.dsh/vwa/batches/<batchId>/state.lock` — the lock.ts pattern;
  schemaVersion:1):
```json
{ "batchId": "...", "updatedAt": "...",
  "pages": [{ "page": "docs/...", "projectId": "prj_...",
    "status": "pending|active|done|skipped|failed",
    "initRequestId": "<uuid>",
    "stageFailures": { "projectCreated": 0, "graphBound": 0, "reviewCompleted": 0,
      "evaluationFrozen": 0, "reportWritten": 0, "committed": 0, "pushed": 0,
      "prOpen": 0, "ciConfirmed": 0 },
    "review": { "requests": [{ "requestId": "<uuid>", "runId": "run_...",
      "phase": "fresh|continue|poll" }], "lastRunId": null, "skipAudit": false },
    "evaluationId": null, "reportHash": null,
    "commit": { "kind": "none|fix-and-report|report-only", "sha": null },
    "pushedSha": null, "pr": { "url": null, "noPr": false },
    "ci": { "runId": null, "headSha": null, "url": null, "ciTimeouts": 0 },
    "failureReasons": [],
    "costs": { "calls": 0, "inputTokens": 0, "outputTokens": 0, "cycles": 0 } }] }
```

### 8.3 State machine and invariants

- Checkpoints (fix and report land in **one commit**):
  1. projectCreated (init returns the projectId; idempotent replay, same id)
  2. graphBound (bind-artifact succeeded, occurrences verified)
  3. reviewCompleted (run completed and delivery passes: all semantic
     stages current + audit pass OR the §5.2 predicate's skip in effect;
     in deferred mode disagreements do not block this checkpoint)
  4. evaluationFrozen (§6.2 step 1; evaluationId recorded)
  5. reportWritten (as-of re-render succeeded; reportHash recorded; the
     report file is on disk, not yet committed)
  6. committed (kind=none allowed when the review found nothing actionable —
     the report file alone forms the commit; otherwise one commit contains
     both the page fix and the report)
  7. pushed (pushedSha recorded)
  8. prOpen (PR URL recorded; kind=none with no commit may have no PR,
     recorded as noPr and allowed)
  9. ciConfirmed (CI for pushedSha, **queried by exact SHA** —
     `gh api repos/{owner}/{repo}/commits/<pushedSha>/check-runs` (per-check
     conclusion), or `gh run view <id> --json headSha` with headSha ==
     pushedSha; do not use the nonexistent `gh pr checks --commit` form).
     `gh run watch` must carry an explicit timeout — **timeout ≠ failure**:
     timeouts count toward a separate `ciTimeouts` counter (max 3, then
     treated as failure) and do not consume maxPageAttempts; only a
     definitive CI failure/cancellation counts as a stage failure. With a
     no-PR outcome, ciConfirmed is inapplicable and the page may still be
     done.
- Failure semantics: a checkpoint exiting with failure increments
  stageFailures[that checkpoint]; **the same checkpoint failing
  consecutively policy.maxPageAttempts times (default 2)** ⇒ status=skipped
  (failureReasons records the last error code + summary), and the batch
  continues with the next page; a checkpoint success resets its
  consecutive counter. Tool-internal retries (self-healing retries of
  retryable errors) do not count as attempts.
- Resume: after a restart only pages with status ∈ {pending, active} are
  processed; skipped/failed pages are never retried automatically (unless
  the user explicitly resets). An active page recovers in order:
  ① initRequestId replay (§2.4) ② the §5.3 async review recovery protocol
  ③ **each checkpoint boolean is recomputed from on-disk evidence and
  overwrites state** (the init reservation file, the bound revision, run
  status, `git merge-base --is-ancestor`/`git log` for commits already
  present, the report file hash, `gh pr view`) — state.json is a cache,
  not the authority; disk evidence wins conflicts ④ commits/pushes already
  on the remote are not redone.
- Single-writer discipline: state.lock serializes same-batch drivers;
  batches share nothing.

### 8.4 End-of-batch deliverable

`docs/vwa-reports/batch-<batchId>.md`: ① a per-page table (page |
projectId | status | verdict eligible/deferred-pending/skipped | cost |
commit/PR links) ② the Pending human adjudication section (§4.5) ③ skipped
pages with reasons ④ cost totals and projectBudget consumption ⑤ when the
grant has expired with pages remaining: the re-grant command for resuming.

### 8.5 Grant hand-off

Batch start sequence: write manifest + grant-descriptor → ask the user to
run `/permissions grant .dsh/vwa/batches/<batchId>/grant-descriptor.json` →
no grant ⇒ abort before any page starts. The host derives goalId from the
active goal; a terminal goal auto-expires the grant.

## 9. Acceptance criteria (DoD)

1. End to end: a 44-page list + one instruction + one grant; the agent
   completes the §8 loop with zero interaction and produces the §8.4
   ledger.
2. init: returns {projectId, revision:1, workspaceIdentity}; same-requestId
   replay (including every crash window) creates no second project; payload
   mismatch is refused; the project directory layout matches `/vwa init`.
3. grant: in-scope git add/commit/push (compound commands with every
   segment matched), the six VWA tools, and writes inside writePaths are
   all approval-free; `git push --force`, `git reset --hard`, compound
   commands with an unmatched segment, and writes outside writePaths still
   ask; `.dsh/vwa/**` (except batches/) can never be granted for
   Edit/Write and defaults to ask; goal completion expires the grant; a
   contentScope violation auto-revokes it.
4. deferred: with a conflicting verdict, review/report are not blocked, the
   report carries the machine-deferred section, eligible=false; after
   `/vwa adjudicate` (with prevailingRunId) an as-of re-render — reject:
   needs-review lifts and eligible flips true; accept: the finding keeps
   its major force and eligible stays false (§4.4 semantics); superseded
   records render correctly.
5. budgets: exceeding projectBudget reports PROJECT_BUDGET_EXHAUSTED
   (concurrency-safe in-lock); skipAudit renders a truthful report with
   eligible=false; a later complete audit flips the semantics back.
6. as-of: freeze-before-fix + as-of re-render succeed with the diverged
   header; without evaluationId, behavior is byte-identical to today.
7. resume: after any page's interruption, done pages are not redone
   (disk-evidence reconciliation) and active pages continue per the
   recovery protocol.
8. skip: a page failing the same checkpoint twice is skipped and the batch
   continues.

## 10. Test plan

- Unit: init idempotency windows (pre/post reservation, post-init recovery,
  concurrent wx conflict); TaskGrant matcher (bare prefix/segment
  evaluator/LOW-only interaction/writePath realpath normalization/exclusion
  rejection); EscalationRegistry (token+commandHash binding/one-shot
  consumption/terminal cleanup/modeCeiling/reason-prefix fail-closed);
  contentScope (-z name-status parsing/rename/empty set/R100); the
  disagreementPolicy post-pass (deferred/blocking × with/without active
  adjudication, four quadrants); prevailingRunId effects and superseded
  rendering; liveness via either run; projectUsage in-lock reservation
  (concurrent admissions cannot overspend); skipAudit predicate consistency
  across the five sites; as-of layer-B skip; report-tool typed error
  mapping; atomic publication.
- Integration (preset real-boot family; the fixture uses the default frozen
  budget — any budget-semantics change must run it): init → update →
  review (deferred + skipAudit) → report (freeze + as-of) end to end.
- Permissions: grant match placement on the pre-execute chain (before LLM
  arbitration); escalation registry verification; goal-complete revocation;
  resume folding.
- Regression: every existing spec passes byte-identically without the new
  parameters.

## 11. Implementation slices

A (F1) argument.init + idempotency; B (F3) deferred + adjudication semantics
+ the liveness defect fix; C (F4) projectBudget + skipAudit; D (F5) as-of +
typed errors; E (F2) the TaskGrant chain (a separate PR — the permission
surface gets its own review); F (F6) the vwa-batch skill + contract
documents + batch-tail template. E runs parallel to A–D; F last.

## 12. Review ledger

- r1 full review (three seats, blind; the v1 draft): internal critic —
  GO-WITH-CHANGES, 12 findings; external reviewer A — NO-GO, 24 findings;
  external reviewer B — NO-GO, 11 findings. Divergence adjudicated as
  severity calibration (substance overlapped heavily); every finding
  evaluated by the implement-as-written test before folding. Two r1
  architecture pivots: grant creation moved from an agent tool to a
  user-typed slash command only (provenance of `createdBy:'user'` was
  forgeable through the fixed serviceAsk payload and the PermissionRequest
  hook path), and the as-of report redesigned around FrozenEvaluation
  (bind-time byte snapshots dropped).
- r2 delta verification: all r1 folds verified per seat; residual findings
  were fold-precision only (stale sentences, missing capability fields,
  predicate precision) — all folded. One cross-seat factual conflict
  (whether the escalation reason carries the requested mode) was settled by
  reading the harness source (escalation.ts:192 — it does).
- r3 micro-confirmation: internal critic — GO (3 minor residuals folded);
  external reviewer B — GO; external reviewer A — GO pending one stale
  sentence in §3.5 (contradicting §3.4's structured push matching), fixed
  and confirmed in an r3b single-item round.
- Scope honesty: r2/r3 verified the folds and their immediate context, not
  a fresh full-text review. All code anchors in this document were
  re-pinned against tree b3dfb054 by the orchestrator.
- User sign-off: pending.

## 13. Open questions

1. Grant UX: is a user-typed slash command acceptable (vs the dropped
   agent-initiated ask — we lose the auto-prompted approval popup but gain
   the unforgeable createdBy semantics)?
2. `/vwa adjudicate` arity growth (projectId + prevailingRunId) and its
   effect on existing user habits.
3. Is contentScope's conditional tracked-md-only default too tight for
   non-batch grant use cases?
4. Does the explicit evaluationFrozen checkpoint add too much ceremony
   between review and fix? (Alternative: render the first full report
   write:true before fixing and let the as-of re-render overwrite it.)
5. state.lock and genuinely concurrent sessions on one batch (is dual-driver
   support actually needed?).
