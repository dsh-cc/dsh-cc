# @dsh-cc/progress-rebuild

English | [中文](README.zh.md)

（中文说明，与英文版实质等价。）

Post-compaction progress rebuild：普通插件，挂载在 `session/event` 消防带上，按会话维护一份确定性影子状态——当前目标（goal/change 词汇表：create|edit|pause|resume|complete|block|clear，先按 `operation` 判别再碰 `.goal`）、最新 todo 快照（逐字）、已验证的 shell 凭据（仅当从结果文本解析出 `[exit code: N]` 标记且 `N === 0`、且命令按前 4 个空白分隔 token 匹配证明类别——test/presubmit/build/lint/git commit——才算已验证）、以及最后一条真实用户指令（仅 `source.kind === 'user'` 的消息更新它；所有注入来源——包括本插件自己的——在构造上不可见）。在每次**成功**的 `compaction/end` 之后（携带 `error` 的直接跳过），插件渲染一份小的派生简报，经一次 `agent.inject()`、来源标记 `progress-rebuild` 注入活代理——压缩后的轮次因此无需任何模型调用即可保持方向感。注入（连同其自身触发的 inbox-splice 副作用）在 `queueMicrotask` 中运行以退出发布 append 的重入窗口；插件**绝不**追加自己的 session-event 类型（在 0.2.0-rc.x 持久层下，自定义非可忽略类型会毒化 JSONL 日志，令被压缩的会话无法恢复）。**默认开启**（`progress-rebuild.enabled: true`）。

## 工作方式

普通插件（无 Service、无 isolate key），注册一个监听器：

- **`session/event`**（消防带）：每个事件先更新每会话纯 reducer（`applyEvent`——向软侧失效，debug 记录后吞掉）；在 `compaction/end` 上，处理器——延迟到微任务——复查 error 字段、经 agents 注册表解析活代理（`ctx.get('agents')?.get(session.id)`；无活代理 → 静默跳过）、读取设置、渲染简报、注入，并写入测量。

简报布局（固定模板）：标题行 → Goal → Verified done（exit-code 凭据）→ Todo 快照（逐字；超出行预算时按头 2/3 + 尾 1/3 截断并加 `… (N elided)` 标记）→ Last user instruction → Not-verified 警告。包含一句固定的 microcompact stub 标记句；退化形态（空影子）为 stub 句 + 最后用户指令行（如已知）+ 警告。总有紧急开关：`progress-rebuild.enabled: false` 完全关闭注入。

影子状态仅限进程生命周期（按会话 id 的 Map）——从不调用任何已废弃的 session 读取器（`snapshotEvents`/`eventAt`/`ownEvents`）；重启/恢复后从空开始，简报按设计退化。

Dogfood 测量：每次注入向 `$DSH_HOME/progress-rebuild/<sessionId>.jsonl` 追加一行 JSON `{ts, bytes, sections}`（分离写入；无 harness home → no-op；全部错误吞掉）。暂无 sidecar dogfood 文档——sidecar 文件本身即测量面。

跨包义务：注入类型 `progress-rebuild` 已加入 `@dsh-cc/turn-rules`（matcher）、`@dsh-cc/memory`（recall）与 `@dsh-cc/advisor-watchdog`（delta）的拒绝列表——rebuild 永不以自己或其他插件的注入文本为食。

## 配置（仅用户层）

用户层 `settings.json`（harness-home 文件）中的 `progress-rebuild` 键。**永不读取**项目作用域——结构上不可见，并非"被拒绝"。

| 键 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关。`false` = 紧急开关（完全不注入）。 |
| `max-lines` | `120` | 简报行预算；todo 节按头 2/3 + 尾 1/3 截断以适配。 |
| `include-verified` | `true` | 是否渲染 Verified-done 节。 |

## 形态

普通 cordis 插件（无 Service、无 isolate key）。由 `packages/preset/cc` 挂载在 cc-services 组内、advisor-watchdog 之后。所有故障均向软侧失效：监听器绝不能阻塞步骤或向瀑布抛错；发布 append 的重入窗口绝不被重入。
