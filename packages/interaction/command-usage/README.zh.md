# @dsh-cc/command-usage

[English](README.md) | 中文

斜杠命令共享的 `help` 参数支持：被包装的命令在把 `help`、`-h` 或 `--help` 作为第一个参数收到时，用自身元数据渲染确定性的纯文本帮助。其他参数（包括出现在后续位置的帮助词）原样传给处理器。不消耗模型轮次，也不依赖命令运行时。

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

- `isHelpRequest(rawInput)` — 判断原始输入的第一个词元是否为帮助请求；第一个词元之后的词元不会被检查。
- `formatCommandHelp(spec)` — 渲染规范的纯文本帮助布局。
- `helpable(def, extras?)` — 包装命令定义；第一个参数为帮助请求时返回格式化帮助，其余调用原样转发。

原始定义不会被修改。
