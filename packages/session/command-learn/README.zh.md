# @dsh-cc/command-learn

[English](README.md) | 中文

面向用户的 `/learn` 命令：从持久化会话转录中蒸馏反复出现的 失败→成功 修正并写入工作区记忆，让同样的错误不再跨会话重演。分析逻辑位于纯库 [`@dsh-cc/session-forensics`](../session-forensics/README.md)；本包把它挂载为带设置与记忆写入路径的会话级斜杠命令。

## 命令约定

| 输入 | 结果 |
|---|---|
| `/learn` | 干跑：扫描会话存储（默认当前项目、最近 14 天），渲染排序后的 findings 与拟写入的记忆块。不写任何内容。 |
| `/learn apply` | 通过真实的 `@dsh-cc/memory` writeback 辅助函数写入 `session-learnings` 记忆主题文件并 upsert `MEMORY.md` 指针。空 findings 时保持现有记忆不变。 |
| `/learn all` | 扫描所有项目的会话，而非仅当前项目。 |
| `/learn days=N` | 为本次运行覆盖新近度窗口。 |
| `/learn help` | 经共享 `helpable()` 辅助函数输出用法文本。 |

记忆写入在标记限定的托管块（`<!-- dsh-cc:learn:start -->` … `end`）内按运行整体再生成，该块完全由 `/learn` 拥有；主题文件的 description 保持稳定，指针行不会在运行间抖动。

## 组合

该插件注入 `commands`、`fs` 与 `settings`。自定义应用会挂载它的拥有者与此插件：

```yaml
- id: command-learn
  name: '@dsh-cc/command-learn'
```

## 设置

命名空间 `cc-learn`（kebab-case、容忍缺省的 schema）：`enabled`（默认 `true` —— 命令按需触发，不会有任何未提示的运行；`false` 时打印提示并退出）、`days`（默认 `14`）、`min-occurrences`（默认 `2` —— 只写重复出现的修正）。

## 模型体验

斜杠输入与命令输出不消耗模型 token。干跑输出仅用于呈现；`apply` 写入工作区记忆文件，这些文件仅在后续会话中通过常规记忆 recall 面呈现给模型。

## 已知限制与暂缓事项

- 确定性分析器在真实数据上的精度尚未验证 —— 信任 `apply` 输出前的 dogfood 门是 20 条 findings 的人工抽查。
- v1 无 LLM 摘要 pass；findings 连同证据锚点原样落盘。
