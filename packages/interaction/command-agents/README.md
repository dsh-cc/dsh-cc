# @dsh-cc/command-agents

English | [中文](README.zh.md)

Human-facing `/agents` command for continuable background agents (plan
`docs/plans/2026-09-05-continuable-background-ux.md` §3.2, Slice 0 MVP).

## Surface

- `/agents` — grouped list (Working / Idle / Ready; residency only — no
  Blocked/Done groups), label-rendered rows, pin state incl. gate deny code.
- `/agents <id>` — thin detail: pin provenance (path, definition, model
  selector, workspace, gate evaluation), residency, ids.
- `/agents stop <id>` — one interrupt request on a running child (the child
  stays continuable/resumable); short no-op explanation otherwise. A released
  (or mid-release) child refuses with an explicit "cannot be continued here"
  copy instead of the resumable wording.
- `/agents release <id>` — evict the child's resident activation (and its
  resident descendants') through the harness drain seam; frees its capacity
  slot when it was running; cooperative (a cancel-resistant turn keeps its
  slot and the command reports the release as in flight); one-way in this
  session (same-session continuation is unavailable — the upstream
  cold-resume-after-drain gap); the persisted session survives on disk.
  Released rows render a process-local `[released]` tag in the list and a
  release line in the detail.
- `/agents attach <id>` — namespace reserved, not implemented (P1).

## Shared release core

`src/release.ts` is the single release operation shared by `/agents release`
and the model-facing `release_agent` tool (`@dsh-cc/subagent-task`): one
gate/drain/resolve/reject/timeout flow, one copy set, and one process-local
two-set marker (`releasing` / `released`), exported via the
`@dsh-cc/command-agents/release` entry. The `[released]` tag renders only
when a marker exists AND the row's residency is `ready` (registry-absent at
snapshot time) — never from the marker alone.

## Shared snapshot

`src/snapshot.ts` is a pure snapshot provider over injected services
(`subagents.listChildren` host-plane, `agents.get` registry, realm-interior
`resumePinStore`). The plugin mounts INSIDE the `cc-services` realm and
publishes the read-only `ccAgents` service on the ROOT context (CcPlugins
pattern), so the TUI local-slash path consumes the SAME snapshot. The preset
surface renders the thin detail only; the TUI adds fold-derived decorations
(provider/model, prompt excerpt, last stopReason) additively — the divergence
is deliberate and documented in the capability manifest.
