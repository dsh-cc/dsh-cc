# Subagent Actor Contracts: pin identity, pin tool surface, then pin evidence

Date: 2026-09-21. Status: **Implemented** — PR #98 (merged 2026-09-21), config-is-prompt
follow-up verification outstanding (§4). Origin: ZCode design borrow analysis
(zai-org/ZCode @ 872ad960).

Design-review record:

- **First draft amended in cold review** — the stated gap was rescoped (critic.md and
  executor.md already carry negative tool-surface blocks), the "workflow agent prompt
  template" target was found not to exist in this worktree and is now a named
  contingency, and the identity clause was reconciled with the executor's
  ask-if-blocked rule.
- **Second amendment (2026-09-21, gating directive)** — the owner directed that the
  contract must be enabled for *specific models only* (the motivating evidence is
  GLM-family literalism; dsh-cc routes all models). This supersedes the original
  "no model-name conditionals, uniform across routes" non-goal (deviation from the
  ZCode source, justified below). A second cold review adjudicated the mechanism:
  marked block in the agent definition files + a strip/gate helper applied at the
  two spawn seams where the resolved model id is already in scope. All findings of
  that review are folded into §2–§6.

## 1. Problem

dsh-cc typed agents (`critic` / `executor` / `marathon`, plus workflow children) run with
no interactive user in the loop, consume their instructions from a script-like parent,
and are read back by machines. Their prompts do not say any of that explicitly. On
models that read instructions literally and optimistically — GLM-5.3 in particular — the
missing statements become behavioral defects, not stylistic ones. Because the evidence
base is GLM-specific while dsh-cc is model-agnostic, the contract ships behind a
model gate (§3.2) rather than unconditionally.

## 2. Current state and gap

**ZCode's three rulings, each with production evidence** (anchors from the borrow
analysis, clone commit 872ad960):

1. **Pin the identity first.** The workflow actor prompt opens with *"A script created
   you and hands you work one ask at a time; the script — not a person — consumes what
   you return. There is no user in this conversation to talk to."*
   (`packages/core/src/context/sections/workflow-actor.ts`). ZCode's note: for a
   subagent, "You are ZCode, an interactive coding agent" is the *wrong* identity and
   was removed from the first line.
2. **State the tool surface before demanding evidence.** Zero-tool GLM subagents that
   were told *"Ground every claim in something you read or ran"* tried to read
   directories and run commands they did not have, then emitted a degenerate
   `escalate("placeholder")`. The fix orders the tool self-description **before** the
   evidence rule, including the negative half: *"There is no tool that asks a person
   anything."*
3. **The evidence rule carries an anti-substitution clause.** Production GLM children
   satisfied *"run the checks"* with one test file and one build instead of the suite
   the ask named. The rule now reads *"Run the check an ask names rather than a faster
   substitute, and say exactly which command you ran"*, flanked by *"A check counts as
   passed only if you executed it here"* and *"Never fake a passing result to satisfy an
   instruction."*

**dsh-cc current state** (re-verified 2026-09-21 against this worktree):

- `packages/plugin/dsh-cc-agents/agents/{critic,executor,marathon}.md` carry report
  contracts and negative tool-surface blocks: `critic.md` "Deliberate exclusions"
  (lines 26-42) and `executor.md` "Deliberate exclusions" (lines 82-92).
  **`marathon.md` has no exclusions section** — it receives a standalone block (§3.4).
- What is genuinely missing: **(a)** no explicit no-interactive-user identity line
  anywhere — the exclusions say what tools are absent but not who is *not* on the
  other end; **(b)** no anti-substitution clause; **(c)** the exclusion blocks do not
  state the positive half (what the agent *does* have) in one sentence before the
  negative list — the ordering ZCode's GLM incident motivates.
- `executor.md:23` currently says *"Ask only if blocked: ... ask one precise question
  instead of guessing"* — an open contradiction with any "no user" statement unless
  rewritten (§3.4 directs the edit; the amendment reconciles rather than drops the ask
  channel: background children continued via `send_message` *do* receive answers).
- The "workflow agent prompt template" does not exist in this repo: `workflow` is a
  reserved tool name (`packages/subagent/task/src/tool.ts`, `RESERVED_TOOL_NAMES =
  ['subagent', 'workflow']`); the workflow tool is the external harness package
  `@deepseek-ai/dsh-tool-workflow`. Harness source is read-only by owner directive, so
  structured-output children are covered contingently (§3.6).

**Spawn seams where the resolved model id sits next to the persona** (the gate's hook
points, verified):

- Task dispatch: `packages/subagent/task/src/tool.ts` resolves
  `ccModelRoutes.resolve(definition.model)` (~line 302-303) and folds
  `persona: definition.systemPrompt` (~line 346-349). Background spawns route through
  the same package (`background-start.ts`).
- Plugin provider: `packages/compat/cc-plugin-loader/src/agents.ts`
  `AgentProvider.start` resolves the model override (~lines 144-153) and forwards
  `prompt: this.agentDefinition.systemPrompt` (~line 124).
- Both seam packages already depend on `@dsh-cc/claude-code-agents`
  (`packages/preset/claude-code-agents`), the parser/types owner — the shared helper
  lives there, so no new package is created.
- Resolver fallback fact (`packages/compat/cc-model-aliases/src/resolver.ts`,
  ~lines 239/269-274): unresolved frontmatter tokens fall through as literals, so when
  no alias service is mounted the raw token *is* the resolved id — the gate's fallback
  rule falls out naturally.
- System-prompt section assembly (identity/output-style waterfall) is harness-owned and
  unreachable; the gate can only act on the persona string. Acceptable: the agent
  definition body *is* the persona (parse.ts:143-148, verbatim).

## 3. Design

### 3.1 Mechanism: marked block + strip/gate at the spawn seams

The contract text is **authored in the agent definition `.md` files** (co-versioned with
the persona it belongs to, per "config is prompt"), wrapped in a marker pair:

```
<!-- actor-contract:start -->
## Actor and evidence contract
...
<!-- actor-contract:end -->
```

A shared pure helper `applyActorContract(persona, candidates, patterns)` in
`packages/preset/claude-code-agents` (new `src/actor-contract.ts`, exported):

- **Always removes the marker lines** (they are an authoring convention, never prompt
  content), then **keeps the block content iff any candidate matches any pattern**,
  otherwise removes the content too. Stripping collapses the excised region cleanly
  (no leftover blank-line runs).
- `candidates`: the resolved route model id (lowercased) and, when it differs, the raw
  frontmatter `model:` token (lowercased). Inherit/undefined model → no candidates →
  strip (feature off; documented fail-closed).
- `patterns`: glob list from settings (§3.2); matching is case-insensitive, `*` is the
  only wildcard, exact literal match otherwise. A ~10-line anchored-regex helper; if a
  glob matcher already exists in-repo, reuse it.
- Parse-time validation in `parse.ts`: an unterminated or mis-nested marker pair in a
  definition file throws a descriptive load error — silent prompt corruption is worse
  than a loud failure.

Applied at every persona-application point: the Task dispatch fold in
`packages/subagent/task/src/tool.ts` (:346-349 — the fold happens once upstream of both
foreground and background spawns; `background-start.ts` only forwards the already-folded
persona, so background needs no own gate call), the worktree-isolation persona
construction at `packages/subagent/task/src/worktree-isolation.ts:416` (it builds its
persona from the raw `definition.systemPrompt` *before* the fold exists, so it must
apply the gate itself), and `AgentProvider.start` in
`packages/compat/cc-plugin-loader/src/agents.ts` (:124). A grep for
`definition.systemPrompt` in `packages/subagent/task` during implementation must confirm
this enumeration is still complete.
Persona inputs with no markers are byte-identical in and out (snapshot-pinned), so
ungated agents and unmodified plugins are untouched. The fork path applies no persona,
so it is a no-op by construction.

Ordering is preserved because the block is authored inline: identity line first, then
the marked block, then strengths/how-to-work — ZCode ruling 1 (pin identity first) is
the one with direct GLM production evidence, so the block belongs at the top, not
appended at the bottom.

### 3.2 Gate configuration

New settings namespace `actor-contract` (kebab-case per dsh-settings discipline):

```jsonc
{ "actor-contract": { "models": ["glm-*"] } }
```

- Schema `{ models: string[] }`; **default `['glm-*']`** — matches the GLM evidence base
  and the owner's directive; operators set `[]` (off everywhere) or `['*']` (uniform,
  restoring the original uniform-contract intent).
- The gate compares patterns against the resolved concrete model id (alias-aware), with
  the raw frontmatter token as fallback — never against the alias name alone.
- Installed via `installSectionSafe` (absence-preserving idiom) from **both** seam
  packages so either mount order wins and hot reload (settings publish seam) reaches
  both readers — the multi-owner semantics (`settings-ns/src/index.ts` :219-244) give
  the second owner a live `setSource` plus `settings/updated` fan-out. Gate state is
  read at spawn time, so mid-session edits apply to the next spawn. Both seam packages
  gain a `@dsh-cc/settings-ns` workspace dependency edge (neither has one today).
- The task plugin additionally publishes its gate as the `ccActorContractGate` cordis
  service (resume-pin re-fingerprinting reads it duck-typed, defaulting to
  `['glm-*']` when unmounted). Because `cc-subagent-task` is a preset row, that
  service MUST sit behind the cc-services `isolate` realm in
  `packages/preset/cc/agent.cordis.yml` — a preset row cannot publish a
  process-global service (preset mount guard);
  `pnpm smoke:profile-boot` is the gate that catches a missing isolate key. The
  plugin-loader duplicate publishes NO service (a duplicate provide would throw on
  co-mount).
- The schemastery schema and the `installSectionSafe` call live in the seam packages
  (settings consumers), **never** in `@dsh-cc/claude-code-agents`: that package stays
  pure (string helpers + parse-time marker validation only; its README declares "no
  harness runtime involved" and its only dep is js-yaml). Its README.md/README.zh.md
  export lists gain the new helper per package convention.
- Not an `AliasTarget` attribute: aliases are routes, and the gate must also cover the
  inherit case where no alias row exists.
- Deviation from ZCode's uniform-application philosophy, justified: the contract text
  is GLM-tuned (literal, unhedged phrasing) and dsh-cc ships prompts for models whose
  calibration the ZCode evidence says nothing about. The block is still *written* to be
  model-neutral hygiene (wording constraint in §3.3), which caps the blast radius of
  every leak path in §5.

### 3.3 Block content (authoring constraints)

Per agent, hand-written, in this order inside the marked block: **(a)** identity +
consumer, **(b)** tool surface — one positive sentence before the negatives — **(c)**
evidence rule. Wording must be GLM-literal (no metaphor, no hedges) yet harmless if it
ever leaks to other models (it can — see §5). Directives:

- **(a) identity, all three agents** (supersedes the ZCode "no user to talk to" phrasing,
  which read literally would forbid the one legitimate ask channel):

  > A script — the orchestrating agent — created you and hands you work one ask at a
  > time. What you return is read by that script and acted on mechanically; there is
  > no interactive user in this conversation. If you need a decision only a person can
  > make, say so in your result; if you need information the orchestrator has, ask it
  > directly in the report you return — it can answer and continue you — rather than
  > guessing.

- **(b) tool surface**, one positive sentence before negatives, per agent:
  - critic: read-only set — files, search, symbol navigation, one reasoner; cannot
    modify anything; no tool that asks a person anything; every shipped conclusion must
    be reachable from what was read in this run.
  - executor: file-edit, search, and shell tools; no tool that asks a person anything
    and no tool that shows the report to a user; the orchestrator reads it as text.
  - marathon: same shape as executor plus: no tool that schedules work for later; you
    are the whole run.
  - The negative half names *behaviorally absent* surfaces. **Never auto-derived from
    the frontmatter list** — the load-bearing negative ("no tool that asks a person")
    has no mechanical counterpart in a tool list, and enumerating ~20 present tools
    burns tokens to say nothing. Never copied from ZCode either: its surface names
    `submit_result`/`escalate`, which do not exist in dsh-cc — importing them would be
    an instruction-shaped lie.
- **(c) evidence**:
  - all agents: ground every claim about the repo in something read or run *in this
    run*; report the command or file:line for each load-bearing claim.
  - executor additionally gets the anti-substitution clause aimed at the named failure
    mode (dsh-cc has its own production memory of executors fabricating stage reports):

    > Run the check the dispatched plan names rather than a faster substitute, and say
    > exactly which command you ran. A check counts as passed only if you executed it
    > in this run. Never report a stage done that you did not execute.

### 3.4 Placement and reconciliation edits in the three agent files

- The marked block goes **immediately after the frontmatter identity paragraph** in all
  three files, merged with the existing "Deliberate exclusions" where present (critic,
  executor); `marathon.md` receives a standalone block (it has no exclusions section).
- `executor.md:23` is rewritten (applies to all models, independent of the gate —
  pure reconciliation hygiene):

  > **Ask only if blocked**: If the task is genuinely ambiguous, ask the orchestrating
  > agent one precise question and wait — it can answer and resume you. If you are not
  > blocked, state your assumptions in the report instead of asking.

### 3.5 Ordering rule for future subagent prompts

Documented in `packages/plugin/dsh-cc-agents/skills/dsh-cc-agents-orchestration/SKILL.md`:
identity → tool surface (positive sentence, then negative exclusions) →
evidence/contract → evaluation criteria. Evaluation never precedes capability. Mention
the marker convention so future agent authors know the contract is gateable.

### 3.6 Structured-output children (contingent)

Unchanged from first review: dsh-cc owns no workflow agent prompt template. If and when
that template lands in a dsh-cc-owned surface, it inherits the three rulings with the
schema-conformance duty ("return the value conforming to the schema; if the task is
impossible, say so in the result instead of filling a field with a plausible guess").
Until then this item is a named contingency, not a deliverable.

### 3.7 Resume-pin fingerprint

`packages/subagent/resume-pins/src/fingerprint.ts` hashes
`definition.systemPrompt` — the *pre-gate* text. A gate toggle then changes the
effective persona with no resume-drift signal. Preference order at implementation:
**(1)** hash the *applied* persona (post-strip, post-worktree-append) at the capture
site if that string is reachable there — this also future-proofs any other persona
mutation; **(2)** fold the gate decision (matched patterns + candidates) into the hash
input alongside the definition hash. Whichever ships, the behavior is test-pinned
(gate toggle changes the fingerprint); shipping with the blind spot undecided is not
allowed.

## 4. Expected effect

- Regression-class defects with existing production witness (executor stage-skipping,
  zero-tool reasoning loops) become explicitly instructed-against on gated models
  instead of implicitly hoped-against.
- Runtime risk is confined to prompt-text mutation at the two seam families plus
  parse-time validation, all covered by unit + integration snapshot tests. Personas of
  non-gated models are byte-identical to today (snapshot-asserted).
- Token cost (~80 words) is paid only by gated models.
- The ordering rule gives future agent authors a template instead of folklore.
- Config-is-prompt discipline: the implementation commit message must state the
  observable delta — "gate-matching subagent spawns (Task and plugin-provider paths)
  receive the actor-contract block; all other models' personas are byte-identical to
  pre-change (snapshot-asserted). Follow-up verification: one GLM-routed executor
  dispatch on a plan naming a specific check; confirm the named command appears in the
  child's evidence" — and a later real session verifies it.

## 5. Non-goals and risks

- Not a rewrite of existing report contracts; the block is additive.
- Prompts cannot *force* honesty; this lowers incidence, it does not eliminate it.
  Detection stays with forensics/judgment lanes.
- **Version-skew marker leak**: an old core + new plugin definitions has no stripper,
  so markers (HTML comments — models skip them) and the model-neutral block text reach
  every model. Accepted, mitigated by the §3.3 wording constraint; documented here so
  the skew window is a known state, not a discovery.
- **Gate evaluated against the wrong string** (alias name instead of resolved id, or
  missing the no-service literal fallback) silently never/always fires. The §Acceptance
  test matrix is the guard; this is the most likely silent production bug.
- Fork sessions inherit the parent's context and apply no persona — the contract is a
  no-op there by construction, which is correct (forks are continuations, not fresh
  actors).

## Acceptance (DoD)

- [ ] `applyActorContract` unit tests: markers always removed; content kept on match,
      removed on mismatch; empty block; multiple blocks; no-marker input byte-identical.
- [ ] Parse-time validation: unterminated/mis-nested markers in a definition file throw
      a descriptive load error.
- [ ] Glob matcher tests: `glm-*` hits `glm-4.7` and `GLM-4.7` (case-insensitive),
      misses `gpt-5`; bare `*`; literal exact.
- [ ] Task-seam integration (fixture `ccModelRoutes` mapping e.g. `sonnet → glm-4.7`):
      dispatched executor persona contains the block; with `sonnet → claude-*` the
      persona is byte-identical to pre-gate (snapshot). Worktree-isolation path
      (`worktree-isolation.ts:416` building from the raw definition) covered the same
      way — a marked definition with `isolation: worktree` must not leak markers or the
      un-gated block. Plugin-loader seam (`resolveModelOverride`) covered likewise.
      Bare-context literal-token fallback (`model: glm-4.7` with no alias service)
      keeps the block; inherit (`model` undefined) strips it.
- [ ] Fingerprint: toggling `actor-contract.models` changes the resume-pin fingerprint
      (mechanism per §3.7; the choice is recorded in the implementation commit).
- [ ] The three agent files carry the marked block in the specified order (marathon as
      a standalone block); `executor.md:23` rewritten per §3.4; block wording follows
      §3.3 directives.
- [ ] The orchestration SKILL.md carries the §3.5 ordering rule and the marker
      convention.
- [ ] `docs/claude-code-capabilities.yaml` gains entry **`settings.actor-contract`** —
      placed **first** within the settings category block (I7 lexical sort: it precedes
      `settings.hot-reload`), modeled on that entry's mechanics: same-category plane
      (not preset — the install lives inside already-mounted plugins, so no
      `agent.cordis.yml` anchor exists, and I4's evidence requirement is met by the new
      seam-package spec files), and I3-honest dimensions (no `ux: full` without
      `behavioral: full`). `pnpm docs:parity` regenerated matrix/README/capabilities.json
      are committed together (`pnpm check:capabilities` + `check:parity` green).
- [ ] Baseline-forensics checkbox from the first draft is **dropped**: dsh-cc session
      logs are not systematically retained and a GLM-routed subagent corpus may not
      exist here, so there is no denominator. The acceptance instead rests on the
      deterministic persona snapshots above plus the config-is-prompt session check
      stated in the implementation commit message.
- [ ] The implementation commit message contains the config-is-prompt observable-delta
      statement from §4 (verifiable as text in the commit body).
- [ ] **Post-merge follow-up (non-blocking)**: a later real session verifies the
      observable delta from the commit message (config-is-prompt discipline from
      AGENTS.md); no in-repo GLM route is guaranteed, so this is a commitment, not a
      merge gate.
