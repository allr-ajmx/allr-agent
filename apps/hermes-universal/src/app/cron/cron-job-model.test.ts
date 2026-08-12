import { describe, expect, it } from 'vitest'

import type { CronDeliveryTarget } from '@/types/hermes'

import {
  cronDeliverSummary,
  cronDeliveryOptions,
  cronDeliveryTargetLabel,
  cronEditorUpdates,
  jobIsScriptOnly,
  normalizeCronDeliverValue,
  parseCronDeliveryTargets,
  toggleCronDeliveryTarget,
  validateCronEditor
} from './cron-job-model'

const target = (id: string, homeTargetSet = true): CronDeliveryTarget => ({
  home_env_var: null,
  home_target_set: homeTargetSet,
  id,
  name: id.replace(/^./, first => first.toUpperCase())
})

describe('jobIsScriptOnly', () => {
  it('is true when no_agent is set and a script is present', () => {
    expect(jobIsScriptOnly({ no_agent: true, script: 'echo hi' })).toBe(true)
  })

  it('is false for agent-backed jobs', () => {
    expect(jobIsScriptOnly({ no_agent: false, script: 'echo hi' })).toBe(false)
    expect(jobIsScriptOnly({ no_agent: true, script: '' })).toBe(false)
    expect(jobIsScriptOnly({ no_agent: true, script: null })).toBe(false)
  })
})

describe('validateCronEditor', () => {
  it('requires prompt and schedule for agent-backed jobs', () => {
    expect(validateCronEditor({ prompt: '', schedule: '', scriptOnlyJob: false })).toBe('prompt_and_schedule')
    expect(validateCronEditor({ prompt: '', schedule: '0 9 * * *', scriptOnlyJob: false })).toBe('prompt')
    expect(validateCronEditor({ prompt: 'go', schedule: '', scriptOnlyJob: false })).toBe('schedule')
  })

  it('allows an empty prompt when editing a script-only job', () => {
    expect(validateCronEditor({ prompt: '', schedule: '0 9 * * 1', scriptOnlyJob: true })).toBe(null)
    expect(validateCronEditor({ prompt: 'optional note', schedule: '0 9 * * 1', scriptOnlyJob: true })).toBe(null)
  })

  it('still requires schedule for script-only jobs', () => {
    expect(validateCronEditor({ prompt: '', schedule: '', scriptOnlyJob: true })).toBe('schedule')
  })
})

describe('cronEditorUpdates', () => {
  it('omits prompt when saving a script-only job with an empty prompt', () => {
    expect(
      cronEditorUpdates(
        { deliver: 'local', model: '', name: 'Weekly', prompt: '', provider: '', schedule: '0 9 * * 1' },
        { scriptOnlyJob: true }
      )
    ).toEqual({
      deliver: 'local',
      name: 'Weekly',
      schedule: '0 9 * * 1'
    })
  })

  it('includes prompt when the user typed one on a script-only job', () => {
    expect(
      cronEditorUpdates(
        { deliver: 'email', model: '', name: 'Weekly', prompt: 'note', provider: '', schedule: '0 9 * * 1' },
        { scriptOnlyJob: true }
      ).prompt
    ).toBe('note')
  })

  it('writes the model override for agent jobs', () => {
    const updates = cronEditorUpdates(
      {
        deliver: 'local',
        model: 'claude-sonnet-4',
        name: 'Daily',
        prompt: 'go',
        provider: 'anthropic',
        schedule: '0 9 * * *'
      },
      { scriptOnlyJob: false }
    )

    expect(updates.model).toBe('claude-sonnet-4')
    expect(updates.provider).toBe('anthropic')
  })

  it('clears a previous pin when the override is reset to default', () => {
    const updates = cronEditorUpdates(
      { deliver: 'local', model: '', name: 'Daily', prompt: 'go', provider: '', schedule: '0 9 * * *' },
      { scriptOnlyJob: false }
    )

    expect(updates.model).toBe(null)
    expect(updates.provider).toBe(null)
  })

  it('never touches model fields on script-only jobs', () => {
    const updates = cronEditorUpdates(
      { deliver: 'local', model: 'x', name: 'Weekly', prompt: '', provider: 'y', schedule: '0 9 * * 1' },
      { scriptOnlyJob: true }
    )

    expect('model' in updates).toBe(false)
    expect('provider' in updates).toBe(false)
  })
})

describe('parseCronDeliveryTargets', () => {
  it('splits the scheduler’s comma-separated string', () => {
    expect(parseCronDeliveryTargets('local,telegram')).toEqual(['local', 'telegram'])
    expect(parseCronDeliveryTargets(' local , telegram ')).toEqual(['local', 'telegram'])
  })

  it('dedupes rather than ticking a box twice', () => {
    expect(parseCronDeliveryTargets('local,local,slack')).toEqual(['local', 'slack'])
  })

  it('falls back to local when nothing is stored', () => {
    expect(parseCronDeliveryTargets('')).toEqual(['local'])
    expect(parseCronDeliveryTargets(' , ')).toEqual(['local'])
  })
})

describe('toggleCronDeliveryTarget', () => {
  it('adds a target without disturbing the others', () => {
    expect(toggleCronDeliveryTarget('local', 'telegram', true)).toBe('local,telegram')
  })

  it('is idempotent on an already-selected target', () => {
    expect(toggleCronDeliveryTarget('local,telegram', 'telegram', true)).toBe('local,telegram')
  })

  it('removes a target', () => {
    expect(toggleCronDeliveryTarget('local,telegram', 'local', false)).toBe('telegram')
  })

  it('refuses to leave a job with nowhere to deliver', () => {
    expect(toggleCronDeliveryTarget('local', 'local', false)).toBe('local')
  })

  it('ignores an unchecked target that was never selected', () => {
    expect(toggleCronDeliveryTarget('local,slack', 'discord', false)).toBe('local,slack')
  })
})

describe('normalizeCronDeliverValue', () => {
  it('passes a wire-shaped string through untouched', () => {
    expect(normalizeCronDeliverValue('local,telegram')).toBe('local,telegram')
  })

  // The scheduler's own _normalize_deliver_value flattens this shape rather
  // than failing on it, so a job stored as a list is a live job with real
  // routes. Reading it as "nothing" showed the editor local-only and SAVED
  // that back, deleting routes the user never touched.
  it('flattens the legacy list shape instead of discarding it', () => {
    expect(normalizeCronDeliverValue(['telegram', 'discord'])).toBe('telegram,discord')
    expect(normalizeCronDeliverValue([' telegram ', '', 'discord'])).toBe('telegram,discord')
  })

  it('is empty for a value that carries no targets at all', () => {
    expect(normalizeCronDeliverValue(null)).toBe('')
    expect(normalizeCronDeliverValue(undefined)).toBe('')
    expect(normalizeCronDeliverValue(7)).toBe('')
  })

  it('feeds parseCronDeliveryTargets, so a list job ticks its real boxes', () => {
    expect(parseCronDeliveryTargets(['telegram', 'discord'])).toEqual(['telegram', 'discord'])
  })
})

describe('cronDeliveryOptions', () => {
  it('offers exactly what discovery reports when the job holds nothing else', () => {
    expect(cronDeliveryOptions([target('local'), target('telegram')], 'local').map(row => row.id)).toEqual([
      'local',
      'telegram'
    ])
  })

  it('carries a stored target discovery no longer reports', () => {
    const rows = cronDeliveryOptions([target('local')], 'local,discord')

    expect(rows.map(row => row.id)).toEqual(['local', 'discord'])
  })

  it('never lists a target twice', () => {
    expect(cronDeliveryOptions([target('local'), target('telegram')], 'local,telegram').map(row => row.id)).toEqual([
      'local',
      'telegram'
    ])
  })
})

describe('cronDeliveryTargetLabel', () => {
  const labels = { local: 'This desktop', telegram: 'Telegram' }

  it('prefers the translated label over the backend name', () => {
    expect(cronDeliveryTargetLabel(target('telegram'), labels, 'set a home channel first')).toBe('Telegram')
  })

  it("falls back to the backend's own name for a platform with no translation", () => {
    expect(cronDeliveryTargetLabel(target('mattermost'), labels, 'set a home channel first')).toBe('Mattermost')
  })

  it('flags a platform that would deliver nowhere', () => {
    expect(cronDeliveryTargetLabel(target('telegram', false), labels, 'set a home channel first')).toBe(
      'Telegram — set a home channel first'
    )
  })

  it('never flags local, which needs no home channel', () => {
    expect(cronDeliveryTargetLabel(target('local', false), labels, 'set a home channel first')).toBe('This desktop')
  })
})

describe('cronDeliverSummary', () => {
  const labels = { local: 'This desktop', telegram: 'Telegram' }

  // The whole point of the ticket read back: a fanned-out job must not read as
  // if it delivers to one place.
  it('names every target, not just the first', () => {
    expect(cronDeliverSummary('local,telegram', labels)).toBe('This desktop, Telegram')
  })

  it('shows an untranslated target under its raw id rather than dropping it', () => {
    expect(cronDeliverSummary('local,mattermost', labels)).toBe('This desktop, mattermost')
  })

  it('summarizes the legacy list shape too', () => {
    expect(cronDeliverSummary(['local', 'telegram'], labels)).toBe('This desktop, Telegram')
  })
})
