/**
 * The `bindingDigest` of a frozen delivery handle (§16.1a), split out of
 * `report.ts` purely for the 500-line budget. Pure: no store access, no I/O,
 * no model calls.
 *
 * @module @dsh-cc/vwa-argument/binding-digest
 */

import { sha256Hex, stableJson } from './schema.ts'
import type { DeliveryCheck } from './report.ts'
import type { AdjudicationRecord, Hash } from './types.ts'

/** bindingDigest = SHA256(stableJson({…})) per §16.1a. */
export function computeBindingDigest(
  check: Omit<DeliveryCheck, 'eligibleForReviewed' | 'pendingRunIds'>,
  adjudications: AdjudicationRecord[],
): Hash {
  return sha256Hex(
    stableJson({
      artifactHash: check.artifactHash,
      graphHash: check.graphHash,
      dependencyDigest: check.dependencyDigest,
      policyHash: check.policyHash,
      reviewerConfigHash: check.reviewerConfigHash,
      reviewRecordHashes: check.reviewRunIds,
      checks: check.checks,
      metrics: check.metrics,
      findingCounts: check.findingCounts,
      activeAdjudicationHashes: adjudications.map((record) => sha256Hex(stableJson(record))).sort(),
    }),
  )
}
