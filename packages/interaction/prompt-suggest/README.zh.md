# @dsh-cc/prompt-suggest

English | [中文](README.md)

下一提示建议：插件在 `agent/turn-stopping` 时以 fire-and-forget 方式发起一次廉价通道 side query（`@dsh-cc/side-query`），基于最近一轮对话（用户提示 + 最终助手文本，各截断 2 KiB）预测用户接下来可能输入的消息。预测结果——纯文本、≤ 120 字符——存入以会话 id 为键、带 5 分钟 TTL 的**模块级注册表**，由交互式 TUI 的自动补全 provider 读取。**默认关闭**（`cc-prompt-suggest.enabled: false`，需主动开启）：从不启用该功能的用户不会产生任何模型调用，也看不到任何建议项。

## 工作方式

监听器同步完成决策（启用开关、会话 id、禁用时清理），然后以 void promise 发起预测——turn-stop 永不被等待或阻塞（memory-consolidation 先例）。`runSideQuery` 通过 `AbortSignal.any` 将 `timeoutMs` 预算与插件的 dispose 信号组合；所有失败形态（`timeout`/`error`/`unrouted`）保留注册表中的旧值，而 `empty`（模型表示"没有可信预测"）则清空它。纯空白回答按 `empty` 处理。

注册表是模块级的（不随 context 走），因此 TUI 重新实例化其自动补全 provider 时不会丢失已存储的建议。**同进程假设：**交互式 TUI 通过普通 import 读取注册表；如果 TUI 将来运行在独立进程中，注册表在那边为空，功能自动失效——构造上即 fail-soft。`getSuggestion(sessionId)` 是唯一的读取面：缺失、过期或从未写入（包括所有禁用的会话——禁用的生产者不写入，并在下一次 turn-stop 清除旧条目）时返回 `undefined`。

## TUI 呈现（仅前缀匹配）

vendored 的 pi-tui Editor 只在触发字符（`/`、`@`）或强制 Tab 时咨询自动补全 provider——从不咨询空输入（实现时已探测；见 `packages/ui/tui/src/components/completion.ts` 中预测分支的注释）。因此交付的呈现方式是**仅前缀匹配**：在空行上输入已存预测的开头几个字符，然后补全（Tab）。选中该项会用完整建议替换当前行。

## 设置

命名空间 `cc-prompt-suggest`：

| 键 | 默认 | 含义 |
|---|---|---|
| `enabled` | `false` | 总开关，**需主动开启**。每次 turn-stop 实时读取；禁用时不发起模型调用并清除该会话的已存建议。 |
| `alias` | `haiku` | 经 `ccModelRoutes`/`resolveAlias` 咨询的廉价通道别名；未配置时继承父路由（fail-soft）。 |
| `timeoutMs` | `4000` | 预测的墙钟预算；与插件 dispose 信号组合。 |
| `maxTokens` | `128` | 预测的 token 预算。 |

## 形态

普通 cordis 插件（不发布 Service——reasoning-fold 模式；无 isolate key）。settings provider 缺失时不注册任何东西。由 `packages/preset/cc` 挂载在 cc-services 组；`packages/ui/tui` 以 workspace 依赖消费 `getSuggestion`。
