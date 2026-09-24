# @dsh-cc/tool-manage-skill

[English](README.md) | 中文

面向模型的 `manage_skill` 工具，用于 learned skills（计划
`docs/plans/2026-09-23-learned-skills.md` §4.4）。无条件挂载在 CC preset 的
cc-services 组内；`cc-learn.enabled` 门控在调用时读取。

## 行为

- **动作**：`create`（需要 `name`、`description`、`body`）、`update`
  （需要 `name` 及 `body`/`description` 至少其一；其余 frontmatter 键全部保留）、
  `delete`（删除整个技能目录）、`list`（每个技能一行：
  `<name> — <description> (<bytes> B) — <path>`；空根目录输出 "no learned skills"）。
- **存储**：复用 `@dsh-cc/skill-loader` 的共享 `LearnedSkillStore`，根目录为
  `$DSH_HOME/learned-skills/`。写入是原子的（创建用 wx；更新用临时文件+rename；
  删除用 `rm -r`）。
- **门控**：直接读取 `settings.get('cc-learn')`；缺少配置节或服务时默认启用。
  关闭时返回非错误文本
  "manage_skill is disabled (`cc-learn.enabled` is false in settings)."
- **错误**：`isError: true` 的工具结果携带稳定代码词——`invalid_name`、
  `invalid_params`、`too_large`、`shadowed`、`already_exists`、`not_found`
  （store 附加 authored-claimant 提示时一并提供）。
- **刷新**：每次成功变更都会发出包私有的 `skills/learned-changed` cordis 事件，
  令技能注册表失效其 collect 缓存（§4.5）；失败不发出。
- **晋升指引**（写入工具描述）：只晋升过程性、可复用的经验（"如何在这里做 X"）；
  事实与机密留在 memory，绝不写入 learned skill。
