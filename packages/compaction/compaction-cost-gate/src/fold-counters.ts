/**
 * foldCounters seam for @dsh-cc/token-efficiency (design
 * docs/plans/2026-09-20-token-efficiency-eval-harness.md §3.4).
 *
 * The ledger shape knowledge lives HERE (the feature owns it): any change to
 * the ledger row kinds or path derivation must update this fold and its tests
 * in the same PR — never a silently-wrong foreign regex.
 *
 * @module @dsh-cc/compaction-cost-gate/fold-counters
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { projectKeyOf } from './ledger.ts'

/**
 * Structural materials contract shared by every efficiency-feature fold.
 * Declared locally (no cross-package import); the loose event shape
 * intentionally mirrors SessionLogEvent without depending on dsh-session.
 * The events field is unused by this fold (ledger-only evidence).
 */
export interface FoldCounterMaterials {
  readonly events: readonly {
    readonly type: string
    readonly time?: number
    readonly data?: Record<string, unknown> | undefined
  }[]
  readonly dshHome: string
}

/**
 * Fold the package's own ledger (`<dshHome>/compaction-cost-gate/<projectKey>.jsonl`,
 * same projectKey derivation as the writer) into counts by kind.
 * Missing file → all-zero counters. A trailing partial line (live file
 * truncation) is skipped silently; any OTHER malformed line throws with its
 * 1-based line number.
 */
export function foldCounters(materials: FoldCounterMaterials): Record<string, number> {
  const out = {
    'costgate.gate': 0,
    'costgate.compacted': 0,
    'costgate.skipped': 0,
    'costgate.unavailable': 0,
  }
  const file = join(materials.dshHome, 'compaction-cost-gate', `${projectKeyOf(process.cwd())}.jsonl`)
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return out // missing ledger → zeros, not an error
  }
  const lines = raw.split('\n')
  // A trailing partial line is the live-writer truncation case: drop it silently.
  if (lines.length > 0 && lines[lines.length - 1] !== '') lines.pop()
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (line === '') continue
    let kind: string
    try {
      kind = String((JSON.parse(line) as { kind?: unknown }).kind)
    } catch {
      throw new Error(`compaction-cost-gate fold: malformed ledger line ${i + 1} in ${file}`)
    }
    if (kind === 'gate') out['costgate.gate'] += 1
    else if (kind === 'compacted') out['costgate.compacted'] += 1
    else if (kind.startsWith('skipped:')) out['costgate.skipped'] += 1
    else if (kind === 'compaction-unavailable') out['costgate.unavailable'] += 1
  }
  return out
}
