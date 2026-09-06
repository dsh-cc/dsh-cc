# @dsh-cc/subagent-resume-pins

Pinned resume descriptors ("resume pins") for continuable background subagents.
Design record: `docs/plans/2026-09-04-subagent-resume-pins.md`.

A cold resume of a background child (parent session disposed, then a new Context
boots over the same persistence root and `send_message` addresses the child)
restores the harness descriptor's headers — persona, tool filter, model route —
but drops every other spawn-time `AgentOptions` field, notably the alias-stamped
`reasoningEffort` and `maxTokens`. This package closes that gap: the spawn path
pins the child's effective runtime config to disk, and the resume path re-applies
it — visibly, never silently.

## What it mounts

One cordis plugin (`apply`) with:

- a **`PinStore`** (atomic per-child `<childId>.json` files under `pinsRoot`),
  published as the `resumePinStore` service so the Task plugin's spawn capture
  shares one cache with the gate and overlay;
- a **`tools/pre-execute` resume gate** on `send_message` to a pinned child with
  no live Activation: session existence (`PIN_ORPHANED`), pin readability
  (`PIN_UNREADABLE`), workspace existence/identity (`WORKSPACE_MISSING`,
  `WORKSPACE_CHANGED`), definition re-fingerprint (`DEFINITION_CHANGED`), pinned
  tool availability (`PINNED_TOOL_UNAVAILABLE`), and pinned-route availability
  (`SUBAGENT_MODEL_UNAVAILABLE`) — every deny persisted into the pin
  (`resume.state='blocked'`) **before** the deny returns;
- an **`agent/request` overlay** applying the pinned
  `{provider, model, reasoningEffort, maxTokens}` tuple field-by-field
  (absence included) to every resumed turn, whatever resumed it;
- **`tools/post-execute`** notice prefixing on `send_message` and
  `resumeState`/`definitionChanged` annotation on `list_agents`;
- the **`subagents-resume` settings namespace** (kebab-case) with the policy
  knobs `onUnavailableModel`, `onDefinitionChanged`, `onWorkspaceChanged`
  (`resume-with-notice` defaults, `block` opt-in, `route-current` fallback for
  the model route; the always-block conditions have no safe fallback).

Zero-op when unmounted: pins are simply unread and behavior is the legacy
behavior. Only pinned children are affected; a missing pin is a legacy/foreign
child (pass-through) and same-epoch followups to a live Activation are untouched.

## Composition

The cc preset mounts the row (`cc-resume-pins`, inside the `cc-services` isolate
group) with `pinsRoot: !!js dshHomePath('sessions', 'resume-pins')` — colocated
with the harness base patch's jsonl session-persistence root — **before**
`tool-task`, whose spawn capture prefers the shared service store. Standalone
consumers may instead pass `resumePins: { pinsRoot }` to the Task plugin config.
