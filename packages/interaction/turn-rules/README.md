# @dsh-cc/turn-rules

English | [中文](README.zh.md)

Turn rules: a non-interrupting rule engine that fires only when the model goes off-script. A Cursor-plugin rule carrying a `trigger` pays zero context until that regex matches a completed tool call/result or a user prompt; on the first match the rule body is injected as an **advisory reminder** at exactly that seam. **Ship-on with zero effect** (`cc-turn-rules.enabled: true`) — zero trigger-bearing rules exist by default, so enabling is behavior-neutral.

## How it works

The plugin re-discovers the installed+enabled cursor-plugin rules corpus at mount (`apply()` snapshot) via `@dsh-cc/plugin-loader` and registers three listeners (plain plugin, no Service, no isolate key):

- **`tools/post-execute`** — after the downstream decision (composed after the context-crusher, so the matched text is the post-crush text the model will actually receive), it serializes a bounded unit — `JSON.stringify(exec.arguments)` + the accept's text content — UTF-8-truncated to 200 KB, and evaluates trigger-bearing rules over it. Each newly firing rule appends one `additionalContexts` UserMessage to the SAME accept decision; the result `content` is never rewritten.
- **`agent/pre-step` + `agent.inject`** — the prompt channel: candidate text built from non-injected messages (injected `turn-rules` messages are denylisted — a rule can never match its own reminder), deduped per pending text; each firing rule is injected as one attributed message (`source.kind: 'turn-rules'`, rendered like memory-recall bodies — never "hidden").
- **`agent/turn-stopping`** — bumps the per-session turn counter and persists the fired-state ledger.

Fired state lives in `$DSH_HOME/turn-rules/<sessionId>.json` (`{ version, turnCounter, fired: { ruleKey: firedAtTurn } }`, atomic temp+rename writes); an in-memory per-session map is the authoritative double-fire gate. Repeat policies: `repeat: once` (default) or `repeat: after-gap` with `repeatGap` turn stops (default 10). Both channels are top-level-only — subagent executions never fire or consume session rules.

All failure modes fail open: any internal fault degrades to a passthrough plus a debug counter; a listener can never turn a tool result into an error.

## Rule frontmatter

```yaml
---
description: Prefer Arc<str> over Box::leak in production paths
trigger: \bBox::leak\b          # JS regex source; quote it if it contains YAML-significant characters
triggerOn: [tool-results, user-prompts]   # default: both
repeat: once                    # once | after-gap (default: once)
repeatGap: 10                   # turn stops before re-arm; default 10
---
```

Rules without a `trigger` are byte-for-byte unaffected (index/system-prompt behavior unchanged).

## Settings (user layer only)

Key `cc-turn-rules` in the **user-layer** `settings.json` (the harness-home file). Project scope is **never read** — invisible, not refused.

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master flag. |
| `max-result-bytes` | `200000` | UTF-8 truncation cap for the matching unit. |
| `regex-cache-size` | `64` | Compiled-regex LRU capacity. |
| `judged.enabled` | `false` | Phase-2 LLM-judged rules; flagged off. |

## Shape

Plain cordis plugin (no Service, no isolate key). Mounted by `packages/preset/cc` in the cc-services group, directly after edit-recovery-hint (and therefore after the context-crusher: CCR outermost, turn-rules composed after it). Injections are advisory only — this engine never blocks a tool call.
