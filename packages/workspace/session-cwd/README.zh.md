# @dsh-cc/session-cwd

[English](README.md) | 中文

面向 DeepSeek Harness CC 的会话级工作目录门面——对 harness `workingDirectory` 服务的
薄适配层（worktree-session-isolation 设计，`docs/plans/2026-09-02-worktree-session-isolation.md`）——
WS1 + WS2 基础。

## 拥有什么

- **门面**（`src/api.ts`）：`resolveSessionCwd(agent)`——可为 `undefined`，经 agent 自身
  上下文读取服务投影状态，仅当该 realm 中服务缺失时回退到遗留折叠；以及全量的
  `getSessionCwd(agent, options?)`（`resolve ?? options.fallback ?? process.cwd()`）。
  两者都不抛错，无 cwd 与 TUI 风格的 agent 测试替身照常工作。
- **遗留日志水合**（`src/hydration.ts`）：`worktree/entered` 继续注册进持久化层的
  `KNOWN_SESSION_EVENT_TYPES`，旧日志仍可打开。`agent/created` 时把仅含遗留事件的日志
  一次性迁移进服务；更新（按事件 seq）的 `working-directory/change` 绝不会被覆盖，
  遗留目录已消失时只告警，不让 agent 创建失败。
- **workspace 边界守卫**（WS2，`src/listener.ts`）：以 `{ prepend: true }` 注册的
  `tools/pre-execute` 监听器——排在权限规则瀑布之前——把每个 fs 家族调用的目标路径对照
  会话 cwd 校验。包含判定对**两侧**都做规范化（`realpath`，失败则用原拼写），因此以
  符号链接前拼写到达的目标能匹配服务已按规范形提交的根。workspace 之外的目标在除
  `bypassPermissions` 外的所有模式返回 `{ kind: 'ask' }`（"Operation targets path outside
  session workspace"），该模式允许。非 fs 工具、无路径调用、无 agent 与无 cwd 的执行
  原样放行；该守卫是 pre-execute 便利设施，不是硬性安全边界。
- **`{{cwd}}` 提示变量**：在 `apply()` 中为 cc personas 注册（WeakSet 去重）。

## 已移除

进程内 cwd overlay（`SessionCwdStore`）、写透 holder 与镜像 bridge 均已退役：harness
`workingDirectory` 服务是唯一所有者。`setSessionCwd` / `getSessionCwdForSession` 已删除，
且不再有代码追加 `worktree/entered`（无双写）。

## 消费方

- `tool-git-worktree`：`EnterWorktree` / `ExitWorktree` 经 await 的
  `workingDirectory.set` 提交。
- `subagent/handoff-store`：项目 key 哈希**规范化后**的 cwd（`realpath`），父级的原始
  拼写与管理器规范化的子级拼写因此映射到同一个 key。
- CC 预设（`packages/preset/cc/agent.cordis.yml`）组合本插件，由其安装水合与边界守卫。

## 测试

```bash
cd packages/workspace/session-cwd && npx vitest run tests/
```

（在根 `node_modules` 是沙箱不可写符号链接的 worktree 中，加 `--configLoader runner`
跳过 `.vite-temp` 打包步骤。）
