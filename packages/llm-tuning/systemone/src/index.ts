export * from './client.ts'
export * from './model-windows.ts'
export * from './budget.ts'
export * from './validation.ts'
export * from './decision.ts'
export * from './decision-hash.ts'

/**
 * The single model-alias lane every SystemOne decision consumer routes
 * through (design doc route unification C6): memory recall, extraction,
 * tool-discovery, skill-recommendation, the eval harness and any future
 * consumer pass this alias, so one gauge-alias route row configures them all.
 * Changing this constant is a deployment-wide contract change — the settings
 * `routes` rows are keyed by it and existing rows would silently go unused.
 */
export const DECISION_LANE_ALIAS = 'gauge'
