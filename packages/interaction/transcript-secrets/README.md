# @dsh-cc/transcript-secrets

English | [中文](README.zh.md)

One-way secret redaction for transcript boundaries: `/export` output and the context-crusher's externalized store are scrubbed of pasted credentials before they leave the session.

## Usage

```ts
import { redact, readSecretsSettings, resetForTests } from '@dsh-cc/transcript-secrets'

const { text, matches, envNames } = redact('key sk-ant-abcdefghijklmnopqrst1234')
// text: 'key [REDACTED]', matches: 1, envNames: []
```

- `redact(text, opts?)` — one-way replace of built-in credential patterns (Anthropic/OpenAI/GitHub/AWS/Bearer), caller-supplied `extraPatterns` (regex sources, compiled per unique source and cached), and env-var values captured from the process environment (suffix-matched names, ≥8-character value floor). Returns counts and matched env names only, never values.
- `readSecretsSettings(ctx)` — register the `cc-secrets` settings namespace idempotently and return a live per-use reader (`extraPatterns`, `redactCrusherStore`); hot reload applies without re-boot.
- `resetForTests()` — reset the lazy env snapshot and extra-pattern cache.

Invalid extra patterns are logged-and-skipped, never thrown at redact time.
