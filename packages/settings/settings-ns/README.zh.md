# @dsh-cc/settings-ns

English | [中文](README.md)

**幂等的 settings 命名空间注册**，面向按会话挂载的 preset（设计文档：docs/plans/2026-09-16-settings-namespace-idempotence.md）。preset 插件在每次会话挂载时向应用级共享 `SettingsProvider` 注册自己的 settings 命名空间；harness 的 `register()` 对重复命名空间直接抛错，而 `/clear` 前后的"先创建、后销毁"重叠窗口里两个挂载会相撞，导致整个 preset 挂载失败。本包提供两个助手——`registerNamespaceSafe` 和 `installSectionSafe`——把重复注册降级为实时读取，并在命名空间属主 fiber 消亡后懒式重新获取。

## API

```ts
export interface SafeRegisterOptions<T> {
  base?: Record<string, unknown>    // 组合 base 层透传
  validate?: (value: T) => void     // 跨字段校验透传
}

export type SettingsReader<T> = () => T | undefined

export function registerNamespaceSafe<T>(ctx: Context, ns: SettingsNamespace, schema: z<T>, options?: SafeRegisterOptions<T>): SettingsReader<T>

export interface SectionHooks<T> { setSource; onChange; validate? }
export function installSectionSafe<T>(ctx: Context, ns: SettingsNamespace, schema: z<T>, entry: T, hooks: SectionHooks<T>): void
```

## 语义

- **无 provider → `undefined`。** 没有 `ctx.get('settings')` 时 reader 每次调用都返回 `undefined`；调用方保持既有的优雅降级行为。
- **直读事实源。** reader 始终经 `settings.get(ns)` 解析，绝不读缓存的 scope 对象，因此已销毁的属主不会吐出陈旧的冻结值。假设对象 schema（`z.object(...)`）：合法的解析值永不为 `undefined`，这正是自愈触发条件无歧义的前提。
- **懒式自愈。** 当读取观察到 `undefined` 且启动期上下文仍然存活时，reader 用相同 schema/options 重新注册并重读——每个丢失的属主只产生一对 register/unregister。
- **重复注册容忍。** 匹配 `settings namespace "<ns>" is already registered` 的 `register()` 抛错（常量钉死、spec 防上游漂移）降级为实时 provider 读取。值保真警告：双模块副本 schema 不同时，降级路径读到的是另一副本的解析值。
- **陈旧 reader 绝不抛错。** 在已销毁/正在卸载的上下文上重新获取（cordis `CordisError` 码 `INACTIVE_EFFECT`）降级为 `undefined`，绝不向热读路径抛错。其余 register 错误照常传播。
- **`installSectionSafe` 预检。** 命名空间已被占用时不调用 harness 的 `installSection`：直接接线 hooks（`setSource` 实时读 `settings.get(ns)`；重载通知来自 provider 公开的 `settings/updated` 提交事件，按命名空间过滤、属主 ctx 卸载后失效、随调用方挂载一起解除）。全新路径原样委托。属主消亡后不重新注册——走调用方既有的回退契约，与 harness 自身的 provider 丢失语义一致。
- 只读契约：助手只返回 reader / 接线 hooks；需要写/订阅的消费方继续直接调用 provider。

## 形态

纯库包：无 preset 行、无 capability manifest 条目。preset 行注册方以 `dependencies` 中的 `workspace:^` 依赖它（保证进启动闭包），peer 依赖 harness 的 `@deepseek-ai/cordis` 与 `@deepseek-ai/dsh-settings`。
