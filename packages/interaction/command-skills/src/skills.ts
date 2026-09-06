/**
 * Pure `/skills` rendering: sort skill summaries and render each with its
 * description, source, and invocation policy. No cordis imports.
 * @module @dsh-cc/command-skills/skills
 */

import { isModelInvocable, isUserInvocable, type SkillSummary } from '@deepseek-ai/dsh-skill'

/** Describe who may invoke a skill: model, user, or both. */
export function invocationLabel(skill: SkillSummary): string {
  const model = isModelInvocable(skill)
  const user = isUserInvocable(skill)
  if (model && user) return 'model and user'
  if (model) return 'model'
  if (user) return 'user'
  return 'no one'
}

/**
 * Render one skill as a line.
 * @param skill - one skill summary.
 * @returns a single-line description of the skill.
 */
export function formatSkill(skill: SkillSummary): string {
  return `${skill.name} — ${skill.description} (source: ${skill.source}, invocable by: ${invocationLabel(skill)})`
}

/**
 * Render a sorted skill catalog.
 * @param skills - the effective skill summaries.
 * @returns a sorted multi-line list, or a placeholder when no skills exist.
 */
export function formatSkills(skills: readonly SkillSummary[]): string {
  const sorted = [...skills].sort((a, b) => a.name.localeCompare(b.name))
  if (sorted.length === 0) return 'No skills registered.'
  return sorted.map(formatSkill).join('\n')
}
