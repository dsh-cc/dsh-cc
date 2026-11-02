# @dsh-cc/acp

English | [中文](README.zh.md)

Agent Client Protocol (ACP, v1) server that lets an ACP client (e.g. Zed) drive dsh-cc agents over JSON-RPC on stdio 〔src:ws:packages/acp/cc-acp/src/index.ts#L1-L12〕. This package is a verbatim vendor of `@deepseek-ai/dsh-acp` (`packages/acp/acp`, deepseek-harness, MIT — see `LICENSE-harness`) 〔src:ws:packages/acp/cc-acp/LICENSE-harness#L1-L3〕, pinned at `31cfe2aafead959a4dbd9d8cfaae258eb28a19fd` (@deepseek-ai/dsh-acp 0.2.1-rc.5) 〔src:ws:packages/acp/cc-acp/DIVERGENCE.md#L1-L12〕; every ported file carries a provenance header 〔src:ws:packages/acp/cc-acp/src/index.ts#L1-L3〕 and CC-specific divergences must be recorded in `DIVERGENCE.md` 〔src:ws:packages/acp/cc-acp/DIVERGENCE.md#L14-L15〕. The vendoring and extension plan is described in `docs/plans/2026-10-09-acp-m2-own-plugin.md` 〔src:ws:docs/plans/2026-10-09-acp-m2-own-plugin.md#L1-L8〕.
