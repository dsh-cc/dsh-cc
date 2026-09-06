/**
 * Trajectory schema and the built-in standard trajectory. A trajectory is the
 * deterministic driver script for one cache benchmark run: persona (long
 * enough to clear the provider's 64-token cache-block granularity from the
 * first request), deterministic content tools, and an ordered turn list whose
 * first turn forces a tool call so the very first turn produces a follow-up
 * request over an extended prefix.
 * @module @dsh-cc/cache-trajectory/trajectory
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import z from 'zod'

/** One deterministic content tool the trajectory registers on the context. */
export const trajectoryToolSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  /** JSON-schema-ish parameter spec handed to the tool fixture verbatim. */
  parameters: z.record(z.string(), z.unknown()).default({}),
  /**
   * Deterministic result template; `{key}` placeholders are replaced with the
   * call's string arguments at execute time.
   */
  resultText: z.string().min(1),
})

/** One user turn. `expectToolCall` turns "turn 1 called a tool" into an invariant. */
export const trajectoryTurnSchema = z.object({
  text: z.string().min(1),
  expectToolCall: z.boolean().default(false),
})

/** zod schema of a trajectory JSON document. */
export const trajectorySchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  description: z.string().optional(),
  /** Deployment persona; must comfortably exceed the 64-token cache block. */
  persona: z.string().min(1),
  provider: z.string().default('deepseek-official'),
  model: z.string().default('deepseek-v4-flash'),
  sessionId: z.string().default('cache-trajectory'),
  /** Shape floor for the total request count — never a ceiling. */
  minRequests: z.number().int().positive(),
  thresholds: z.object({
    perRequestMinRate: z.number().min(0).max(1),
    sessionMinRate: z.number().min(0).max(1),
  }),
  tools: z.array(trajectoryToolSchema).min(1),
  turns: z.array(trajectoryTurnSchema).min(2),
})

/** A parsed trajectory (see {@link trajectorySchema}). */
export type CacheTrajectory = z.infer<typeof trajectorySchema>

/** Parse and validate an unknown JSON document as a trajectory. */
export function parseTrajectory(input: unknown): CacheTrajectory {
  return trajectorySchema.parse(input)
}

/** Absolute path of the built-in standard trajectory JSON. */
export function standardTrajectoryPath(): string {
  return fileURLToPath(new URL('../trajectories/standard.json', import.meta.url))
}

/** Load and validate the built-in `trajectories/standard.json`. */
export function loadStandardTrajectory(): CacheTrajectory {
  return parseTrajectory(JSON.parse(readFileSync(standardTrajectoryPath(), 'utf8')))
}
