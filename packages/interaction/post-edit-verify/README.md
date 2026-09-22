# @dsh-cc/post-edit-verify

English | [中文](README.zh.md)

Post-edit auto-verify: after an accepted `edit`/`write` result, the plugin runs a user-declared fast verification command through the harness ShellExecutor and **appends** its outcome (`[auto-verify]` text block) to the **same** tool result — one observation covers both events, so a failed verify surfaces without an extra model round-trip. **Default OFF** (`cc-post-edit-verify.enabled: false`, opt-in).

## How it works

The plugin registers a `tools/post-execute` listener (plain plugin, no Service, no isolate key) that composes inside context-crusher's outermost post-execute listener — the listener is registered **without prepend**, so crusher stays outermost and the appended text stays crusher-eligible downstream. On every accepted `edit`/`write` result the listener re-reads the raw user-layer settings file (hot reload, a few KB), picks the first rule whose CC path glob matches the edited path (evaluated relative to the session cwd when the path sits under it), and runs the rule's command with the session cwd as the working directory. A non-zero exit appends a failure tail; success is near-silent — a one-liner `[auto-verify] <command> — ok (<n>ms)` — unless `verbose-on-success` is set. A skipped or overlapped run is always labeled (burst marker), never silent.

## Settings (user layer only)

Key `cc-post-edit-verify` in the **user-layer** `settings.json` (the harness-home file). Project-scope rules are **never read** — verify rules are a personal productivity setting, not a project artifact; a rule authored only in a project's settings is invisible (structurally, not "refused").

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Master flag, **opt-in**. |
| `rules` | `[]` | Array of `{ glob, command, timeout-ms? }`; first match wins. |
| `debounce-ms` | `5000` | Burst **labeling** window only — every matching edit still runs; a run inside the window gets a `burst — result may overlap edits` label. |
| `max-output-bytes` | `4096` | Tail-keeping capture budget for the verify output. |
| `verbose-on-success` | `false` | By default success is near-silent (one-liner only). |
| `timeout-ms` (per rule) | `60000` | Per-rule timeout, capped at `120000`. |

## Command environment

Rules run in a **POSIX shell** (`sh` semantics) — no Windows-native syntax. The command runs through the harness ShellExecutor, killed at its timeout; a timed-out or signal-killed run appends nothing (the edit result stays exactly as before). Node one-liners (`node -e "…"`) are a good cross-platform authoring style.

## Shape

Plain cordis plugin with `inject = ['shell']` (tool-use-summary / prompt-suggest idiom). Mounted by `packages/preset/cc` in the cc-services group. Fail-soft: every fault degrades to a passthrough — the user's tool result is never turned into an error.

## Dogfood (dsh-cc contributors)

Opt-in only — see [docs/dogfood/post-edit-verify.md](../../../docs/dogfood/post-edit-verify.md) for user-layer settings, intentional-fail reproduction, and the package tests that lock `[auto-verify]` observability.
