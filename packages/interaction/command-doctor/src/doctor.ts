/**
 * Public `/doctor` report surface: the structured types and the text
 * formatter, so `@dsh-cc/command-doctor/doctor` keeps resolving.
 * @module @dsh-cc/command-doctor/doctor
 */

export { formatDoctorReport, type RenderOptions } from './render.ts'
export type {
  Check,
  CheckGroup,
  CheckStatus,
  DoctorReport,
} from './report.ts'
