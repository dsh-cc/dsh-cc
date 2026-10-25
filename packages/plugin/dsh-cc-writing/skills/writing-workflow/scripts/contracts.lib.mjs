/**
 * Barrel for the dsh-cc-writing artifact validators (plan §5).
 *
 * Style: every validator returns {ok:true, value} with a normalized copy, or
 * {ok:false, code:"INVALID_INPUT", message, details} without throwing, so the
 * CLI can map failures to exit code 2. Unknown properties are rejected at
 * every level. Cross-artifact checks (brief vs plan vs run) are the caller's
 * responsibility; the validators only see one artifact at a time.
 *
 * Flat *.lib.mjs filenames: the root .gitignore swallows every lib/ directory.
 */
export * from './schema.lib.mjs'
export * from './brief-run.lib.mjs'
export * from './plan-research.lib.mjs'
export * from './review-proposal.lib.mjs'
export * from './check-profile.lib.mjs'
