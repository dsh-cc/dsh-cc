# @dsh-cc/command-usage

English | [中文](README.zh.md)

Shared help-argument support for slash commands: every wrapped command answers a trailing `help`, `-h`, or `--help` argument with deterministic plain-text help rendered from its own metadata — no model turn, no coupling to the command runtime.

## Usage

```ts
import { helpable } from '@dsh-cc/command-usage'

const command = helpable({
  name: 'provider',
  description: 'Manage LLM provider routes and API keys',
  input: { hint: '[list | add <preset-id>]' },
  handler,
}, { subcommands, notes })
```

- `isHelpRequest(rawInput)` — whether the trailing argument is a help request.
- `formatCommandHelp(spec)` — render the canonical plain-text help layout.
- `helpable(def, extras?)` — wrap a command definition; help requests return formatted help, everything else delegates untouched.

The original definition is never mutated.
