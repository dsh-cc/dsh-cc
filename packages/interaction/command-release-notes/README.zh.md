# @dsh-cc/command-release-notes

[English](README.md) | 中文

面向用户的 `/release-notes` 斜杠命令：离线、确定性地打印内置更新日志——更新日志以 TS 字符串常量的形式随包分发，调用时不访问文件系统或网络。

## 用法

该插件挂载一个命令（注册到 `commands` 服务上）：

```ts
import { apply, name } from '@dsh-cc/command-release-notes'

ctx.plugin({ name, inject: ['commands'], apply })
```

- `/release-notes` — 打印完整的内置发布说明，最新小节在前。
- `/release-notes <lines>` — 将输出截断为前 `<lines>` 行（正整数；其他输入渲染全文）。

与所有经 `@dsh-cc/command-usage` 的 `helpable` 包装的命令一样，`/release-notes help` 会返回确定性的纯文本帮助。

## 说明

- 更新日志在编写时从仓库的已跟踪历史和 README 生成；发布新版本时请更新内置的 `CHANGELOG` 常量。
- 如需编程式使用，`./release-notes` 导出 `CHANGELOG` 和 `renderReleaseNotes(markdown?, maxLines?)`。
