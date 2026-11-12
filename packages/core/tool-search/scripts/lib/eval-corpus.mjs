/**
 * Corpus schema validation for the tool-discovery activation eval
 * (`docs/plans/2026-11-12-tool-discovery-activation.md` § "Corpus").
 *
 * Extracted from `scripts/eval-discovery.mjs` so the specs can validate a
 * generated corpus without spawning the CLI, and so the schema lives in exactly
 * one place for every arm (`selfcheck`, `judge-stub`, `live`).
 *
 * Schema (v2):
 *   { schemaVersion: 2, corpusVersion: <integer >= 1>, description?: string,
 *     cases: Case[] }
 *   Case = {
 *     id: string,                          // unique; the only case text ever printed
 *     subset: 'chinese' | 'synonym' | 'none' | 'restricted',
 *     class: ClassLabel,                   // the gating dimension
 *     alsoClasses?: ClassLabel[],          // declared multi-label membership
 *     query: string,
 *     candidates: Candidate[],
 *     expectedNames: string[],             // the human target set, post-admission
 *     notes?: string,
 *   }
 *   Candidate = {
 *     name: string, description: string, searchHint?: string,
 *     lexicalScore: number,                // the lexical baseline's score
 *     admitted?: boolean,                  // false = the scope's permission gate denies it
 *   }
 *
 * `subset` stays a legacy filter with its own floors; `class` is what the
 * per-class gates count. The two coexist so class `negative-only` rows can also
 * satisfy the existing subset-`none` rules instead of forcing a second corpus.
 *
 * Privacy: every message names the case id and the field path only. Query text,
 * candidate names and descriptions never reach a message — the evaluator is
 * safe to run on fixtures that must not be echoed.
 */

/** Legacy case filters, in report order. */
export const SUBSETS = ['chinese', 'synonym', 'none', 'restricted']

/** Minimum number of cases each legacy subset must carry. */
export const REQUIRED_SUBSET_COUNTS = { chinese: 8, synonym: 6, none: 4, restricted: 2 }

/**
 * The five labeled classes (design § "Corpus"): (a) direct-fit, (b) lexical
 * overlap / wrong-server traps, (c) multi-intent, (d) negative-only, (e)
 * metadata keyword-stuffing.
 */
export const CLASSES = ['direct-fit', 'lexical-trap', 'multi-intent', 'negative-only', 'keyword-stuffing']

/** Minimum cases per class, counting primary and `alsoClasses` memberships. */
export const REQUIRED_CLASS_COUNTS = Object.fromEntries(CLASSES.map(label => [label, 12]))

/** The only corpus schema version this validator accepts. */
export const SCHEMA_VERSION = 2

/** The message a v1 document gets: name the fix, not just the refusal. */
const V1_FIX = 'a v1 corpus carries no class labels or corpusVersion — set "schemaVersion": 2, add "corpusVersion": 1 and give every case a "class"'

/** Whether a parsed value is a plain object with the given own keys. */
const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value)

/** Whether a value is a non-empty string after trimming. */
const isNonEmptyString = value => typeof value === 'string' && value.trim().length > 0

/**
 * Every counter a report may print, at zero.
 * @returns the subset and class counts keyed flat by label.
 */
function emptyCounts() {
  const counts = {}
  for (const subset of SUBSETS) counts[subset] = 0
  for (const label of CLASSES) counts[label] = 0
  return counts
}

/**
 * Validate a parsed corpus document against the v2 schema.
 * @param parsed - the parsed JSON document (a bare case array is rejected as v1).
 * @returns {{errors: string[], floors: string[], cases: object[], counts: Record<string, number>}}
 *   the violations, the floor deficits alone (`selfcheck` treats them as fatal;
 *   a scoring arm may still run and report them), the usable cases, and the
 *   subset/class counts (flat: subset labels and class labels share one object,
 *   their names never collide).
 */
export function validateCorpus(parsed) {
  const errors = []
  const floors = []
  const counts = emptyCounts()

  if (Array.isArray(parsed)) {
    errors.push(`corpus must be an object: a bare case array is the v1 layout — ${V1_FIX}`)
    return { errors, floors, cases: [], counts }
  }
  if (!isObject(parsed)) {
    errors.push(`corpus must be an object: ${V1_FIX}`)
    return { errors, floors, cases: [], counts }
  }
  if (parsed.schemaVersion !== SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${SCHEMA_VERSION}: ${V1_FIX}`)
  }
  if (!Number.isInteger(parsed.corpusVersion) || parsed.corpusVersion < 1) {
    errors.push('corpusVersion must be an integer >= 1 (bump it whenever the cases change; every report pins it)')
  }
  if (parsed.description !== undefined && typeof parsed.description !== 'string') {
    errors.push('description must be a string when present')
  }
  if (!Array.isArray(parsed.cases)) {
    errors.push('cases must be an array')
    return { errors, floors, cases: [], counts }
  }

  const seenIds = new Set()

  parsed.cases.forEach((entry, index) => {
    const where = isObject(entry) && isNonEmptyString(entry.id) ? entry.id : `cases[${index}]`
    if (!isObject(entry)) {
      errors.push(`${where}: case must be an object`)
      return
    }
    if (!isNonEmptyString(entry.id)) errors.push(`${where}: id must be a non-empty string`)
    else if (seenIds.has(entry.id)) errors.push(`${where}: duplicate id`)
    else seenIds.add(entry.id)
    if (entry.notes !== undefined && typeof entry.notes !== 'string') errors.push(`${where}: notes must be a string`)

    // `class` is the gating dimension; `alsoClasses` only declares membership in
    // additional classes (counted for the floors, never as a second primary).
    const primaryClass = CLASSES.includes(entry.class) ? entry.class : undefined
    if (primaryClass === undefined) {
      errors.push(`${where}: class must be one of ${CLASSES.join(' | ')}`)
    }
    let declaredClasses = primaryClass === undefined ? [] : [primaryClass]
    if (entry.alsoClasses !== undefined) {
      if (!Array.isArray(entry.alsoClasses)) {
        errors.push(`${where}: alsoClasses must be an array of class labels`)
      } else {
        const seen = new Set()
        for (const label of entry.alsoClasses) {
          if (!CLASSES.includes(label)) {
            errors.push(`${where}: alsoClasses entry must be one of ${CLASSES.join(' | ')}`)
            continue
          }
          if (label === primaryClass) {
            errors.push(`${where}: alsoClasses must not repeat the primary class`)
            continue
          }
          if (seen.has(label)) errors.push(`${where}: alsoClasses has a duplicate entry`)
          else seen.add(label)
        }
        declaredClasses = [...declaredClasses, ...seen]
      }
    }

    if (!SUBSETS.includes(entry.subset)) {
      errors.push(`${where}: subset must be one of ${SUBSETS.join(' | ')}`)
    } else {
      counts[entry.subset] += 1
    }
    for (const label of declaredClasses) counts[label] += 1

    if (!isNonEmptyString(entry.query)) errors.push(`${where}: query must be a non-empty string`)
    if (!Array.isArray(entry.candidates) || entry.candidates.length === 0) {
      errors.push(`${where}: candidates must be a non-empty array`)
      return
    }
    if (!Array.isArray(entry.expectedNames)) errors.push(`${where}: expectedNames must be an array`)
    else if (entry.expectedNames.some(name => !isNonEmptyString(name))) {
      errors.push(`${where}: every expectedNames entry must be a non-empty string`)
    }

    const byName = new Map()
    for (const [candidateIndex, candidate] of entry.candidates.entries()) {
      const at = `${where}: candidates[${candidateIndex}]`
      if (!isObject(candidate)) {
        errors.push(`${at} must be an object`)
        continue
      }
      if (!isNonEmptyString(candidate.name)) errors.push(`${at}.name must be a non-empty string`)
      else if (byName.has(candidate.name)) errors.push(`${at}.name duplicates a sibling candidate name`)
      else byName.set(candidate.name, candidate)
      if (!isNonEmptyString(candidate.description)) errors.push(`${at}.description must be a non-empty string`)
      if (candidate.searchHint !== undefined && typeof candidate.searchHint !== 'string') {
        errors.push(`${at}.searchHint must be a string`)
      }
      if (typeof candidate.lexicalScore !== 'number' || !Number.isFinite(candidate.lexicalScore)
        || candidate.lexicalScore < 0) {
        errors.push(`${at}.lexicalScore must be a finite number >= 0`)
      }
      if (candidate.admitted !== undefined && typeof candidate.admitted !== 'boolean') {
        errors.push(`${at}.admitted must be a boolean`)
      }
    }

    // An exact-name query short-circuits the runtime judge (step 2 of the
    // execution order), so such a case cannot measure judge quality at all.
    const trimmed = isNonEmptyString(entry.query) ? entry.query.trim() : undefined
    if (trimmed !== undefined) {
      for (const [candidateIndex, candidate] of entry.candidates.entries()) {
        if (isObject(candidate) && candidate.name === trimmed) {
          errors.push(`${where}: query must not equal candidates[${candidateIndex}].name — an exact-name query short-circuits the judge`)
          break
        }
      }
    }

    if (!Array.isArray(entry.expectedNames)) return
    for (const name of entry.expectedNames) {
      if (!isNonEmptyString(name)) continue
      const candidate = byName.get(name)
      if (candidate === undefined) errors.push(`${where}: expectedNames entry is not a candidate name`)
      else if (candidate.admitted === false) {
        errors.push(`${where}: expectedNames names a denied candidate, which can never activate`)
      }
    }

    if (entry.subset === 'chinese' || entry.subset === 'synonym') {
      if (entry.expectedNames.length === 0) errors.push(`${where}: subset ${entry.subset} needs a target`)
      const zeroScored = entry.expectedNames.some(name => {
        const candidate = byName.get(name)
        return isObject(candidate) && candidate.lexicalScore === 0
      })
      if (entry.expectedNames.length > 0 && !zeroScored) {
        errors.push(`${where}: subset ${entry.subset} needs an expected candidate at lexicalScore 0`)
      }
    }
    if (entry.subset === 'restricted') {
      const denied = [...byName.values()].some(candidate => candidate.admitted === false)
      if (!denied) errors.push(`${where}: subset restricted needs an admitted: false candidate`)
    }
    if (entry.subset === 'none' && entry.expectedNames.length > 0) {
      errors.push(`${where}: subset none must have an empty expectedNames`)
    }
    // The class rule: no relevant tool exists, which the subset rule above
    // already forces to "no expected names" — checked here so a class label can
    // never be pinned onto a case with positives.
    if (primaryClass === 'negative-only' && entry.subset !== 'none') {
      errors.push(`${where}: class negative-only requires subset none`)
    }
  })

  // Floor deficits are schema violations, but they describe corpus COVERAGE
  // rather than a malformed document: `selfcheck` treats them as fatal, while a
  // scoring arm may still run over a corpus that is mid-growth and report them.
  for (const subset of SUBSETS) {
    if (counts[subset] < REQUIRED_SUBSET_COUNTS[subset]) {
      floors.push(`subset ${subset}: ${counts[subset]} case(s), expected at least ${REQUIRED_SUBSET_COUNTS[subset]}`)
    }
  }
  for (const label of CLASSES) {
    if (counts[label] < REQUIRED_CLASS_COUNTS[label]) {
      floors.push(`class ${label}: ${counts[label]} case(s) counting alsoClasses, expected at least ${REQUIRED_CLASS_COUNTS[label]}`)
    }
  }
  errors.push(...floors)

  return { errors, floors, cases: parsed.cases.filter(isObject), counts }
}
