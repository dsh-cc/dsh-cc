# @dsh-cc/command-cost

[English](README.md) | 中文

面向用户的 `/cost` 命令，基于会话 usage 日志实现。该插件通过 [`ctx.commands`](../../interaction/commands/README.md) 注册一个全局命令，因此每个已组合的命令适配器都能发现并执行它，无需模型轮次。它会把每条已记录的 `assistant/message` usage 记录，对照最新的 `request/header` 模型路由与 Config 中的部署单价表进行折叠。

## 命令约定

| 输入 | 结果 |
|---|---|
| `/cost` | 显示整个会话按模型的 token 用量（未缓存输入、缓存读取输入、缓存写入输入、输出）与估算 USD 成本，以及总计。没有匹配单价列的模型会显示使用量并附带 "no price configured" 标记，而不是报零成本。没有记录到任何 usage 的会话会直接说明。 |

只要有 usage 记录就始终显示用量；只有部署方为模型配置了价格时才估算成本。回答该命令不会发起模型调用，也不消耗任何 token。

## 配置

所有价格都放在插件 `Config`（写在 `cordis.yml` 里），插件本身没有任何硬编码。价格为每百万 token 的 USD 计价。`model` 为 `'*'` 的列是对没有精确匹配列的模型的通配默认列。

```yaml
- id: command-cost
  name: '@dsh-cc/command-cost'
  config:
    modelTable:
      - model: deepseek-chat
        provider: deepseek
        inputPerMTok: 0.27
        outputPerMTok: 1.10
        cacheReadPerMTok: 0.07
        cacheWritePerMTok: 0.07
      - model: '*'
        inputPerMTok: 0
        outputPerMTok: 0
        cacheReadPerMTok: 0
        cacheWritePerMTok: 0
```

## 组合

生产方注入 `commands`。自定义应用会挂载它们的拥有者与此插件：

```yaml
- id: commands
  name: '@deepseek-ai/dsh-commands'
- id: command-cost
  name: '@dsh-cc/command-cost'
```

没有 `modelTable` 时，所有模型都会被报告为未定价——仍会显示 token 用量，但不做成本估算。

## 模型体验

斜杠输入与直接的 token／成本输出不会进入模型请求，也不消耗模型 token。该折叠读取会话的持久日志；呈现文本绝不会记录到日志中。

## 已知限制与暂缓事项

- **仅精确匹配定价**：`'*'` 通配列覆盖未匹配模型；更灵活的按前缀定价暂缓实现。
- **回合进行中没有实时总计**：`/cost` 报告截至最近检查点的持久日志，不包含进行中的用量。
