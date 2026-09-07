# @dsh-cc/command-usage

[English](README.md) | 中文

斜杠命令共享的 `help` 参数支持：被包装的命令在收到尾部 `help`、`-h` 或 `--help` 参数时，用自身元数据渲染确定性的纯文本帮助，不消耗模型轮次，也不依赖命令运行时。

## 用法

```ts
import { helpable } from '@dsh-cc/command-usage'

const command = helpable({
  name: 'provider',
  description: 'Manage LLM provider routes and API keys',
  input: { hint: '[list | add <preset-id>]' },
  handler,
}, { subcommands, notes })
```

- `isHelpRequest(rawInput)` — 判断尾部参数是否为帮助请求。
- `formatCommandHelp(spec)` — 渲染规范的纯文本帮助布局。
- `helpable(def, extras?)` — 包装命令定义；帮助请求返回格式化帮助，其余调用原样转发。

原始定义不会被修改。
