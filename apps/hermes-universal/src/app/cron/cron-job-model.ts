import type { CronDeliveryTarget, CronJob, CronJobUpdates } from '@/types/hermes'

const asText = (value: unknown): string => (typeof value === 'string' ? value : '')

/** Script-only cron jobs run a shell script on schedule with no LLM prompt. */
export function jobIsScriptOnly(job: Pick<CronJob, 'no_agent' | 'script'>): boolean {
  return Boolean(job.no_agent) && Boolean(asText(job.script).trim())
}

export type CronEditorValidationError = 'prompt' | 'prompt_and_schedule' | 'schedule'

export interface CronEditorValidationInput {
  prompt: string
  schedule: string
  scriptOnlyJob: boolean
}

export function validateCronEditor(input: CronEditorValidationInput): CronEditorValidationError | null {
  const trimmedPrompt = input.prompt.trim()
  const trimmedSchedule = input.schedule.trim()

  if (!trimmedSchedule && !trimmedPrompt && !input.scriptOnlyJob) {
    return 'prompt_and_schedule'
  }

  if (!trimmedSchedule) {
    return 'schedule'
  }

  if (!input.scriptOnlyJob && !trimmedPrompt) {
    return 'prompt'
  }

  return null
}

export interface CronEditorSaveValues {
  deliver: string
  /** Per-job model override ('' = follow the global default at fire time). */
  model: string
  name: string
  prompt: string
  /** Provider for the model override ('' = none). Always paired with model. */
  provider: string
  schedule: string
}

/**
 * `deliver` is ONE string on the wire, not a list: the scheduler splits it on
 * commas (`cron/scheduler.py` `_normalize_deliver_value`), so "local,telegram"
 * fans a run out to both.
 *
 * A STORED value can still be a list, though — the scheduler's own normalizer
 * documents MCP clients, hand-edited `jobs.json` and older code paths writing
 * `["telegram"]`, and it flattens them rather than failing. Reading such a job
 * as "not a string" showed it as local-only in the editor AND wrote that back
 * on the next save, silently deleting a route the user never touched. Flatten
 * the same way the backend does so a read is lossless.
 */
export function normalizeCronDeliverValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value
      .map(part => asText(part).trim())
      .filter(Boolean)
      .join(',')
  }

  return asText(value)
}

/** Split a stored `deliver` value into its targets; '' (or nothing) = local. */
export function parseCronDeliveryTargets(value: unknown): string[] {
  const targets = normalizeCronDeliverValue(value)
    .split(',')
    .map(target => target.trim())
    .filter(Boolean)

  return targets.length > 0 ? [...new Set(targets)] : ['local']
}

/** Toggle one target on/off. Unchecking the last one is a no-op — a job with
 *  nowhere to deliver is not a state the editor should be able to reach. */
export function toggleCronDeliveryTarget(value: string, target: string, checked: boolean): string {
  const targets = parseCronDeliveryTargets(value)

  if (checked) {
    return targets.includes(target) ? targets.join(',') : [...targets, target].join(',')
  }

  if (!targets.includes(target) || targets.length === 1) {
    return targets.join(',')
  }

  return targets.filter(candidate => candidate !== target).join(',')
}

/**
 * The rows the delivery checkbox group renders: everything discovery reports,
 * plus any target the job already stores that discovery does NOT report — a
 * platform disconnected since the job was written, or a routing form this app
 * never offers (`origin`, `all`, `telegram:-100:17`). Dropping those would let
 * a plain "open and save" delete a route the user never touched, so they are
 * carried through as their own row instead.
 */
export function cronDeliveryOptions(targets: CronDeliveryTarget[], value: unknown): CronDeliveryTarget[] {
  const known = new Set(targets.map(target => target.id))

  return [
    ...targets,
    ...parseCronDeliveryTargets(value)
      .filter(id => !known.has(id))
      .map(id => ({ home_env_var: null, home_target_set: true, id, name: id }))
  ]
}

/**
 * One row's label. A configured platform with no cron home channel is told so
 * inline rather than hidden: the backend still offers it, and ticking it there
 * delivers nowhere. `local` is exempt — it needs no channel.
 */
export function cronDeliveryTargetLabel(
  target: CronDeliveryTarget,
  labels: Record<string, string>,
  needsHomeChannel: string
): string {
  const base = labels[target.id] ?? target.name

  return target.id !== 'local' && !target.home_target_set ? `${base} — ${needsHomeChannel}` : base
}

/** The stored `deliver` value rendered for reading: EVERY target, labelled. */
export function cronDeliverSummary(value: unknown, labels: Record<string, string>): string {
  return parseCronDeliveryTargets(value)
    .map(target => labels[target] ?? target)
    .join(', ')
}

/** Build the API update payload, preserving an empty prompt on script-only jobs. */
export function cronEditorUpdates(values: CronEditorSaveValues, options: { scriptOnlyJob: boolean }): CronJobUpdates {
  const updates: CronJobUpdates = {
    deliver: values.deliver,
    name: values.name,
    schedule: values.schedule.trim()
  }

  const trimmedPrompt = values.prompt.trim()

  if (!options.scriptOnlyJob || trimmedPrompt) {
    updates.prompt = trimmedPrompt
  }

  // Script-only jobs never run an agent, so the scheduler ignores model
  // overrides — leave whatever is stored untouched. For agent jobs, always
  // write both axes so resetting to "default" clears a previous pin (the
  // backend normalizes null/'' to "no override").
  if (!options.scriptOnlyJob) {
    updates.model = values.model.trim() || null
    updates.provider = values.provider.trim() || null
  }

  return updates
}
