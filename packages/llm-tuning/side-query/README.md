# @dsh-cc/side-query

English | [中文](README.zh.md)

The **side-query primitive**: a declarative, never-throws, non-streaming auxiliary LLM call for harness features that need a small/fast model answer off the main agent loop (design: docs/plans/2026-09-15-side-queries.md). Before this package, web_fetch's page summarizer, the session-title provider, and the permission auto-mode classifier each hand-rolled their own one-shot call with drifting timeout/failure/route semantics; `runSideQuery` is the single shared shape.

## API

```ts
export interface SideQueryOptions {
  agent: Agent                      // required: provider fill via agent.session.requestHeader (web-fetch precedent)
  alias?: string                    // default 'haiku' (resolveAlias / ccModelRoutes lane)
  system?: string
  prompt: string
  maxTokens?: number                // default 512
  timeoutMs?: number                // default 8000
  signal?: AbortSignal              // caller-owned; composed with the timeout (AbortSignal.any)
  onUnrouted?: 'inherit' | 'skip'   // default 'inherit' (alias unconfigured -> parent route)
  rejectToolCalls?: boolean         // default true
}

export type SideQueryResult =
  | { ok: true; text: string; inheritedRoute: boolean; durationMs: number }
  | { ok: false; reason: 'unrouted' | 'timeout' | 'error' | 'empty'; inheritedRoute?: boolean }

export async function runSideQuery(ctx: Context, opts: SideQueryOptions): Promise<SideQueryResult>
```

## Semantics

- **Never throws.** Every failure shape — unrouted alias, timeout, adapter error, empty text — collapses into `SideQueryResult`. The dsh-llm runtime normalizes adapter throws into terminal error chunks, so `reason: 'error'` covers both paths.
- Non-streaming contract: consumes `ctx.llm.stream` through the BlockAssembler pattern and awaits the full text (the `tool-web-fetch` one-shot pattern).
- `rejectToolCalls` (default) rejects streams that emit tool-call blocks. A side query that tries to *act* is a bug, not a capability (the memory recall-selector rogue-execution lesson).
- `inheritedRoute` reports whether the alias fell back to the parent route, so consumers can meter zero-savings runs (see `warnOnInherit` in `@dsh-cc/cc-model-aliases`).
- No retry, no cache, no persistence, no ledger — those belong to consumers (e.g. `@dsh-cc/tool-use-summary` keeps the ledger).

## Shape

Library package: no preset row, no settings namespace, no capability-manifest entry. Consumers depend on it with `workspace:^` and add a project reference in their own `tsconfig.json`.
