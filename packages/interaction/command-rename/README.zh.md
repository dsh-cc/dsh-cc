# @dsh-cc/command-rename

[English](README.md) | 中文

面向用户的 `/rename <title>` 命令：通过可选的宿主 `sessionTitle` 服务为当前会话固定一个显式用户标题。该插件通过 [`ctx.commands`](../../interaction/commands/README.md) 注册一个全局命令。

## 命令约定

| 输入 | 结果 |
|---|---|
| `/rename <title>` | 将会话重命名为去除首尾空白后的 `<title>`。标题服务会固定它，自动生成随之停止调度。回复 `Renamed to: <title>`。 |
| `/rename`（无参数） | 错误：`Usage: /rename <title>`；不会调用服务。 |

命令在运行时经 `ctx` 发现可选的 `sessionTitle` 衔接服务——缺少它的组合会回复 `renaming is unavailable: this deployment mounts no session-title service`。服务抛出的校验失败（例如标题不含可见字符）会原样作为命令错误文本透传。

## 组合

生产方注入 `commands`。在组合了会话标题服务的应用中挂载即可（CC preset 用户已内置）：

```yaml
- id: command-rename
  name: '@dsh-cc/command-rename'
```

## 模型体验

斜杠输入与直接输出都不会进入模型请求，也不消耗模型 token。重命名本身是宿主侧日志事件（source 为 `user` 的 `session/title`），从不进入模型面。

## 已知限制与暂缓事项

- **无交互确认**——重命名立即生效；撤销就是再执行一次 `/rename`。
- **无选择器**——CC 的标题建议/重命名菜单不在范围内；只支持带 `<title>` 参数的形式。
