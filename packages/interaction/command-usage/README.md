# @dsh-cc/command-usage

English | [中文](README.zh.md)

Shared help-argument support for slash commands: a wrapped command answers `help`, `-h`, or `--help` given as its first argument with deterministic plain-text help rendered from its own metadata. Any other argument, including a help word in a later position, reaches the handler unchanged. No model turn, no coupling to the command runtime.

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

- `isHelpRequest(rawInput)` — whether the first token of the raw input is a help request; tokens after the first are not inspected.
- `formatCommandHelp(spec)` — render the canonical plain-text help layout.
- `helpable(def, extras?)` — wrap a command definition; a help request as the first argument returns formatted help, everything else delegates untouched.

The original definition is never mutated.
