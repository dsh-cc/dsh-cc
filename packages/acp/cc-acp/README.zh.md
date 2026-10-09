# @dsh-cc/acp

[English](README.md) | 中文

Agent Client Protocol（ACP，v1）服务器，让 ACP 客户端（如 Zed）通过 stdio 上的 JSON-RPC 驱动 dsh-cc agent。本包是 `@deepseek-ai/dsh-acp`（deepseek-harness 的 `packages/acp/acp`，MIT — 见 `LICENSE-harness`）的逐字 vendor，固定于 `c1b47e41fcd54d20a0f061df28683bfc29ee24e5`；每个移植文件都带出处头，CC 侧的分歧必须记录在 `DIVERGENCE.md`。vendor 与扩展计划见 `docs/plans/2026-10-09-acp-m2-own-plugin.md`。
