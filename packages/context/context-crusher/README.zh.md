# @dsh-cc/context-crusher

[English](README.md) | 中文

CCR（Compress-Cache-Retrieve）可逆的工具输出压缩。一个 `tools/post-execute` 监听器压缩大体量的 grep/日志形态的工具结果，把原文缓存到内容寻址存储，并附加 `ccr://<hash>` 标记；`context_retrieve({ hash })` 工具可原样取回原文。原文始终一次调用可得，因此压缩是无风险的。

## 门控流程

1. `tools/post-execute` 触发；crusher 是最外层监听器（`{ prepend: true }`，挂载在 hooks bridge 之前），在 `next()` 之后组合。
2. 下游非 `accept` 的决策原样通过。
3. 门控依序：未启用 → 受保护工具（replace 语义列表）→ 短错误（< 2×min）→ 低于最小尺寸 → 存在非 text 块 → 路由返回 `null` → 节省比例不足。每个门控都退化为透传。
4. `mode: 'dry-run'`（默认）只度量并追加 `applied: false` 的台账行；`mode: 'on'` 存原文、附加标记，并用一个全新 text 块替换结果。下游 `additionalContexts` 在替换后保留。
5. 所有 I/O 错误都退化为透传；缺少 `dshHomePath` 时强制禁用。此处抛错会把用户的工具结果变成错误——数据丢失——因此绝不向瀑布抛错。

## 标记契约（钉死）

`[dsh-cc compressed BEFORE→AFTER tokens. Original: ccr://<hash>]` —— 附加在每个被替换的结果上。`context_retrieve` 的工具描述引用同样的 `ccr://<hash>` 拼写；有测试钉死这一配对。`hash` 为 `sha256(原文 utf8)` 十六进制前 16 位。

## 存储

`$DSH_HOME/ccr/<projectKey>/<hash16>`，projectKey = `sha256(会话 cwd)` 前 16 位（与 TUI 项目根约定的工作树路径分歧在此被接受：存储自身一致）。原子 temp+rename 写入、纯 UTF-8 信封文件、LRU 200 条、TTL 3600 秒、写入后清扫（fire-and-forget）。损坏/过期条目封闭失败（`corrupt` / `expired` / `unknown_hash`）。

## 配置

命名空间 `cc-context-compression`（设置覆盖每次使用时重读；配置默认值在其下）。`protected-tools` 显式设置时替换默认列表——不是并集。

| 键 | 默认 | 含义 |
|---|---|---|
| `enabled` | `false` | 总开关；功能需显式开启。 |
| `mode` | `dry-run` | `dry-run` 只度量；`on` 替换。 |
| `min-bytes` | `8192` | 参与压缩的最小尺寸（按 token 度量；键名保留旧称）。 |
| `min-savings-ratio` | `0.4` | 最小 token 节省比例。 |
| `protected-tools` | 过宽的默认列表 | 永不压缩的工具。 |

## 注意事项

- 转录中永久保留的是压缩后的形态：TUI 回放与 `command-export` 展示压缩块（原文只在存储与台账中）。
- `final-result` 派发与工具定义的 `finalizeContent` 绕过或晚于瀑布，可能重写已压缩内容——残余绕过类别，尽力覆盖。
- 标记是惰性文本；没有自动恢复，也没有模型摘要。
