# @dsh-cc/version-info

「读取自己 `package.json` 版本」这一惯用法的唯一归属。

## 这个包为什么存在

三个包 —— `@dsh-cc/command-version`、`@dsh-cc/config-snapshot` 与
`@dsh-cc/cc-acp` —— 各自带着一份逐字节相同的 `readOwnVersion()` 和自己
的 `FALLBACK_VERSION` 常量。这份重复是刻意的（本仓的 `check:deep-imports` 门
禁止跨包 `src/` 导入），代价是 `scripts/release.mjs` 必须逐个同步改写。
其中一份已经落后了四个发布。

本包是该惯用法的正式归属：消费方从这里重新导出，发布脚本只改写一处常量。

## API

```ts
import { FALLBACK_VERSION, readOwnVersion } from '@dsh-cc/version-info'

const version = await readOwnVersion()          // 本包的 manifest
const version2 = await readOwnVersion('0.0.0')  // 显式指定兜底值
```

`readOwnVersion` 读取编译产物旁的 manifest，文件缺失或不可读时返回兜底值 ——
没有 `package.json` 的打包部署仍然报得出一个版本，而不是抛错。

本工作区所有包共享同一条发布车版本，因此读本包的 manifest 即可回答所有调用方
的问题。

## 契约

- **全域**：永不抛错；manifest 不可读时降级为兜底值。
- **离线**：仅一次本地文件读取，无网络、无时钟依赖。
- **唯一改写点**：`scripts/release.mjs` 只更新这里的 `FALLBACK_VERSION`。
