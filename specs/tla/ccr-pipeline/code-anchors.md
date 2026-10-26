# Code anchors — ccr-pipeline

Verbatim excerpts from the current worktree (head d5f7e385), read before
modeling. Each excerpt is byte-exact; source path and line range given per
block.

## C1 — the accept-path staged commit (store → ledger → return) 〔src:ws:specs/tla/ccr-pipeline/code-anchors.md#L7-L28〕

Source: `packages/context/context-crusher/src/index.ts:243-257` (excerpt)

```ts
      this.store.put(projectKey, originalText)      // defer fast path
      ...
      const replacement = {type:'text', text: `${compressedBody}\n${buildMarker(tokensBefore, tokensAfter, hash)}`}
      ...
      await this.ledger({ ... applied: true, hash, charsAfter: replacement.text.length })
      void this.store.sweep()
      return {kind:'accept', ...d, content: [replacement]}
```

with the defer row at `index.ts:241`:

```ts
      await this.ledger({ ... applied: false, hash, tokensAfter: tokensBefore - tokensAfter })
```

(the row carries a hash while `applied:false` — the documented anomaly).

## C2 — the reducer's staged commit and fail-soft 〔src:ws:specs/tla/ccr-pipeline/code-anchors.md#L29-L44〕

Source: `packages/context/context-crusher/src/reducer.ts:216-229` (excerpt)

```ts
    if (deps.mode !== 'on') { ...dry-run row, applied:false... return undefined }
    ...
    await ctx.store.put(projectKey, originalText)   // full text, never the view
    const replacement = {type:'text', text: `${receiptBodyRef}\n${buildMarker(...)}`}
    await deps.ledger({... applied: true, hash ...})
    return {...}
  } catch (error) {
    ... return undefined   // fail-soft passthrough: original bytes preserved
  }
```

## C3 — the paired swap (prune then replace, adjacently, no await) 〔src:ws:specs/tla/ccr-pipeline/code-anchors.md#L45-L58〕

Source: `packages/context/context-crusher/src/defer/swap.ts:131-142` (excerpt)

```ts
      await session.append('compaction/prune', {shadowedRange:{start:seq,end:seq}, shadowedSeqs:[seq], shadowedTokenCount: estimateMessage(message)})
      await session.append('tool/result', {...event.data, message: replacementMessage}, {surfaceOp:{op:'replace',startSeq:seq,endSeq:seq}, sourceEventSeqs:[seq]})
```

with the doc contract at `swap.ts:87-90` ("both synchronous, no `await`
between") and the staleness re-check at `swap.ts:93-99` (locate by `callId`
over `session.surface.nodes` **and** `joinTextBlocks(message.content) === input.fullText`
byte-equality). 〔src:ws:specs/tla/ccr-pipeline/code-anchors.md#L45-L58〕

## C4 — the swap critical section and dry-run retention 〔src:ws:specs/tla/ccr-pipeline/code-anchors.md#L59-L71〕

Source: `packages/context/context-crusher/src/defer/pass.ts:162-200` (excerpt)

```ts
    // I/O strictly before; then synchronous staleness re-check + 2 appends, no yield
    ...
    if (gateFailed || dryRun) { ...entry stays resident... }
```

and `residents.ts:60-63` — the dedicated defer rows `abandoned`, `stale`,
`dry-run` are all `applied:false`.

## C5 — the swap ledger row after the appends 〔src:ws:specs/tla/ccr-pipeline/code-anchors.md#L72-L82〕

Source: `packages/context/context-crusher/src/defer/pass.ts:189-198` (excerpt)

```ts
      rows.push({ kind: 'swap', outcome: dryRun ? 'dry-run' : 'applied', applied: !dryRun, ... })
```

appended **after** the two session appends; all rows best-effort
(`residents.ts:73-80` swallows I/O errors).

## C6 — the store's atomic put (temp + rename) 〔src:ws:specs/tla/ccr-pipeline/code-anchors.md#L83-L96〕

Source: `packages/context/context-crusher/src/store.ts:84-89` (excerpt)

```ts
  put(key, text) {
    ... writeFileSync(temp, ..., {flag:'wx'}) ... renameSync(temp, path)
    ... void this.sweep()
  }
```

content-addressed (`sha256` first 16 hex of the redacted text, `store.ts:70-79`),
so concurrent identical puts are idempotent.

## C7 — no already-has-a-marker check in crush() 〔src:ws:specs/tla/ccr-pipeline/code-anchors.md#L97-L115〕

Source: `packages/context/context-crusher/src/index.ts:185-204` (excerpt)

```ts
    if (!cfg.enabled || this.store === undefined) return d
    ...
    if ((cfg.protectedTools as readonly string[]).includes(exec.name)) return d
    if (exec.name === RETRIEVE_TOOL_NAME) return d
    if (Object.hasOwn(d, 'value')) return d
    if (allTextBlocks(blocks) === undefined) return d
    ...
```

The skip list is protected tools + `context_retrieve` — there is no
"already crushed" check; safety relies on the host firing
`tools/post-execute` exactly once per fresh result (a declared assumption,
probed by the double-fire case).

## C8 — foldCounters is the ground truth, not the ledger 〔src:ws:specs/tla/ccr-pipeline/code-anchors.md#L116-L124〕

Source: `packages/context/context-crusher/src/fold-counters.ts:55-72`
(excerpt)

```ts
  // counts markers in tool/result events -> ccr.applied / tokensBefore / tokensAfter
  // (ledger rows are observability only)
```
