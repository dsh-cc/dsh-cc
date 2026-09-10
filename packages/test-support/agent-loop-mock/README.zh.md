# @dsh-cc/agent-loop-mock

[English](README.md) | 中文

内部测试基础设施，不对外发布。提供一个脚本化驱动的 LLM 适配器（`MockAdapter`）及若干简写的响应构造器，从 `deepseek-harness` 的 `packages/core/agent-loop/tests/mock-adapter.ts` 原样保留，供多个测试套件复用。

## 用法

```ts
import { MockAdapter, textResponse, toolCallResponse } from '@dsh-cc/agent-loop-mock'

const adapter = new MockAdapter([
  textResponse('hello'),
  toolCallResponse('call-1', 'search', { query: 'x' }),
])
```

- `MockAdapter(script, reasoning?, defaultMaxTokens?)` — 每次模型调用消耗下一条脚本条目，并把收到的每个请求记录到 `adapter.requests` 以便断言；脚本耗尽时抛出 "script exhausted"。
- `textResponse(text)` / `maxTokensResponse(text)` — 完整的文本流；后者以 `max-tokens` 结束原因收尾。
- `toolCallResponse(callId, name, args, text?)` — 工具调用流（可选前置文本），参数增量拆分成多段。
- 脚本条目也可以是根据请求计算响应块的函数，或标记 `'hang'`（等待中止）与 `'hang-slow'`（延迟 50ms 才响应中止），用于取消路径测试。
