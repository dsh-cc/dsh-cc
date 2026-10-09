# @dsh-cc/retry-attendant

English | [中文](README.zh.md)

Verify-before-retry attendant: an opt-in post-execute listener for **mutating tool calls** whose outcome is ambiguous (timeout, sandbox denial, partial write, git/package mutation failure). It does two things (design doc [docs/plans/2026-10-09-verify-before-retry.md](../../../docs/plans/2026-10-09-verify-before-retry.md)):

- **M1 — ambiguous-outcome guidance**: on a classified ambiguous outcome, appends a one-line class-specific advice as an `additionalContexts` entry (source kind `retry-attendant`) — "verify the intended postcondition before re-running".
- **M2 — identical-retry escalation**: records the call's effect digest per session; an identical retry (same effect fields, ignoring reworded `description`/`timeoutMs`) within `expireMinutes` is escalated to a permission **ask** instead of passing through.

**Default OFF** (`retry-attendant.enabled: false`, dogfood-first).

## Settings (user layer only)

Key `retry-attendant` in the user-layer `settings.json`:

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Master flag, **opt-in**. |
| `guidance` | `true` when enabled | M1 advice lines. |
| `escalate` | `true` when enabled | M2 identical-retry asks. |
| `expireMinutes` | `10` | Digest-map expiry. |

## Status

Slice 1 (detection core): failure-class table (`data/classes.json` + `classify`), digest projection (`digestKey`), module augmentations. Listeners/wiring are a later slice. See the design doc for the full contract.
