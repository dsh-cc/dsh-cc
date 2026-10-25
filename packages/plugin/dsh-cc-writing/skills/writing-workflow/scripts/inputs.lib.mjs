/** Small input-parsing helpers shared by the command modules (plan §6). */

import { InvalidInput, readHash, readObject } from './contracts.lib.mjs'
import { fail } from './files.lib.mjs'

/** Map schema-validator throws to INVALID_INPUT without printing source text. */
export function schemaCall(fn) {
  try {
    return fn()
  } catch (error) {
    if (error instanceof InvalidInput) fail('INVALID_INPUT', error.message)
    throw error
  }
}

/** Strict top-level input object: unknown properties are rejected. */
export function readInput(input, required, optional = []) {
  return schemaCall(() => readObject(input, 'input', required, optional))
}

export function hashInput(value, label) {
  return schemaCall(() => readHash(value, label, { nullable: true }))
}
