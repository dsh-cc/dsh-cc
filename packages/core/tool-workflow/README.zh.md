# @dsh-cc/tool-workflow

[English](README.md) | 中文

CC 对齐的动态 `workflow` 工具。它替换 cc 预设中的 harness 薄适配层
（`@deepseek-ai/dsh-tool-workflow`）：按 Claude Code 文档编写的工作流脚本——
内联 `export const meta = { name, description }` 块、保存的文件（按 `name`）、
或任意 `scriptPath`——第一次调用即可启动，整合结果以恰好一次的完成投递送达。

## 行为

- **内联 meta 提取。** 脚本开头的 `export const meta = { name, description }`
  块由无依赖的严格字面量解析器定位并提取（禁止 eval/`new Function`——包装层
  运行在 harness 宿主进程中）。接受尾随逗号与注释；模板字符串、标识符、
  展开、计算属性键、函数值都会被拒绝，且错误信息指名具体构造。形状校验
  仍委托给引擎的 `validateMeta`。
- **脚本来源解析。** 优先级 `scriptPath > script > name`。`name` 依次查找
  `<cwd>/.claude/workflows/<name>.js`（项目级，遮蔽用户级）与
  `<dshHome>/workflows/<name>.js`（`resolveDshHome()`；`$DSH_HOME` →
  `~/.dsh`），未命中时报出探测过的目录。保存脚本的 meta 名与文件名不一致时
  仍然接受，差异作为回执的 `warning` 字段呈现。
- **异步启动。** 工具立即返回 CC 文档中的回执子集
  `{status: "async_launched", taskId, taskType: "local_workflow",
  workflowName, runId, summary, warning?}`（`taskId === runId`；启动失败的
  无任务回执为 `{status, error}`，无 `taskId`）。
- **恰好一次的完成投递。** 会话级 cordis 服务（`ccWorkflowRunRegistry`）
  跟踪在途运行。结算时会话繁忙时负载并入 `agent/pre-step` 批次（绝不进入
  待处理收件箱）；会话空闲时以一次 `agent.inject()` 唤醒投递——每次运行至
  多一次唤醒。第二个并发运行会被结构化错误拒绝（v1 单活动运行约束）。
  上下文销毁会取消在途运行并吞掉结算投递。
- **持久会话事件。** 与 harness 事件名逐字相同的四类事件——
  `tool-workflow/run-start`（扩展 `source` 字段：`inline` | `project-saved` |
  `user-saved` | `scriptPath`）、`agent-start`、`agent-end`、`run-end`——
  仅顶层投递，带 try/catch 丢弃式追加保护。
- **不变量伴随插件。** `@dsh-cc/tool-workflow/invariant` 导出工作流记录折叠
  供选择挂载不变量行的 profile 使用；cc 预设不挂载。

## 与 CC 的偏差（已记录）

用户级工作流目录映射为 `$DSH_HOME/workflows/`（非 `~/.claude/workflows/`）；
未实现 monorepo 链式加载与内置工作流；`taskId` 复用 harness 运行 id（无
`wf_` 前缀）；回执省略 `transcriptDir`/`scriptPath`/`sessionUrl`；
`ultracode` 仅作为选择加入触发词（无会话 effort 副作用）；同会话恢复
（`resumeFromRunId`）由 `@dsh-cc/workflow-journal` provider 实现
（frozen-until-first-miss）；跨会话重放仍未实现。
