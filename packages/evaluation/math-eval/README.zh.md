# @dsh-cc/math-eval

[数学研究 Harness](../../plugin/dsh-cc-math) 的结构化评估工具——基准集合、严格的 run-manifest 模式、9 配置计算匹配消融矩阵，以及度量 math 插件真实增益的评分器合同。

## 状态

骨架。类型、manifest 校验、消融矩阵与结构检查已就绪；评分器的 kernel 检查集成与离线 runner 随 M1/M2 波次交付。CI 只跑结构测试——永远不做模型调用。

## 这里钉住了什么

- `src/manifest.ts` — 严格 run-manifest 模式与文档化默认值（`attempts=8`、`tokens=200000`、`wallClockMs=1800000`、`allowHumanFidelity=false`、`tierPolicy="main"`、`discovery=null`）。
- `src/ablation.ts` — 九个消融配置（A–H 外加 F1 单尝试搜索变体）与四个隔离归因对照（C→D 检索、C→E 反馈、H→F 搜索、F→G 经验）。
- `src/scorer.ts` — 评分合同：候选通过当且仅当其陈述与基准参考陈述 kernel 类型相等，且其自身证明通过完整 L2 检查；复述基准定理不算通过。
- `fixtures/gold-set.json` — split 与许可记录。基准内容摄入（miniF2F / ProofNet / PutnamBench 子集）是后续波次；每个 fixture 必须记录 `{source, license, fetchedAt, sha256, problemIds}`，禁止再分发的许可会让检查失败。

## 用法

```sh
pnpm --filter @dsh-cc/math-eval run check   # 结构检查（根命令：pnpm math-eval:check）
pnpm --filter @dsh-cc/math-eval test        # vitest 结构测试
```

真实评估离线按需运行——从不进 CI。

## 设计来源

`docs/plans/2026-11-21-mathematical-research-harness.md` §8–§9。
