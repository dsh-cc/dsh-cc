# @dsh-cc/bundle-permissions

[English](README.md) | 中文

面向 dsh profile 的 Claude Code 权限对等层，以单个 cordis bundle patch 提供：把普通设置提供者替换为五级设置级联（settings.json 优先级链），并挂载从合并后的 `permissions` 设置段读取规则的 CC 权限规则引擎。

## 用法

本包没有可导入的 API。它通过 `./cordis.patch.yml` 导出作为 bundle patch 消费：

```yaml
bundle:
  patch: '@dsh-cc/bundle-permissions/cordis.patch.yml'
```

## 提供内容

该 patch 按注册顺序完成三处挂载：

- `settings-cc` — `@dsh-cc/settings-cascade` 提供者，遵循 `$DSH_HOME/settings.json` 与项目的 `.claude` 设置文件。内置设置行按 ID 被禁用，避免双重挂载。
- `permission-rules` — `@dsh-cc/permission-rules` 的 allow/deny/ask 规则引擎，惰性读取 `permissions` 设置命名空间。bypass-immune 规则走单调守卫层。
- `command-permissions` — `/permissions` 命令及目录包装的 host 侧挂载；空的 host fiber 是 dsh-client-modules 扫描 popupSelect 浏览器侧的依据。

CC 预设保留自己的 command-permissions 行，因此即使组合中没有本 bundle，`/permissions` 命令仍会被注册。

## 备注

- 权限引擎在调用时惰性读取 `ctx.settings`，挂载顺序不影响正确性；级联放在最前只是为了启动日志可读。
