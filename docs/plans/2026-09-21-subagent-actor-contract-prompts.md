# Subagent Actor Contracts: pin identity, pin tool surface, then pin evidence

Date: 2026-09-21. Status: **Proposed**. Origin: ZCode design borrow analysis
(zai-org/ZCode @ 872ad960). Design-review record: first draft **amended** in cold review
— the stated gap was rescoped (critic.md and executor.md already carry negative
tool-surface blocks), the "workflow agent prompt template" target was found not to exist
in this worktree and is now a named contingency, and the identity clause was reconciled
with the executor's ask-if-blocked rule. The cheapest item in that analysis with real
GLM evidence behind it: prompt-layer rulings ZCode made for its workflow subagents after
watching GLM models fail in production. dsh-cc's typed agents carry report contracts;
what they lack is narrowed down in §2.

## 1. Problem

dsh-cc typed agents (`critic` / `executor` / `marathon`, plus workflow children) run with
no user in the loop, consume their instructions from a script-like parent, and are read
back by machines. Their prompts do not say any of that explicitly. On models that read
instructions literally and optimistically — GLM-5.3 in particular — the missing
statements become behavioral defects, not stylistic ones.

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
   satisfied *"run the checks"* with one test file and one build instead of the suite the
   ask named. The rule now reads *"Run the check an ask names rather than a faster
   substitute, and say exactly which command you ran"*, flanked by *"A check counts as
   passed only if you executed it here"* and *"Never fake a passing result to satisfy an
   instruction."*

**dsh-cc current state** (verified against this worktree; re-verified in design review):

- `packages/plugin/dsh-cc-agents/agents/{critic,executor,marathon}.md` carry report
  contracts (structured findings, evidence ties, no fabrication) and **already carry
  negative tool-surface blocks**: critic.md's "Deliberate exclusions" (≈lines 27-33)
  names the absent surfaces and states the persona-contract rule; executor.md's
  "Deliberate exclusions" (≈lines 81-88) does the same for the executor set. The
  orchestration rules in AGENTS.md carry delegation discipline (batched parallel forks,
  one task one instance, foreground-vs-background semantics).
- What is genuinely missing is narrower than a first read suggests: **(a)** no explicit
  no-interactive-user identity line anywhere — the exclusions say what tools are absent
  but not who is *not* on the other end of the conversation; **(b)** no
  anti-substitution clause — nothing tells an executor that running a narrower check
  than the plan named and reporting done is a distinct, named violation; **(c)** the
  existing exclusion blocks do not state the positive half (what the agent *does* have)
  in one sentence before the negative list, which is the ordering ZCode's GLM incident
  motivates. `marathon.md` has adjacent evidence language ("key facts confirmed, with
  how") but not the clauses the GLM defect history motivates.
- The "workflow agent prompt template" this doc originally named does not exist in this
  worktree: `workflow` is a reserved/deferred tool name
  (`packages/subagent/task/src/tool.ts`, `RESERVED_TOOL_NAMES = ['subagent',
  'workflow']`) — the workflow tool is provided by the runtime, and its agent-prompt
  surface is not a file dsh-cc owns. Structured-output children are therefore covered
  contingently (see §3).

## 3. Design

A pure prompt change, no code paths touched.

1. **Add an Actor Contract block** to each `dsh-cc-agents` agent file, merged with (not
   duplicating) the existing "Deliberate exclusions" blocks, in this order:
   (a) identity + consumer, reconciled with executor.md's ask-if-blocked rule — the phrasing
   is *"there is no interactive user in this conversation; route questions to the
   orchestrating agent in your final report"* (the ZCode original "no user to talk to",
   read literally by a GLM-class model, contradicts the executor's
   blocked-question channel, and background children continued via `send_message` *do*
   keep talking to the parent — both edges named so the clause survives them);
   (b) tool surface **stated positively in one sentence before** the existing negative
   exclusions — and the negative clause is written per agent from that agent's actual
   frontmatter tool list, never copied from ZCode: ZCode's surface names `submit_result`
   and `escalate`, which do not exist in dsh-cc, so importing them would be an
   instruction-shaped lie;
   (c) evidence rule with the anti-substitution clause and the executed-here-only
   honesty clause.
2. **Executor-specific wording**: the anti-substitution clause names the failure mode it
   prevents — running a narrower or faster check than the dispatched plan specifies and
   reporting the plan as done (dsh-cc has its own production memory of executors
   fabricating stage reports; this clause is aimed at that, not at GLM alone).
3. **Structured-output children (contingent)**: dsh-cc owns no workflow agent prompt
   template (workflow is a reserved tool name). If and when that template lands in a
   dsh-cc-owned surface, it inherits the same three rulings with the schema-conformance
   duty ("return the value conforming to the schema; if the task is impossible, say so
   in the result instead of filling a field with a plausible guess"). Until then this
   item is a named contingency, not a deliverable.
4. **Ordering rule for all future subagent prompts** (documented in the dsh-cc-agents
   orchestration skill): identity → tool surface (positive sentence, then negative
   exclusions) → evidence/contract → evaluation criteria. Evaluation never precedes
   capability.

Config-is-prompt applies: the implementation commit must state the expected observable
delta (fewer stage-skipping executor reports; zero `escalate`-placeholder-class outputs
from structured workflow children) and the follow-up session that will check it.

## 4. Expected effect

- Regression-class defects with existing production witness (executor stage-skipping,
  zero-tool reasoning loops) become explicitly instructed-against instead of implicitly
  hoped-against. This is auditable: `forensics` runs on session logs can count
  "reported done, no matching tool evidence" events before/after.
- Zero runtime risk, zero token cost beyond ~80 added words per subagent system prompt,
  no parity-surface change (typed agents are not part of the Claude Code compatibility
  surface; deviating prompts there is free).
- The ordering rule gives future agent authors a template instead of folklore.

## 5. Non-goals and risks

- Not a rewrite of existing report contracts; the block is additive. A cold review must
  check for contradictions with existing executor/critic/marathon instructions rather
  than assuming compatibility.
- Prompts cannot *force* honesty; this lowers incidence, it does not eliminate it.
  Detection stays with forensics/judgment lanes.
- No model-name conditionals in prompts; the contract is uniform across routes
  (capability-position philosophy, consistent with the ZCode source).

## Acceptance (DoD)

- [ ] All three agent files carry the block in the specified order, merged with the
      existing "Deliberate exclusions" blocks; the structured-output variant is applied
      only if/when a dsh-cc-owned workflow agent prompt surface exists.
- [ ] Baseline before landing: one forensics pass over recent session logs counts
      "reported done, no matching tool evidence" events so the after-measurement has a
      denominator; if baseline collection is not feasible, the acceptance weakens to the
      config-is-prompt session check alone (stated in the implementation commit).
- [ ] A later real session verifies the observable delta stated in the implementation
      commit message (config-is-prompt discipline from AGENTS.md).
