# @dsh-cc/edit-recovery-hint

English | [中文](README.zh.md)

Edit recovery hint: when the `edit` tool fails with a not-found error on a multi-line `old_string`, the plugin appends a **fixed, static** recovery-advice message to the same tool result as an `additionalContexts` entry — model-visible sideband context (the harness deferContext loop forwards it after the tool result is finalized), without rewriting any tool-result content. **Default OFF** (`cc-edit-recovery-hint.enabled: false`, opt-in).

## How it works

The plugin registers a `tools/post-execute` listener (plain plugin, no Service, no isolate key). On an edit result that is an error, the listener re-reads the raw user-layer settings file (hot reload, a few KB), and when the failed call carried a multi-line `old_string` and the result text is the not-found failure, it appends one `additionalContexts` UserMessage whose text is the constant `RECOVERY_HINT`: retry with a single-line anchor, or split into one edit per hunk; only if the anchor also fails, re-read just the target region (offset/limit).

The hint text is **static only** — no tool output, file bytes, or argument fragments are ever interpolated into it, so a hostile payload in tool output cannot steer the appended message. The ambiguity failure (`old_string appears more than once`) is deliberately not matched: there the string did match, so anchoring advice would misfire.

## Settings (user layer only)

Key `cc-edit-recovery-hint` in the **user-layer** `settings.json` (the harness-home file). Project scope is **never read** — invisible, not refused.

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Master flag, **opt-in**. |

## Shape

Plain cordis plugin (no Service, no isolate key). Mounted by `packages/preset/cc` in the cc-services group, immediately after post-edit-verify. Fail-soft: every fault degrades to a passthrough — the user's tool result is never turned into an error, and the decision content is never mutated.
