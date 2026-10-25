# @dsh-cc/plugin-dsh-cc-writing

[English](README.md) | 中文

官方 dsh-cc 插件，提供文章写作、文章评审和语言修改。包含三个公开 skill 和一个支撑 skill。

## 组件

| Skill | 用途 | 用户任务 |
| --- | --- | --- |
| `article-writing` | 规划论证、逐节起草并修改文章结构 | 是 |
| `article-review` | 报告结构、逻辑和语言问题，不修改正文 | 是 |
| `language-editing` | 通过局部修改提升清晰度、简洁度和风格 | 是 |
| `writing-workflow` | 共享运行协议、schema、profile 和脚本 | 否 |

三个公开 skill 支持中文和英文文章，覆盖技术说明、文献综述和观点文章。

`writing-workflow` 是支撑 skill。公开 skill 从已安装目录读取它，它不会作为独立任务出现。

## 安装

使用支持插件安装命令的 Claude 兼容客户端。

```text
/plugin marketplace add dsh-cc/dsh-cc
/plugin install dsh-cc-writing@dsh-cc
```

重启 dsh 以加载插件。用 `/skills` 查看 `article-writing`、`article-review` 和 `language-editing`。

安装不会默认把插件加入已启用列表。需要写作流程时再安装。

## 更新

先更新插件市场，再更新已安装的插件缓存。

```text
/plugin marketplace update dsh-cc
/plugin update dsh-cc-writing@dsh-cc
```

完成插件更新后请重启 dsh。仅更新插件市场不会更新已安装的插件。

## 使用

先通过 `/skills` 发现 skill，然后用自然语言描述任务。明确写出 skill 名称时优先于自动匹配。

撰写新文章或重写已有结构：

```text
用 article-writing 写一篇关于港口关闭的中文文章。
读者是区域物流管理者。写入 docs/articles/port.md。
保留来源报告中的条件和不确定性。
```

只做评审、不修改正文：

```text
用 article-review 按同一批读者评审 docs/articles/port.md。
不要修改文章。先报告主要问题。
```

润色语言并保留含义：

```text
用 language-editing 改进 docs/articles/port.md。
保留所有数字、引文和技术术语，不要改变任何论断。
```

请求中没有读者时，插件会询问读者。新文章没有输出路径时，插件会建议
`docs/articles/<slug>.md` 并询问。

## 一次运行产出什么

每次运行在伴随目录下写入 `runs/<runId>/`。对 `docs/articles/port.md`，默认伴随目录是
`docs/articles/port.writing/`。

运行目录保存 brief、plan、各阶段评审、修改提案、保留性检查和
`editorial-report.md`。正文仍留在请求的路径。报告列出结果、问题、修改和限制。

脚本不发起任何网络调用或模型调用，也不写 VWA 项目文件。

## 证据模式

普通模式不需要 VWA 设置。插件不依赖 `dsh-cc-agents` 也能工作。

需要登记来源时，可以直接要求 VWA 证据审查。插件随后使用五个 VWA 工具，
并把编辑报告与 VWA 报告分开保存。

证据模式需要 VWA 运行时：交付工具、语义设置、VWA preset 和已初始化的项目。
缺少条件时，插件在一次消息中给出全部步骤。它不修改你的设置，
也不会把明确的证据请求切换成普通模式。

只做证据工作、不改文章时，仍由 `dsh-cc-agents` 的 `vwa-writing` 处理。
同时要求两者时，由 `article-writing` 编排流程并使用 VWA 适配器，
`vwa-writing` 不会再开第二个编辑循环。

## 限制

- 脚本只能证明文件身份和保留性。结构和语义问题是模型判断，不是证明。
- 保留性检查通过不代表含义没有改变。
- 扫描器可能漏掉中文数字、隐含因果和转述引文。报告会说明这一限制。
- 版本 1 对每个正文只支持一个协作写入者。请使用默认伴随目录，
  这样脚本会拒绝并发运行，而不是合并它们。
- 编辑报告是本地派生数据，agent 可以修改它，它不是防篡改回执。
- 编辑结果不会设置 VWA 评级。只有 VWA 运行时和用户命令决定审查状态。
- 插件不做翻译，也不编辑 DOCX 或 PDF 文件。

## 资源

安装包包含三个公开 skill、[共享流程](skills/writing-workflow/SKILL.md)、
[阶段流程](skills/writing-workflow/references/workflow.md)、
[产物契约](skills/writing-workflow/references/contracts.md)、
[评审细则](skills/writing-workflow/references/review-rubric.md)、
[VWA 适配器](skills/writing-workflow/references/vwa-adapter.md)、四个 profile，
以及[中文](skills/writing-workflow/examples/zh.md)和
[英文](skills/writing-workflow/examples/en.md)修改示例。

相对资源从已安装的 skill 目录解析，不需要仓库检出。
