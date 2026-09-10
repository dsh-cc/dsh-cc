# @dsh-cc/compaction-basic

English | [中文](README.zh.md)

The CC compaction engine: an upstream `BasicCompactionEngine` subclass with one extension — a per-agent `/compact [instructions]` preservation hint that the `summarize()` hook folds into the summarizer input as an extra user message. Everything else (selection, retention, durability) stays the proven upstream replay.

## Usage

```ts
import CcBasicCompactionEngine from '@dsh-cc/compaction-basic'
import { setCompactHint, takeCompactHint, applyCompactHint } from '@dsh-cc/compaction-basic'

// Set the preservation hint the next compaction of this agent will honour.
setCompactHint(agent, 'Keep the migration plan and open TODOs')

// The engine consumes the hint inside summarize() (take = read + clear),
// so a later compaction of the same agent starts hint-free.
```

- `CcBasicCompactionEngine` — drop-in subclass of `BasicCompactionEngine`; its `summarize()` override applies the parked hint, or passes the input through unchanged when none is set.
- `setCompactHint(agent, hint)` — park a hint for `agent` (last write wins).
- `takeCompactHint(agent)` — take and clear the parked hint; `undefined` when none.
- `applyCompactHint(input, hint)` — append the hint as one extra user message at the end of the summarizer input's replayed messages; an empty/whitespace hint returns the input unchanged (same reference), so a bare `/compact` is byte-identical to upstream.

## Notes

- Hints are held in a `WeakMap` keyed by the live agent, so they never leak across agents and die with the agent object.
- Subcommand `@dsh-cc/compaction-basic/invariant` registers the package's invariant companion; it installs no runtime invariant because cross-agent leakage and hint reuse are impossible by construction.
