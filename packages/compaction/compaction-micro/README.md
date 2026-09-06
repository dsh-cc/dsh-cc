# @dsh-cc/compaction-micro

English | [中文](README.zh.md)

The replay-safe model-free microcompaction service (`ctx.microcompactor`). It keeps the most recent `retainResults` `tool/result` surface nodes verbatim and replaces every older one with a deterministic placeholder that re-embeds the original's spill locator when one was cited — no model call, no summarization.

This is a concrete companion to [`dsh-compaction-basic`](../compaction-basic/README.md), not a compaction backend. It composes ahead of summarization so the summarizer reads an already window-reduced surface. Both packages remain independently composable.

## Service API

`microcompactSession(session)` scans one stable snapshot of the current surface. The most recent `retainResults` tool results are kept verbatim; each older result that is not already a placeholder is replaced by one newly appended `tool/result` carrying `{ surfaceOp: { op: 'replace', start: originalSeq, end: originalSeq }, sourceEventSeqs: [originalSeq] }`. The replacement spreads the complete original data and changes only `content`, preserving `turn`, `step`, `callId`, error fields, `meta`, and later data additions. The original event remains available for persistence, replay, and exact-log inspection.

Each replacement is immediately preceded by a `compaction/prune` shadow-price event pricing the shadowed node through the injected token meter, and followed by a `compaction/microcompact` decision record naming the shadowed `originalSeq`, the `replacementSeq`, the shared `callId`, and any re-embedded `spillLocator`. Together these keep the decision reconstructable from the log.

The method throws synchronously when the session rejects a replacement. Replacements committed earlier in the pass remain durable.

`isMicrocompactPlaceholder(blocks)` reports whether a content list already carries the placeholder marker; `reuseSpillLocator(text)` extracts a rendered spill-locator sentence for re-embedding.

## Freeze semantics

The decision to collapse a tool result is made once and stays stable for the session. A placeholder always begins with the fixed `[... tool result compacted ...]` marker, and a later pass recognizes an already-collapsed result by that marker and never re-decides it. An identical re-run therefore emits a byte-identical prompt: repeated passes over unchanged history change nothing (the `stable` field is `true` and no replacement lands), preserving prompt-cache reuse.

## Config

Unrecognized keys fail at plugin construction. Resolved config is detached and deeply immutable.

| Key | Required | Meaning |
|---|---|---|
| `retainResults` | no (default `10`) | Keep the most recent N tool results verbatim; older ones are eligible. |
| `auto` | no (default `false`) | Register an `agent/pre-step` hook that collapses stale results ahead of the turn's request. |
| `placeholderChars` | no (default `256`) | Maximum text code points in a generated placeholder (excluding a re-embedded spill locator). |

All values are integers; `retainResults` and `placeholderChars` are positive.

## Usage

```ts
import type { Context } from '@deepseek-ai/cordis'
import Microcompactor from '@dsh-cc/compaction-micro'

export function apply(ctx: Context): void {
  ctx.plugin(Microcompactor, { retainResults: 4 })
}
```

## Model Experience

### Collapsed tool result

#### What the model sees

Out-of-window tool results appear as the deterministic placeholder. When the original cited a spilled artifact (e.g. `Full grep result stored at: …`), the placeholder re-embeds that locator sentence so the model can still read the full result.

#### Token effect

Each collapsed result is replaced by a placeholder of at most `placeholderChars` text code points. Microcompact makes no model call.

#### KV Cache effect

Replacing an earlier result invalidates reuse from the first changed token. The remaining prefix (including the verbatim tail window) is eligible for reuse while its route, envelope, and preceding history remain identical. Freezing the decision keeps repeated passes from re-invalidating the cache.

## Known Limitations and Deferred Work

- **Window, not semantics** — a result is collapsed purely by surface age, not by how much the model still needs it.
- **Spill-locator reuse is best-effort** — it matches the rendered `stored at:` phrasing used by `dsh-tool-fs`-style spill footers; a tool that phrase the locator differently will not have it re-embedded.
- **Grapheme clusters can split** — placeholder truncation slices by code point, protecting surrogate pairs but not locale-aware grapheme segmentation.
