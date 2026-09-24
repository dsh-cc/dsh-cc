# @dsh-cc/transcript-secrets

[English](README.md) | 中文

面向转录边界的单向密钥脱敏：`/export` 输出与 context-crusher 外置存储在离开会话前，会被清除其中粘贴的凭据。

## 用法

```ts
import { redact, readSecretsSettings, resetForTests } from '@dsh-cc/transcript-secrets'

const { text, matches, envNames } = redact('key sk-ant-abcdefghijklmnopqrst1234')
// text: 'key [REDACTED]', matches: 1, envNames: []
```

- `redact(text, opts?)` — 单向替换内置凭据模式（Anthropic/OpenAI/GitHub/AWS/Bearer）、调用方提供的 `extraPatterns`（正则 source，按唯一 source 编译并缓存），以及从进程环境捕获的环境变量值（按名称后缀匹配、值长度 ≥8 的下限）。只返回计数与匹配到的环境变量名，绝不返回值。
- `readSecretsSettings(ctx)` — 以幂等方式注册 `cc-secrets` 设置命名空间并返回按次实时读取器（`extraPatterns`、`redactCrusherStore`）；设置热重载无需重启即生效。
- `resetForTests()` — 重置惰性环境快照与额外模式编译缓存。

非法的额外模式会被记录并跳过，绝不会在脱敏时抛出。
