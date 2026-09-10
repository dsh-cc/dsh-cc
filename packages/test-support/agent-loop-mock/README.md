# @dsh-cc/agent-loop-mock

English | [中文](README.zh.md)

Internal test infrastructure, not published. A vendored scripted LLM adapter (`MockAdapter`) plus terse response builders, retained from `deepseek-harness` `packages/core/agent-loop/tests/mock-adapter.ts` so multiple test suites can share the same fixture.

## Usage

```ts
import { MockAdapter, textResponse, toolCallResponse } from '@dsh-cc/agent-loop-mock'

const adapter = new MockAdapter([
  textResponse('hello'),
  toolCallResponse('call-1', 'search', { query: 'x' }),
])
```

- `MockAdapter(script, reasoning?, defaultMaxTokens?)` — each model call consumes the next script entry and records every request in `adapter.requests` for assertions; an empty script throws "script exhausted".
- `textResponse(text)` / `maxTokensResponse(text)` — a complete text stream; the latter ends with a `max-tokens` finish reason.
- `toolCallResponse(callId, name, args, text?)` — a tool-call stream (with optional leading text), split across multiple argument deltas.
- Script entries may also be functions computing chunks from the request, or the markers `'hang'` (waits until aborted) and `'hang-slow'` (notices the abort after 50ms), for cancellation-path tests.
