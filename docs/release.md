# Release (npm) runbook

本文面向 dsh-cc 的维护者。tag 推送自动发布全部非 private 包到 npmjs;
版本走 lockstep(所有可发布包同版号)。发布由本仓 `.github/workflows/publish.yml`
驱动,presubmit 不做发布。

## 概述

`git push` 一个 `v*` tag 即触发 [Publish (npm)](../.github/workflows/publish.yml):
它与 presubmit 等价的全量门禁全部跑完后,再把**所有非 private 包**发布到
npmjs 并打 GitHub Release。CI 校验 tag 与版本清单一致(`scripts/check-release-version.mjs`)
才放行,防止 tag 与清单失配。发布可重跑:已发布版本自动跳过,断点续发。

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

发布脚本带 dry-run:

```bash
pnpm release <x.y.z[-rc.N]> --dry-run   # 先看会改哪些版本、改哪个 tag,不改任何文件
pnpm release <x.y.z[-rc.N]>             # 改写所有可发布包版本 → 提交 → 打 tag
```

人工核对:
- 版本号与计划一致,恰为 `x.y.z`(正式)或 `x.y.z-rc.N`(预发布);
- 提交与 `vX.Y.Z` tag 就位(带 `--dry-run` 不会真的改动它们)。

然后一条命令同推 main 和 tag:

```bash
git push origin main vX.Y.Z
```

顺序反了或漏推 main 会被祖先门禁拦下(workflow 校验 `vX.Y.Z` 必须落在
`origin/main` 上的提交)。推完去 Actions 观察 **Publish (npm)** 跑完、全绿。

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

## token 轮换

granular token 最长 1 年。到期前在 npmjs 生成新 token 并替换 GitHub secret;
或完成上面的 OIDC 升级后不再依赖静态 token。
