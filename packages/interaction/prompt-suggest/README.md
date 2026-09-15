# @dsh-cc/prompt-suggest

English | [中文](README.zh.md)

Next-prompt suggestion: at `agent/turn-stopping` the plugin fire-and-forgets one cheap-lane side query (`@dsh-cc/side-query`) asking for the user's likely next message given the last exchange (user prompt + final assistant text, each capped at 2 KiB). The prediction — plain text, ≤ 120 characters — is stored in a **module-level registry** keyed by session id with a 5-minute TTL and surfaced by the interactive TUI's autocomplete provider. **Default OFF** (`cc-prompt-suggest.enabled: false`, opt-in): a user who never enables the feature sees zero adapter calls and zero suggestion items.

## How it works

The listener decides synchronously (enabled gate, session id, disabled-clear) and spawns a void promise — turn-stop is never awaited or blocked (memory-consolidation precedent). `runSideQuery` composes the `timeoutMs` budget with the plugin's dispose signal via `AbortSignal.any`; every failure shape (`timeout`/`error`/`unrouted`) keeps the registry's prior value, while an `empty` verdict (the model's "no confident prediction") clears it. A whitespace-only answer maps to `empty`.

The registry is module-level (not per-context) so the TUI's re-instantiation of its autocomplete provider can never lose a stored suggestion. **Same-process assumption:** the interactive TUI reads the registry via a plain import; if the TUI ever runs out-of-process, the registry is simply empty there and the feature no-ops — fail-soft by construction. `getSuggestion(sessionId)` is the only read surface: it returns `undefined` when absent, expired, or never written (which includes every disabled session — the disabled producer writes nothing and clears any prior entry at the next turn-stop).

## TUI surface (prefix-match-only)

The vendored pi-tui Editor consults the autocomplete provider only on trigger characters (`/`, `@`) or forced Tab — never on empty input (probed at implementation; see the comment at the prediction branch in `packages/ui/tui/src/components/completion.ts`). The shipped surface is therefore **prefix-match-only**: type the first characters of the stored prediction on an empty-ish line, then complete (Tab). Selecting the item replaces the current line with the full suggestion.

## Settings

Namespace `cc-prompt-suggest`:

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Master flag, **opt-in**. Read live at every turn-stop; disabling makes no adapter call and clears the session's stored suggestion. |
| `alias` | `haiku` | Cheap-lane alias consulted through `ccModelRoutes`/`resolveAlias`; unconfigured inherits the parent route (fail-soft). |
| `timeoutMs` | `4000` | Wall-clock budget for the prediction; composed with the plugin dispose signal. |
| `maxTokens` | `128` | Token budget for the prediction. |

## Shape

Plain cordis plugin (publishes no Service — reasoning-fold pattern; no isolate key). Registers nothing when the settings provider is absent. Mounted by `packages/preset/cc` in the cc-services group; `packages/ui/tui` consumes `getSuggestion` as a workspace dependency.
