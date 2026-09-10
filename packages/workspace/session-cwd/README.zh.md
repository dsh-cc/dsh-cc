# @dsh-cc/session-cwd

[English](README.md) | 中文

面向 DeepSeek Harness CC 的会话级工作目录——[worktree-session-isolation 设计](../../../docs/plans/worktree-session-isolation.md)的
WS1 + WS2 基础。

## 拥有什么

- **`worktree/entered` 会话事件**（WS1）：在模块加载时注册进持久化层的
  `KNOWN_SESSION_EVENT_TYPES`，因此含它的日志可干净恢复。载荷：`{ path }`——
  新的绝对会话 cwd。
  `ExitWorktree` 经同一事件恢复上一个目录（last-wins 折叠）。
- **可折叠状态**（`src/state.ts`）：`foldSessionCwd` 把当前 cwd 从事件日志折叠出来；
  进程内的 `SessionCwdStore` overlay 叠放实时值，读取即时生效，且同进程内各会话
  相互独立。
- **API**（`src/api.ts`）：`getSessionCwd(agent)`（实时 overlay → 持久折叠 →
  会话头部 → 回退）和 `setSessionCwd(agent, path)`（持久事件 + overlay；仅接受
  绝对路径）。
- **workspace 边界守卫**（WS2，`src/listener.ts`）：一个以 `{ prepend: true }`
  注册的 `tools/pre-execute` 监听器——排在权限规则瀑布之前——把每个 fs 家族调用的
  目标路径对照会话 cwd 校验。workspace 之外的目标在除 `bypassPermissions` 外的
  所有模式返回 `{ kind: 'ask' }`（"Operation targets path outside session workspace"），
  该模式允许（既有审计痕迹覆盖它）。非 fs 工具、无路径调用、以及无法解析出 cwd 的
  agent 原样放行；该守卫是 pre-execute 便利设施，不是硬性安全边界。

## 消费方

- `tool-git-worktree`：`EnterWorktree` 调用 `setSessionCwd(worktreePath)`；
  `ExitWorktree` 以同样方式恢复 `session.originalCwd`。
- TUI 驱动器：项目/历史解析优先用持久折叠而非启动时头部的 cwd。
- CC 预设（`packages/preset/cc/agent.cordis.yml`）组合本插件，由其安装边界守卫。

## 测试

```bash
cd packages/workspace/session-cwd && npx vitest run tests/
```

（在根 `node_modules` 是沙箱不可写符号链接的 worktree 中，加 `--configLoader runner`
跳过 `.vite-temp` 打包步骤。）
