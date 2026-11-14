# @dsh-cc/compaction-basic

English | [中文](README.zh.md)

The CC compaction engine: an upstream `BasicCompactionEngine` subclass with two extensions. The first is a per-agent `/compact [instructions]` preservation hint that the `summarize()` hook folds into the summarizer input as an extra user message. The second is a TUS consumer: after the hint is applied, `summarize()` substitutes tool-use-summary digests for qualifying tool results. Everything else (selection, retention, durability) stays the proven upstream replay.

## Usage

```ts
import CcBasicCompactionEngine from '@dsh-cc/compaction-basic'
import { setCompactHint, takeCompactHint, applyCompactHint } from '@dsh-cc/compaction-basic'

// Set the preservation hint the next compaction of this agent will honour.
setCompactHint(agent, 'Keep the migration plan and open TODOs')

// The engine consumes the hint inside summarize() (take = read + clear),
// so a later compaction of the same agent starts hint-free.
```

- `CcBasicCompactionEngine` — drop-in subclass of `BasicCompactionEngine`; its `summarize()` override applies the parked hint and then the TUS substitution, or passes the input through unchanged when neither applies.
- `setCompactHint(agent, hint)` — park a hint for `agent` (last write wins).
- `takeCompactHint(agent)` — take and clear the parked hint; `undefined` when none.
- `applyCompactHint(input, hint)` — append the hint as one extra user message at the end of the summarizer input's replayed messages; an empty/whitespace hint returns the input unchanged (same reference), so a bare `/compact` is byte-identical to upstream.
- `applyTusSummaries(input, dshHome, sessionId)` substitutes the TUS digest (`@dsh-cc/tool-use-summary`) for qualifying tool results: a result qualifies when an `ok` row carries a summary for its `source.callId` and its body is not already a context-crusher stub. No rows, no home, or no session id returns the input unchanged, and the call never throws.
- `TUS_CONSUMER_PROBE` is the durable probe record naming the upstream seam that makes per-result `callId` identity available.

## Notes

- Hints are held in a `WeakMap` keyed by the live agent, so they never leak across agents and die with the agent object.
- The TUS extension declares `@dsh-cc/tool-use-summary` as a peer dependency and reads the ledger path through the shared `@dsh-cc/sidecar-io` dsh-home resolver (a direct dependency).
