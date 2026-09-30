/**
 * Mount the harness ScheduleService into CC profiles. Harness 0.1.7-rc.2
 * turned schedule into a host service (TypertRemoteService) whose inject list
 * includes `sessionController` — a service that exists only behind the
 * api-proxy in app profiles, never in a tui profile. Mounting the raw package
 * row inside the per-agent preset used to work when schedule was a plain
 * function plugin; with the class plugin it parks the agent mount forever
 * (cordis waits on missing injects without throwing).
 *
 * This row mounts it at the HOST plane instead (where upstream bundles it)
 * and pre-provides the same throwing sessionController stub the harness
 * schedule tests use when the service is absent: delivery resolution then
 * reports per-session failures instead of parking the boot.
 *
 * @module @dsh-cc/bundle-shell/schedule-mount
 */

import type { Context } from '@deepseek-ai/cordis'
import ScheduleService from '@deepseek-ai/dsh-schedule'

export default async function CcScheduleMount(ctx: Context): Promise<void> {
  if (ctx.get('sessionController') === undefined) {
    // Mirrors upstream packages/schedule/schedule/tests/harness.ts: the
    // resolver reports 'missing Session' per call; scheduling itself (catalog
    // writes, tool registration, changed events) never consults it.
    ctx.provide('sessionController', {
      resolveAgent: async () => {
        throw new Error('missing Session')
      },
    } as never)
  }
  await ctx.plugin(ScheduleService, {})
}
