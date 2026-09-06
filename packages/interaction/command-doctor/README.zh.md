# @dsh-cc/command-doctor

[English](README.md) | 中文

面向用户的 `/doctor` 命令：产品级的**会话健康报告**。同一份数据对象、三种呈现——默认文本、详细文本，以及写到 `$DSH_HOME` 下的 JSON 文件。该插件通过 [`ctx.commands`](../../interaction/commands/README.md) 注册一个全局命令，因此每个已组合的命令适配器都能发现并执行它，无需模型轮次。

## 命令约定

| 输入 | 结果 |
|---|---|
| `/doctor` | 廉价的进程内检查。`ok` 行折叠为一行；`warn`/`fail`/`skip`/`info` 行展开显示摘要与建议修复。 |
| `/doctor --verbose` | 廉价检查加上慢探针：LLM 目录校验、`serena-hooks` 的 PATH 扫描、git worktree 事实，以及会话存储写入探针。每一行都会打印 evidence。 |
| `/doctor --json` | 以与 `--verbose` 相同的方式收集，并把完整报告写入 `$DSH_HOME/tui/doctor-report.json`（逐级建目录、覆盖旧文件）。命令文本只包含路径、summary 计数与 fail/warn 检查 id——绝不会把 JSON 大块塞进会话记录。 |

`--verbose --json` 同时使用时按详细模式收集并输出 JSON。未知 token 会以成功结果返回用法文本；解析失败时不会运行任何检查。

## 报告结构

`DoctorReport` 携带 `schemaVersion: 1`、`generatedAt`、`durationMs`、`env` 头部（dsh-cc/harness/node/os/arch/cwd），以及按 `env`、`session`、`models`、`mcp`、`hooks`、`web`、`storage`、`git`、`plugins`、`seams` 分组的 `checks` 数组。

**消费方规则（schemaVersion）：** 新增检查 id **不是**破坏性变更——消费方必须容忍未知的检查 id 与分组。只有 `schemaVersion` 升位才是破坏性的。

每段字符串在渲染或写盘前都会清洗类密钥子串（`sk-`、`ghp_`、`xoxb-`、`Bearer `），且 evidence 取值仅限原始类型。

## 组合

生产方注入 `commands`。在 `cc` 预设中它位于 `cc-services` 组内，以便读取 `ccModelRoutes`、`mcpConnections` 与 `hookBridgeStatus`：

```yaml
- id: commands
  name: '@deepseek-ai/dsh-commands'
- id: command-doctor
  name: '@dsh-cc/command-doctor'
```

所有可选接缝都通过 `ctx.get` 鸭子类型读取；缺失的接缝报告为 `skip` 行，而不是失败。每个检查组都有独立的 try/catch，因此抛错的接缝只会退化为一行 fail，命令本身仍然成功。

## 已知限制

- **没有无头 CLI** — `dsh doctor` 属于第二阶段；本命令只能在会话内运行。
- **不做 CC 式的修改** — 只读 + 发现问题 + 建议修复；绝不改写 CLAUDE.md 或 skills，MCP 操作仍走 `/mcp`。
- **fetch provider 缺失只是 info** — 已挂载 web 接缝但缺少 fetch provider 时，报告已知的 `WEB_PROVIDER_UNAVAILABLE` 限制，而非失败。
- **Hook 发现仅限单文件** — CC 的分层 project/user 发现与热重载尚未实现（以 `info` 行报告）。

## 模型体验

斜杠输入与诊断输出都不会进入模型请求，也不消耗模型 token。呈现文本绝不会记录到日志中。
