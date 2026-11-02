# @dsh-cc/acp

[English](README.md) | 中文

Agent Client Protocol（ACP，v1）服务器，让 ACP 客户端（如 Zed）通过 stdio 上的 JSON-RPC 驱动 dsh-cc agent 〔src:ws:packages/acp/cc-acp/src/index.ts#L1-L12〕。本包是 `@deepseek-ai/dsh-acp`（deepseek-harness 的 `packages/acp/acp`，MIT — 见 `LICENSE-harness`）的逐字 vendor 〔src:ws:packages/acp/cc-acp/LICENSE-harness#L1-L3〕，固定于 `31cfe2aafead959a4dbd9d8cfaae258eb28a19fd`（@deepseek-ai/dsh-acp 0.2.1-rc.5） 〔src:ws:packages/acp/cc-acp/DIVERGENCE.md#L1-L12〕；每个移植文件都带出处头 〔src:ws:packages/acp/cc-acp/src/index.ts#L1-L3〕，CC 侧的分歧必须记录在 `DIVERGENCE.md` 〔src:ws:packages/acp/cc-acp/DIVERGENCE.md#L14-L15〕。vendor 与扩展计划见 `docs/plans/2026-10-09-acp-m2-own-plugin.md` 〔src:ws:docs/plans/2026-10-09-acp-m2-own-plugin.md#L1-L8〕。
