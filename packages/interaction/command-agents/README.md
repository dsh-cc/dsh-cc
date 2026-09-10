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
  stays continuable/resumable); short no-op explanation otherwise.
- `/agents attach <id>` — namespace reserved, not implemented (P1).

## Shared snapshot

`src/snapshot.ts` is a pure snapshot provider over injected services
(`subagents.listChildren` host-plane, `agents.get` registry, realm-interior
`resumePinStore`). The plugin mounts INSIDE the `cc-services` realm and
publishes the read-only `ccAgents` service on the ROOT context (CcPlugins
pattern), so the TUI local-slash path consumes the SAME snapshot. The preset
surface renders the thin detail only; the TUI adds fold-derived decorations
(provider/model, prompt excerpt, last stopReason) additively — the divergence
is deliberate and documented in the capability manifest.
