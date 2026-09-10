# dsh-cc-shunt

[English](README.md) | 中文

官方 dsh-cc 插件，把大块文件内容挡在主上下文之外。

**工作方式**：两个硬性 PreToolUse 门（Read 和 Bash）拦截对大文件的整体读取，拦截消息重定向到 `bulk-reader` / `code-writer` 技能，后者委托给插件的廉价通道 worker 子代理（`shunt-reader`、`shunt-writer`）。文件内容由 worker 读取——或写入——返回主上下文的只有一份紧凑摘要或一行确认。

- `shunt-reader` — 跨大文件 / 多文件 / 大 diff 回答问题，返回以 `file:line` 引用开头的结构化摘要。
- `shunt-writer` — 依照一份强制性参考文件的模式在磁盘上生成测试/配置/桩代码；从不返回生成的代码正文。

## 安装 / 启用

`dsh-cc` marketplace 附带本插件。在 settings.json 中启用：

```json
{
  "enabledPlugins": { "dsh-cc-shunt@dsh-cc": true }
}
```

## 配置

通过 settings.json 顶层的 `"env"` 对象设置：

| 变量               | 默认值   | 含义                                                               |
| ------------------ | -------- | ------------------------------------------------------------------ |
| `SHUNT_MIN_LINES`  | `350`    | 行数阈值；超过它的整体文件读取会被拦截                              |
| `SHUNT_MAX_BYTES`  | `100000` | 字节阈值；无论行数多少都会拦截压缩成单行的文件                      |
| `SHUNT_DISABLED`   | 未设置   | 设为 `1`/`true`/`yes` 可完全关闭两个门                              |

## 模型别名要求

**shunt-worker 子代理固定 `model: haiku`。** 如果你的部署未配置 haiku 别名，worker 会静默继承父级的模型路由——一切照常工作，但**节省的 token 为零**。要真正省钱，请配置 haiku 别名。

## 已知限制

- 摘要中的行号引用在编辑后可能失效——在引用位置编辑前，请先用带 offset/limit 的定向读取确认。
- 调试与架构方面的工作不会被委托——只有大块读取和样板代码生成会。
- worker 调用是一次性前台调用；要跟进只能重新拉起。
