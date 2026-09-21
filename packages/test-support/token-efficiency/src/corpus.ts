/**
 * Corpus loader: task descriptors (one YAML file per task) validated into
 * `TaskDescriptor[]` via zod (plan §3.2). Corpus-central choice: descriptors
 * live under this package's `corpus/`; fixtures live under `fixtures/`.
 *
 * @module @dsh-cc/token-efficiency/corpus
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { load } from 'js-yaml'
import { z } from 'zod'

const COUNTER_VALUE_RE = /^(>=|<=|=|>|<)\d+$/

export const counterExpectSchema = z.record(
  z.string(),
  z.string().regex(COUNTER_VALUE_RE, 'counter value must be comparator+int like ">=1" or "=0"'),
)

export const oracleSchema = z.object({
  type: z.string().min(1),
  path: z.string().min(1),
})

export const taskDescriptorSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(['replay', 'mock-script', 'live']),
    fixture: z.string().min(1).optional(),
    prompt: z.string().min(1).optional(),
    oracle: oracleSchema.optional(),
    counters: z.object({ expect: counterExpectSchema }).optional(),
    tags: z.array(z.string()).optional(),
  })
  .superRefine((value, ctx) => {
    const { kind } = value
    if (kind === 'replay') {
      if (value.fixture === undefined) ctx.addIssue({ code: 'custom', message: 'replay requires fixture', path: ['fixture'] })
      if (value.oracle !== undefined) ctx.addIssue({ code: 'custom', message: 'oracle is only valid for mock-script/live, not replay', path: ['oracle'] })
      if (value.counters !== undefined) ctx.addIssue({ code: 'custom', message: 'counters are only valid for mock-script, not replay', path: ['counters'] })
    } else {
      if (value.prompt === undefined) ctx.addIssue({ code: 'custom', message: `${kind} requires prompt`, path: ['prompt'] })
      if (value.fixture !== undefined) ctx.addIssue({ code: 'custom', message: `fixture is only valid for replay, not ${kind}`, path: ['fixture'] })
      if (kind !== 'mock-script' && value.counters !== undefined) {
        ctx.addIssue({ code: 'custom', message: `counters are only valid for mock-script, not ${kind}`, path: ['counters'] })
      }
    }
  })

export type TaskDescriptor = z.infer<typeof taskDescriptorSchema>

/** Load and validate every `*.yaml`/`*.yml` descriptor in `dir` (sorted by filename). */
export function loadCorpusDir(dir: string): TaskDescriptor[] {
  const files = readdirSync(dir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml')).sort()
  return files.map(file => {
    const path = join(dir, file)
    const result = taskDescriptorSchema.safeParse(load(readFileSync(path, 'utf8')))
    if (!result.success) {
      throw new Error(`invalid task descriptor ${path}: ${
        result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
    }
    return result.data
  })
}
