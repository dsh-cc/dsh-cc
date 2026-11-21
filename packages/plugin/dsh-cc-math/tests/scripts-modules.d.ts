// The math-research skill scripts are plain .mjs files (node-stdlib-only, by
// design — see docs/plans/2026-11-21-mathematical-research-harness.md §3.1).
// Tests import them directly; this wildcard declaration keeps the strict
// package typecheck green without forcing JSDoc typing onto every script.
// The scripts' real contracts are pinned by the runtime tests themselves.
declare module '*.mjs'
