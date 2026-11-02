# @dsh-cc/command-permissions

[English](README.md) | 中文

面向用户的 `/permissions` 斜杠命令，驱动 CC 规则引擎的权限模式：展示生效的权限规则状态，或通过 `/permissions <mode>` 切换会话的权限模式。附带一个小的浏览器 bundle，在裸调用上挂载 `popupSelect` 装饰（以及 TUI 浮层），让每个界面都有模式选择器——且都经由同一个宿主命令写入。

## 用法

```ts
import { apply } from '@dsh-cc/command-permissions'

apply(ctx) // 宿主平面：注册 /permissions 及 CC 目录包装
```

```ts
import { apply as applyClient } from '@dsh-cc/command-permissions/client'

applyClient(ctx) // 浏览器 bundle：裸调用的 popupSelect 装饰
```

## 提供的能力

- `/permissions` —— 不带参数时，渲染只读报告：按来源统计 `allow`/`deny`/`ask` 规则数量并给出合计；权限规则引擎未挂载时返回友好提示。
- `/permissions <mode>` —— 通过引擎的 `setMode` 做持久化模式切换：`default`、`acceptEdits`、`plan`、`auto`、`bypassPermissions`。切到 `plan` 会派发 `/plan`（plan-mode 的命令通道是唯一的跨平面接缝）；从激活的 plan 切走时会先派发 `/plan off`。
- `/permissions grant <descriptorPath> [--confirm]` —— 两阶段创建任务授权：首次运行推导并渲染提案的每个字段，只有再次带上 `--confirm` 运行时才会真正创建授权 〔src:ws:packages/interaction/command-permissions/src/index.ts#L173-L200〕。
- `/permissions grants` —— 列出本会话中处于活跃状态的任务授权 〔src:ws:packages/interaction/command-permissions/src/permissions.ts#L129-L139〕。
- `/permissions revoke <grantId>` —— 撤销一项任务授权 〔src:ws:packages/interaction/command-permissions/src/index.ts#L212-L218〕。
- `/permissions lint [--apply]` —— 对权限规则做卫生检查；`--apply` 会移除失效条目 〔src:ws:packages/interaction/command-permissions/src/lint.ts#L172-L226〕。
- 当 `engine.grants` 接缝缺席时，任务授权子命令（`grant`/`grants`/`revoke`）会回复 `Task grants are not available in this composition.` 〔src:ws:packages/interaction/command-permissions/src/index.ts#L179-L180〕。
- 浏览器客户端（`./client` 导出，由 `tsdown` 打包为 ModuleLoader 工厂）为裸 `/permissions` 调用装饰一个基于共享 `PERMISSION_MODE_OPTIONS` 的模式选择器；选中一项即提交 `/permissions <id>`，因此弹出层与带参路径共用同一条写入路径。`bypassPermissions` 选项附带显式的风险确认。
- 共享的模式列表、标签和 bypass 确认文案集中在 `src/modes.ts`，宿主命令、弹出层和 TUI 浮层读取同一份，避免漂移。

## 备注

- 本包被挂载两次：宿主平面行（包装 `commands.list`，使 CC 会话隐藏宿主 `/permission` 行、非 CC 会话隐藏 `/permissions`）以及注册命令的 CC 预设行。宿主平面的 `dsh.client` 字段供 `dsh-client-modules` 发现浏览器半边。
- 仅注入 `commands`；`permissionRules` 引擎经 `ctx.get` 可选读取，因此即使引擎缺席，命令也能加载并返回友好提示。
- 命令经 `@dsh-cc/command-usage` 包装（模式 id 会作为帮助子命令出现），因此 `help`/`-h`/`--help` 会渲染确定性的帮助文本。
