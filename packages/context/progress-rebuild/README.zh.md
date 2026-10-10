# @dsh-cc/progress-rebuild

English | [中文](README.zh.md)

结构化进度状态 + 压缩后上下文重建。一个注册的**会话投影**从已提交的会话事件派生每会话的类型化进度状态——goal 走上游 canonical `applyGoalProjection` 折叠（喂全部事件，含 `clear` 墓碑与 goal 轮次计数）、最新 `todo/write` 快照、已验证的 bash 执行回执、以及最近一条真实用户消息。在**成功的** `compaction/end` 上，派生简报被投递进**压缩边界后构建的第一个模型请求**：turn 内压缩走 `agent/pre-step` 决策拼接（同一步的请求），空闲压缩走延迟的持久 `agent.inject`（可跨持久化+恢复存活，由用户下一轮认领）。**默认关闭**（`progress-rebuild.enabled: false`，暗发布）。

## 工作方式

普通插件（无 Service），声明 `inject: ['sessionProjections']`，注册：

- **`progress-rebuild` 会话投影**（host-only 键、无客户端视图）：对每个已提交会话事件的纯函数、绝不抛错的折叠，由投影框架驱动并在 resume 时恢复——全程无任何 `snapshotEvents()`/`eventAt()`/`ownEvents()` 调用（上游对新生产调用已弃用）。状态为纯 JSON（仅数组）。
- **监听器 B**（`session/event`，`compaction/end`）：先跳过带 `error` 的结束事件（失败的压缩什么都没截肢），过 `enabled` 闸门，经 sessionId 键控的 agents registry 解析 agent，再按 `turn` 分支——`null`（空闲）用微任务延迟持久 `agent.inject`（会话 append 重入守卫禁止内联调用）；非空则设置内存态 `pendingBrief` 标记。
- **监听器 C**（`agent/pre-step` 瀑布）：在 `next()` 之后把简报消息拼进 enter 决策的 messages——循环将其提交为持久 `user/message`，简报由此搭上压缩后的首个请求。`reject` 决策保留标记到下一步。
- **ACK 观察者**（`session/event`，`progress-rebuild` 来源的 `user/message`）：交付确认是**已提交**的简报而非拼接调用——拼接后、持久 append 前被取消的步骤不产生记录。经延迟的、KNOWN_SESSION_EVENT_TYPES 注册的加宽 append 发出 `progress-rebuild/injected` dogfood 事件（`{bytes, sections, path}`）。

已验证回执按构造保守：仅 bash 工具、`isError` 为 false、渲染尾部**无任何**终态 marker 行（`[exit code: N]`/signal/超时/停止/仍在运行/沙箱标记——干净的 exit-0 根本不渲染 marker）、仅非复合命令（`;`、`&&`、`||`、`|`、换行、`&`、`$(…)`、反引号全拒）、且非 `run_in_background`。回执渲染执行证据（命令头 + exit 0），绝不渲染推断出的完成断言；按 `callId` 去重（保留首次出现——microcompact 的替换重追加不会重复计数）。goal 臂显式闩锁 `failure` 并渲染 "goal state unavailable" 而非陈旧状态。

跨包义务：注入类型 `progress-rebuild` 已加入 `@dsh-cc/turn-rules`（matcher）、`@dsh-cc/memory`（recall）与 `@dsh-cc/advisor-watchdog`（delta）的拒绝列表——简报永不以注入文本为食；投影自身的简报也被真实用户规则（`source` 缺席或 `kind === 'user'` 且含非空文本）排除在 `lastUser` 之外。

## 设置

| 键 | 默认 | 含义 |
|---|---|---|
| `enabled` | `false` | 总开关。暗发布；闸住监听器 B、监听器 C 与测量 append（投影注册保持挂载，resume 恢复不受影响）。 |
| `max-lines` | `120` | 简报行预算（6 KiB 字节上限与 240 字符行截断独立生效）。 |
| `include-verified` | `true` | 管辖整个 verified 节（当下的 bash 回退 + 姊妹设计落地后的 D1 回执）。 |

## 形态

普通 cordis 插件，由 `packages/preset/cc` 挂载在 cc-services 组、advisor-watchdog 之后。所有失败路径 fail-soft；没有任何路径会唤醒已静置的会话。已知取舍（session-cwd 同类）：一旦会话记录了 `progress-rebuild/injected`，恢复该会话需要装载本包的组合。
