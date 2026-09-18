---
name: data-analysis
description: Meta-rules for orchestrating data-analysis tasks through the critic/executor pattern. Triggers — 数据分析 (data analysis), 利用率查询 (utilization query), 资源盘点 (resource inventory), 口径 (metrics caliber), 对账 (reconciliation), data analysis, reconciliation, utilization query, metrics caliber. Use when a task runs queries against a data platform, doubts or cross-checks metric calibers, or delivers a data report — route it per §D and inline §A-§C into the dispatch prompts.
---

# Data-analysis orchestration meta-rules

Self-contained process discipline for data-analysis tasks. All domain
knowledge (dataset contracts, calibers, pitfalls, query scripts) lives in the
target workspace's own docs and skills; this skill adds none. The
orchestrator inlines the relevant sections into each dispatch prompt and
points subagents at the workspace files by workspace-relative path —
subagents start fresh, have `Read` but no skill tool, and cannot see this
skill.

## §A Review meta-rubric (inline into critic dispatches)

- Does the spec identify the workspace's data-access contract and cite the
  matching workspace-local skill or doc? If nothing matches, is it a
  genuinely new query or a trigger-keyword gap?
- Is the caliber routing correct per the workspace's own contract document?
  The critic never invents calibers.
- Does the spec state numeric expectations (magnitude, trend direction,
  cross-check relationship)? A result without expectations is unreviewable:
  reject and bounce back to the orchestrator rather than inventing them.

## §B Verification discipline (inline into executor dispatches)

- Every numeric result ships with: full query parameters (dataset / region /
  date window / filters, or the workspace's equivalents), row count, and the
  spec'd cross-check result.
- Cross-checks prefer a second independent caliber or dataset; absent one,
  fall back to time-series sanity (deltas, magnitude jumps).
- The executor reports numbers and deltas, never interpretations;
  interpretation belongs to the orchestrator/critic.

## §C Execution discipline (inline into executor dispatches)

- Iron order: preflight (auth/permission state per the workspace contract)
  → find the matching workspace skill's existing scripts → reuse →
  hand-write only on a genuine gap.
- For endpoints the preflight doesn't cover: a minimal probe (smallest
  possible query) confirms reachability and permissions — never stall,
  never guess.
- Before hand-writing anything, read the workspace's data-contract and
  pitfalls docs; on zero rows or errors, match the trap checklist and retry
  once before re-deriving.
- Throttling discipline: lightweight queries, sequential execution, backoff
  on failure; never hammer a query API concurrently.
- Honest guardrail framing: where the data path is read-only, these rules
  protect against wrong numbers, not damage; where writes exist, they must
  be explicit in the spec.

## §D Routing (the orchestrator's own rule)

- Escalation threshold: routine single-caliber query → the workspace's own
  skill, a single agent. Caliber doubt / reconciliation / external
  deliverable → multi-agent.
- Multi-agent loop: the orchestrator decomposes and lifts numeric
  expectations from the workspace's skill/contract docs into the spec
  (expectations are the orchestrator's to supply; the critic only verifies)
  → critic reviews with §A inlined plus path pointers → executor executes
  with §B/§C inlined plus path pointers → orchestrator synthesizes.
- Report delivery goes through the workspace's own skills, never through
  multi-agent wrapping.
