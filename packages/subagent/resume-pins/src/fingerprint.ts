/**
 * Definition fingerprints (§4.4): a named agent definition is fingerprinted by
 * hashing the canonical JSON of all recognized parsed frontmatter fields plus
 * the persona body. The rule is parse-level canonicalization — comment and
 * formatting-only markdown edits produce no fingerprint change, while a change
 * to ANY declared field (consumed like `model`/`tools`/persona, or currently
 * inert like `maxTurns`/`effort`) produces one. Discovery metadata
 * (`source`, `baseDir`, `filename`) is deliberately excluded: the same file
 * discovered from a different layer must keep its identity.
 *
 * §3.7: `effectivePersona` overrides the raw `systemPrompt` in the hashed
 * content. Callers on a ctx-bearing path pass the GATED persona
 * (`applyActorContract(systemPrompt, gateCandidates(...), patterns)`) so a
 * gate toggle changes the fingerprint — a resume-drift signal — while an
 * UNMARKED definition's gated persona is byte-identical to the raw one, so
 * existing pins keep matching (zero retro-invalidation). Omitted → raw
 * persona (the pre-§3.7 behavior).
 * @module @dsh-cc/subagent-resume-pins/fingerprint
 */

import { createHash } from 'node:crypto'
import { canonicalJson } from './pin.ts'
import type { AgentDefinition } from '@dsh-cc/claude-code-agents'

/** sha256 hex of `input`, prefixed `sha256:`. */
export function sha256Prefixed(input: string): string {
  return `sha256:${createHash('sha256').update(input, 'utf8').digest('hex')}`
}

/** Stable hash of a persona (system-prompt) string. */
export function personaHash(persona: string): string {
  return sha256Prefixed(persona)
}

/**
 * Fingerprint one parsed {@link AgentDefinition} over its content fields:
 * every recognized parsed frontmatter field plus the persona body, in
 * stable key order. Optional fields absent from the definition are simply
 * omitted from the canonical form.
 */
export function definitionFingerprint(def: AgentDefinition, effectivePersona?: string): string {
  const content = {
    agentType: def.agentType,
    whenToUse: def.whenToUse,
    systemPrompt: effectivePersona ?? def.systemPrompt,
    toolRestriction: def.toolRestriction ?? null,
    skills: def.skills ?? null,
    mcpServers: def.mcpServers ?? null,
    hooks: def.hooks ?? null,
    model: def.model ?? null,
    effort: def.effort ?? null,
    permissionMode: def.permissionMode ?? null,
    maxTurns: def.maxTurns ?? null,
    initialPrompt: def.initialPrompt ?? null,
    background: def.background ?? null,
    memory: def.memory ?? null,
    isolation: def.isolation ?? null,
  }
  return sha256Prefixed(canonicalJson(content))
}
