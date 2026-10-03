# @dsh-cc/sidecar-io

[English](README.md) | 中文

dsh-cc 观察者包共享的 sidecar IO 基础设施：dsh-home 解析、project-key 哈希、以及出错即吞掉的 JSONL 账本追加/读取。账本的排序/裁剪仍由各包自行负责；本模块只承载原先在五个包间复制的逐字节相同的原语。

## 导出

| 导出 | 类型 | 说明 |
|---|---|---|
| `HomeFn` | 类型 | `(...segments: string[]) => string` — `ctx.dshHomePath` 解析器的形状。 |
| `dshHomeFn(ctx)` | 函数 | 防御式读取 `ctx.dshHomePath`；cordis 在属性访问本身即抛错，因此读取需加保护。缺失时返回 `undefined`。 |
| `shortHash(input, width = 16)` | 函数 | sha256 十六进制前 `width` 个字符 — 共享的 project/content key 形状。 |
| `projectKeyOf(cwd, width = 16)` | 函数 | `shortHash(cwd, width)` 的别名，用于账本 project key。 |
| `jsonlPath(root, ...parts)` | 函数 | dsh-home 根目录下账本文件的路径拼接。 |
| `appendJsonl(filePath, row)` | 异步 | `mkdir -p` 父目录后追加 `JSON.stringify(row) + '\n'`。从不抛错。 |
| `readJsonl<T>(filePath)` | 异步 | 逐行解析，跳过空行与畸形行（撕裂的尾部写入被跳过而非致命）。从不抛错。 |

## 消费方

- `@dsh-cc/reasoning-fold`
- `@dsh-cc/cache-health`
- `@dsh-cc/compaction-cost-gate`
- `@dsh-cc/tool-use-summary`
- `@dsh-cc/context-crusher`
