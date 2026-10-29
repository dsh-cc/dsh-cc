/**
 * Public re-export surface of the task-grant slice (design §3 of the VWA batch
 * autonomous-review plan). Kept in one module so the package entry stays
 * inside its file-size budget.
 *
 * @module @dsh-cc/permission-rules/task-grant-public
 */

export * from './task-grant.ts'
export * from './task-grant-service.ts'
export * from './grant-escalation.ts'
export * from './task-grant-match.ts'
export * from './grant-content-scope.ts'
export * from './vwa-state.ts'
export * from './task-grant-command.ts'
