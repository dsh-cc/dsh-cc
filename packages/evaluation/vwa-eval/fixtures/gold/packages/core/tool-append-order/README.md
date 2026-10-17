# @dsh-cc/tool-append-order

English | [中文](README.zh.md)

Cache-stable tool ordering on the `system-prompt/assemble` waterfall: each scope's emitted tool sequence keeps its positions, and new tools append lexicographically at the tail. DeepSeek's context cache keys on the request prefix, so this keeps a ToolSearch activation or MCP registration from shifting every later tool and invalidating the cached prefix.

## Usage

The package is a cordis plugin with no importable API beyond its registration:

```ts
import { apply } from '@dsh-cc/tool-append-order'

apply(ctx) // listens on `system-prompt/assemble`, outermost via `prepend`
```

## What it provides

- On the first assembly of a scope, the harness baseline passes through untouched (and is recorded).
- On later assemblies, tools that still exist keep their remembered positions; newly appeared tools are appended lexicographically at the tail. The steady state is append-only: activations extend the tool list instead of shifting it.
- A name that no longer appears is dropped; a duplicate name keeps its first schema.
- Scope-less global assemblies pass through — there is no scope to key a sequence by.

## Notes

- cordis waterfall composition gives the outermost listener the final say, so the listener registers with `prepend` to be outermost regardless of roster position; the preset row itself stays last.
- The per-scope sequence memory is held in a `WeakMap` keyed by the scope, so it dies with the scope object.
- The Item 6 L0 prefix-stability e2e is the long-term sentinel for this contract.
