# Release (npm) runbook

本文面向 dsh-cc 的维护者。tag 推送自动发布全部非 private 包到 npmjs;
版本走 lockstep(所有可发布包同版号)。发布由本仓 `.github/workflows/publish.yml`
驱动,presubmit 不做发布。

## 概述

`git push` 一个 `v*` tag 即触发 [Publish (npm)](../.github/workflows/publish.yml):
它与 presubmit 等价的全量门禁全部跑完后,再把**所有非 private 包**发布到
npmjs 并打 GitHub Release。CI 校验 tag 与版本清单一致(`scripts/check-release-version.mjs`)
才放行,防止 tag 与清单失配。发布可重跑:已发布版本自动跳过,断点续发。

**preset 插件闭包不变量**(0.7.1 起):CC preset 的每个 `@dsh-cc/*` 行必须能
从 launcher 的三个 bundle 出发、只走运行时 `dependencies`、且全部经过**非
private 包**到达 —— 由 `packages/preset/cc/tests/composition.spec.ts` 的
closure-reachability 门禁守护。`@dsh-cc/preset-cc`(及 `command-learn`、
`session-forensics`)必须保持可发布:它们一旦回到 private,preset 行在
store 安装上将无法解析(v0.5.0–v0.7.0 曾因此全线无法启动)。

## 首次发布前的手动准备(一次性)

1. **npm granular access token**(为什么:授权范围最小、无全局写入权):
   在 npmjs → Access Tokens 创建一个 granular token,权限 **Read+Write**,
   scope 选 `@dsh-cc`(若平台不提供 scope 粒度,先选 **All packages**,发布后
   收窄回 scope 粒度)。过期时间最长 **1 年**。
   然后到 GitHub repo → Settings → Secrets and variables → Actions,新建仓库
   secret **`NPM_TOKEN`**,值填该 token。发布 workflow 的发布时间(bootstrap)
   完全由它供电。

2. **建议创建 GitHub Environment `npm-publish`** 并配 required reviewers
   (为什么:publish.yml 的 `environment: npm-publish` 引用它,给发布加一道
   人工确认;若不存在,GitHub 会在首次运行时**隐式自动创建**,不影响 workflow
   运行 —— 创建它只是获得 reviewers 门控)。

## 发布 SOP

> **重要**：`main` 受 org ruleset 保护——**只接受 PR、禁止 merge commit**（只能
> rebase/squash）。因此不能按老流程直接 `git push origin main vX.Y.Z`。
> rebase 合并会改写 commit sha，所以 **tag 要在合并后重指到 main 上的新 sha**。

发布脚本带 dry-run:

```bash
pnpm release <x.y.z[-rc.N]> --dry-run   # 先看会改哪些版本、改哪个 tag,不改任何文件
pnpm release <x.y.z[-rc.N]>             # 改写所有可发布包版本 → 提交 → 打 tag
```

人工核对:
- 版本号与计划一致,恰为 `x.y.z`(正式)或 `x.y.z-rc.N`(预发布);
- 提交与 `vX.Y.Z` tag 就位(带 `--dry-run` 不会真的改动它们)。

然后走 PR 流程同推 main 和 tag(rebase 合并保留单 commit 线性历史):

```bash
git switch -c release-<x.y.z>                  # 从 release 提交建分支
git push -u origin release-<x.y.z>
gh pr create --title "chore(release): vX.Y.Z" --base main --head release-<x.y.z>
gh pr merge <PR号> --rebase                    # sha 会被改写!
git fetch origin main && git tag -f vX.Y.Z origin/main
git push origin vX.Y.Z --force                 # 覆盖脚本先打的旧 sha tag
```

强推 tag 会触发 [Publish (npm)](../.github/workflows/publish.yml) 重跑(幂等:
脚本先打的旧 sha tag 触发的首跑会因 tag 不在 main 祖先上失败,新跑放行)。
workflow 校验 `vX.Y.Z` 必须落在 `origin/main` 上的提交。推完去 Actions 观察
**Publish (npm)** 跑完、全绿。

## dist-tag 约定

- 正式版(`v1.2.3`)→ `latest`;预发布(`v1.2.3-rc.1`)→ `next`。
- 与 deepseek-harness 一致:**prerelease 永不占 `latest`**,装稳定版不受
  rc 干扰。

## 重跑语义

- `pnpm -r publish` 自动跳过 registry 上已存在的版本 → 中断后续跑是
  **断点续发**,不是重新发布。
- `--tag` 会对已发布版本**重挂 dist-tag**(校正 tag 用)。
- 同一 tag 可用 **workflow_dispatch**(GitHub → Actions → Publish (npm) →
  Run workflow,填 tag)手动重跑,无需重新推 tag。

## 升级到 Trusted Publishing(OIDC,可选加固)

把静态 token 换成 OIDC 短时凭据;发布 workflow 已内置兼容,无需改文件。

1. npmjs 里对**每个包**:Settings → Trusted Publisher ➜ 新增 trusted publisher,
   填 `dsh-cc` / `dsh-cc` / `publish.yml` / `npm-publish`。
2. 全部包配完后,删除 GitHub 的 `NPM_TOKEN` secret。
3. 用**下一个 rc tag** 验证 OIDC 路径确能发布,再切换日常流程。
4. 若 OIDC 失败,回退 = 重新补上 `NPM_TOKEN` secret(不必动别的)。

## 与 deepseek-harness 的联动

`node scripts/check-publish-manifests.mjs`(即 pnpm `check:publish`)
在 deepseek-harness sibling 存在时,校验每个包对 `@deepseek-ai/dsh-*` 的
**peer 下限仍命中当前 pin 的 harness 版本**。升级 harness pin(`DSH_HARNESS_REF`)
跨版本族时(如 `0.1.1 → 0.2.0`)必须同步提高 peer range,否则 presubmit 会拦截。

2026-09-12:harness 锚点已迁移至 0.1.5-rc.1(`DSH_HARNESS_REF=1ef9c1fa9a`),
相关 peer 下限同步提高至 `>= 0.1.5-rc.1`。

## token 轮换

granular token 最长 1 年。到期前在 npmjs 生成新 token 并替换 GitHub secret;
或完成上面的 OIDC 升级后不再依赖静态 token。

## Daily Release RC ladder（工作日自动提案）

工作日 08:00 北京时间（cron `0 0 * * 1-5`，UTC 00:00）由
[daily-release.yml](../.github/workflows/daily-release.yml) 跑一次**提案**
（只开 `release/v*` 分支 + PR，**从不**在本 workflow 里 tag / publish）。
决策在 `scripts/daily-release-decide.mjs`，时区按 **Asia/Singapore** 的
周一至周日自然周：

| 条件 | 动作 |
|------|------|
| 本周（周一–周日 SGT）已有正式版 `vX.Y.Z` | **跳过**全部提案 |
| main 相对上一正式版无未发布提交 | **跳过**（可触发 stuck-publish 恢复：若该正式版缺 GitHub Release 则重派 `publish.yml`） |
| 本周尚无该候选线上的 rc | 提案下一线路 `X.Y.Z-rc.1`（含周中首次跑） |
| 上一 rc 之后 main 有新提交 | 提案 `X.Y.Z-rc.(N+1)` |
| 上一 rc 之后无新提交 | 提案正式版 `X.Y.Z` |

线路 bump：`auto` 时自上一正式版以来有 conventional `feat` → minor，否则
patch；`workflow_dispatch` 可显式选 `patch` / `minor`。

### 人工门禁

1. **合并 release PR**：仍走 main 的分支保护（rebase/squash）；合并后
   [release-tag.yml](../.github/workflows/release-tag.yml) 打 tag 并
   dispatch publish。
2. **npm 发布**：`publish.yml` 的 `npm-publish` environment 需人工批准。
3. **不要**在 daily-release 里手动补 tag；缺 Release 时用
   `gh workflow run publish.yml -f tag=vX.Y.Z`。

### dist-tag

- 预发布（`vX.Y.Z-rc.N`）→ npm dist-tag **`next`**
- 正式版（`vX.Y.Z`）→ npm dist-tag **`latest`**
- prerelease **永不**占 `latest`（与上文「dist-tag 约定」一致）

### 9/15 故障根因（已修）

[actions/runs/34928203604](https://github.com/dsh-cc/dsh-cc/actions/runs/34928203604)：
gate 用版本序 `v*` 选中了 `LAST_TAG=v0.7.1-rc.3`，随后
`daily-release-next-version.mjs` 拒绝 prerelease 基线导致 job 失败。
现改为单独选取最高**正式** tag 作 `lastStable`，并在候选线上爬 rc 梯；
CI **不再**调用旧的 stable-only 路径。

