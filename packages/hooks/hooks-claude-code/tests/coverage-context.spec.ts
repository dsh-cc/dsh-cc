import { vi } from 'vitest'
import { defineCoverageCases } from './coverage-cases.ts'

// TIMEOUT-BUDGET: keep byte-identical across spec files.
// scale: DSH_TEST_TIMEOUT_SCALE (debug override), else 2 on GitHub Actions, else 1.
// Must be an integer in [1,4]; anything else → 1. Values >2 exceed what R4 was sized for.
const raw = Number(process.env.DSH_TEST_TIMEOUT_SCALE ?? (process.env.CI === 'true' ? 2 : 1))
const scale = Number.isInteger(raw) && raw >= 1 && raw <= 4 ? raw : 1
vi.setConfig({ testTimeout: 30_000 }) // flat (R4); per-file Σ audit lives in coverage-cases.ts.

defineCoverageCases('context')
