/** Shared, self-contained reviewer contracts and versioned policy identity. */
import { readFileSync } from 'node:fs'
import { sha256Hex, stableJson } from './schema.ts'
import { POLICY_VERSION } from './policy.ts'
import review from './contracts/review.schema.json' with { type: 'json' }
import author from './contracts/author.schema.json' with { type: 'json' }
import type { Hash } from './types.ts'
import type { ReviewStage } from './review-plan.ts'

export const RUBRIC_VERSION = 'humanities-v1'
export const RULES: Record<string, string> = {
  'SOURCE-01': 'Provenance, edition, transformations and access limits identify the source; unknowns are disclosed.',
  'SOURCE-02':
    'Distinguish authenticity, author stance, source assertions and external facts; first-hand is not a reliability judgment.',
  'SOURCE-03': 'Corroboration requires reviewed source independence, not same-source retellings or unknown lineage.',
  'EVID-02': 'Context preserves negation, paraphrase, irony, qualification and speaker.',
  'SUP-01':
    'Identify actual support faithfully; relevant, unknown or contrary material must not be presented as support.',
  'SUP-02':
    'Conclusion scope and stance do not exceed the evidence; judge joint all groups together, any members independently.',
  'HIST-01':
    'Do not conflate a source saying X with X having happened; check required counterevidence-search sufficiency.',
  'CAUSE-01':
    'Causal conclusions address alternatives and confounders; correlation alone is insufficient. Check core searches.',
  'INTENT-01': 'Distinguish character, narrator, work meaning and author intent. Check core searches.',
  'INTERP-01': 'Interpretation has textual grounds and addresses material alternatives. Check core searches.',
  'EVAL-01': 'Evaluation uses explicit criteria consistently and discloses scope. Check core searches.',
  'ARG-01': 'Required factual premises are registered and supported, without circularity or equivocation.',
  'ARG-02': 'The warrant supports the conclusion without expanding premise scope or certainty.',
  'ISSUE-01':
    'Review the objection and response together; addressed is not accepted; decisive counterevidence cites evidence.',
  'AUDIT-01': 'Every checkable assertion, interpretation and direct quotation is extracted and mapped.',
  'AUDIT-02': 'Body wording does not strengthen stance or broaden registered claim scope.',
  'AUDIT-03':
    'Material issues, counterevidence, limits and gaps appear in the relevant body paragraphs, not only the report.',
  'AUDIT-04':
    'At least one core conclusion; every required question and expected core topic is answered, including honest undetermined answers.',
  'AUDIT-05':
    'Core conclusions include an explanatory step or explicitly state that they are direct facts; material dumps are not answers.',
}
export function loadPrompt(stage: ReviewStage | 'extract' | 'align'): string {
  return readFileSync(new URL(`../prompts/${stage}.md`, import.meta.url), 'utf8')
}
export function promptHash(stage: ReviewStage | 'extract' | 'align'): Hash {
  return sha256Hex(stableJson({ policy: POLICY_VERSION, prompt: loadPrompt(stage) }))
}
export function policyHash(): Hash {
  return sha256Hex(
    stableJson({
      policy: POLICY_VERSION,
      rubric: RUBRIC_VERSION,
      rules: RULES,
      review,
      author,
      prompts: Object.fromEntries(
        ['sources', 'support', 'claims', 'arguments', 'extract', 'align'].map((s) => [s, loadPrompt(s as 'align')]),
      ),
    }),
  )
}
/** Dereference both schema documents before crossing a provider boundary. */
export function expandSchema(value: unknown, doc: unknown = review): unknown {
  if (Array.isArray(value)) return value.map((v) => expandSchema(v, doc))
  if (!value || typeof value !== 'object') return value
  const object = value as Record<string, unknown>
  if (typeof object.$ref === 'string') {
    const [file, fragment] = object.$ref.split('#')
    const root = file ? author : doc
    const target = fragment!
      .slice(1)
      .split('/')
      .reduce((v, k) => (v as Record<string, unknown>)[k]!, root as unknown)
    return expandSchema(target, root)
  }
  return Object.fromEntries(
    Object.entries(object)
      .filter(([k]) => k !== '$id' && k !== '$schema' && k !== '$defs')
      .map(([k, v]) => [k, expandSchema(v, doc)]),
  )
}
export function responseSchemaFor(stage: Exclude<ReviewStage, 'audit'> | 'align'): object {
  const name = {
    sources: 'SourcesResponse',
    support: 'SupportResponse',
    claims: 'ClaimsResponse',
    arguments: 'ArgumentsResponse',
    align: 'AlignResponse',
  }[stage]
  return expandSchema((review.$defs as Record<string, unknown>)[name]) as object
}
