# @dsh-cc/retry-attendant

English | [中文](README.zh.md)

Verify-before-retry attendant: a post-execute listener for **mutating tool calls** whose outcome is ambiguous (timeout, sandbox denial, partial write, git/package mutation failure). It does two things (design doc [docs/plans/2026-10-09-verify-before-retry.md](../../../docs/plans/2026-10-09-verify-before-retry.md)):

- **M1 — ambiguous-outcome guidance**: on a classified ambiguous outcome, appends a one-line class-specific advice as an `additionalContexts` entry (source kind `retry-attendant`) — "verify the intended postcondition before re-running".
- **M2 — identical-retry escalation**: records the call's effect digest per session; an identical retry (same effect fields, ignoring reworded `description`/`timeoutMs`) within `expire-minutes` is escalated to a permission **ask** instead of passing through.

**Default ON** since 2026-10-16 (`retry-attendant.enabled: true`; promoted from ship-dark after a one-week production dogfood — 2,150 listener events with zero misfires attributable in the operator's transcript review).

## Settings (user layer only)

Key `retry-attendant` in the user-layer `settings.json`:

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master flag (default ON since 2026-10-16). |
| `guidance` | `true` | M1 advice lines. |
| `escalate` | `true` | M2 identical-retry asks. |
| `expire-minutes` | `10` | Digest-map expiry. |

## Status

Implemented. Failure-class table (`data/classes.json` + `classify`), effect-fields digest projection, pre-execute identical-retry escalation, and M1/M2 wiring are all in place, with composition pins in `packages/preset/cc`. Promoted to default ON on 2026-10-16 after the production dogfood cleared the design doc §5 gate; the escalation/observe split can be tuned via the `escalate` key.
