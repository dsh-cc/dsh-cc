# @dsh-cc/cache-health

[English](README.md) | 中文

被动的提示词缓存前缀稳定性观察器，附带 `/cache-health` 斜杠命令。一个 `llm/stream` 瀑布监听器跟踪每次出站模型请求的前缀（system → tools → messages，按序）在会话内哪些部分是易变的；该命令将观察账本与会话事件中的提供商计量缓存用量（`cacheReadTokens` / `cacheWriteTokens`）连接起来。仅探测：只报告，从不改写——不改写请求、不改提供商调用、不改 harness。

## 命令契约

| 输入 | 结果 |
|---|---|
| `/cache-health` | 显示当前稳定前缀（段数、估算 token 数、自上次调用是否变化）、漂移表（仅列出前缀变化的行，附脱敏摘录）、每次调用与会话总计的缓存读/写 token 比例、前置可疑项（漂移段 ≤ 2：system / tools / 首条消息——cwd 与 `DSH_SESSION_*` 易变性所在），并明确列出尾部追加不属于可疑项。 |

缓存计量数字来自提供商计量；零计量的上游产生的是零，而不是未命中的证据。

## 账本

每次模型调用一行 JSONL，位于 `<dshHome>/cache-health/<projectKey>/<sessionId>.jsonl`，其中 `projectKey` 是会话 cwd 的短哈希（context-crusher 惯例）。行包含 `{ts, seq, provider, model, stableSegments, stablePrefixHash, stablePrefixTokensEst, prefixChanged, driftSegmentIndex?, driftExcerpt?, callPurpose?}`——`stablePrefixHash` 是稳定前缀的指纹（对其各段哈希再哈希），共享前缀的调用间保持稳定，可与离线 `cache-trajectory` 分析器对齐比对。追加是即发即忘的——观察绝不会给模型调用增加延迟。文件上限 2000 行（溢出时裁剪最旧的）。

行反映的是 `llm/stream` options 的中间件之前原始视图，而非线上忠实呈现：未来若有中间件在 `llm/stream` 中改写 options，该账本将低估抖动。摘录会折叠空白、脱敏（`sk-…` 密钥、`Bearer` 令牌、≥ 32 字符的不透明串）并截断到 80 字符。`stablePrefixTokensEst`（规范化长度 / 4）是估算值，不是 token 计数。

## 配置

```yaml
- id: cache-health
  name: '@dsh-cc/cache-health'
  config:
    enabled: true   # 默认；设为 false 可同时禁用监听器与命令
```

## 组装

CC 预设（`@dsh-cc/preset-cc`）将本插件作为斜杠命令行挂载（其 `agent.cordis.yml` 中的 `cache-health` 行）。插件声明 `inject = ['commands', 'sessions']` 并防御性读取 `dshHomePath`；没有 `dshHomePath` 的宿主会强制禁用观察器。
