import { describe, expect, it } from 'vitest'

import type { AutomationBlueprint } from '@/hermes'

import { blueprintSlotHelp, cleanBlueprintFieldError, initialBlueprintValues } from './blueprints'

function blueprint(fields: AutomationBlueprint['fields']): AutomationBlueprint {
  return {
    key: 'test',
    title: 'Test',
    description: '',
    category: 'general',
    tags: [],
    command: '',
    appUrl: '',
    fields
  }
}

function field(overrides: Partial<AutomationBlueprint['fields'][number]>): AutomationBlueprint['fields'][number] {
  return {
    name: 'topic',
    type: 'text',
    label: 'Topic',
    default: null,
    options: [],
    optional: false,
    help: '',
    ...overrides
  }
}

describe('initialBlueprintValues', () => {
  it('seeds each field from its default', () => {
    const values = initialBlueprintValues(
      blueprint([
        { name: 'time', type: 'time', label: 'Time', default: '08:00', options: [], optional: false, help: '' },
        {
          name: 'topic',
          type: 'enum',
          label: 'Topic',
          default: 'news',
          options: ['news', 'sports'],
          optional: false,
          help: ''
        }
      ])
    )

    expect(values).toEqual({ time: '08:00', topic: 'news' })
  })

  it('falls back to an empty string when a field has no default', () => {
    const values = initialBlueprintValues(
      blueprint([{ name: 'topic', type: 'text', label: 'Topic', default: null, options: [], optional: true, help: '' }])
    )

    expect(values).toEqual({ topic: '' })
  })

  it('returns an empty object for a blueprint with no fields', () => {
    expect(initialBlueprintValues(blueprint([]))).toEqual({})
  })

  it("seeds the deliver slot to 'local' when its default is the dashboard-only 'origin'", () => {
    const values = initialBlueprintValues(
      blueprint([
        {
          name: 'deliver',
          type: 'enum',
          label: 'Deliver',
          default: 'origin',
          options: ['origin', 'local', 'telegram'],
          optional: false,
          help: ''
        }
      ])
    )

    expect(values).toEqual({ deliver: 'local' })
  })

  it("seeds the deliver slot to 'local' when it has no default", () => {
    const values = initialBlueprintValues(
      blueprint([
        {
          name: 'deliver',
          type: 'enum',
          label: 'Deliver',
          default: null,
          options: ['origin', 'local'],
          optional: false,
          help: ''
        }
      ])
    )

    expect(values).toEqual({ deliver: 'local' })
  })

  it('leaves a non-origin deliver default untouched', () => {
    const values = initialBlueprintValues(
      blueprint([
        {
          name: 'deliver',
          type: 'enum',
          label: 'Deliver',
          default: 'telegram',
          options: ['origin', 'local', 'telegram'],
          optional: false,
          help: ''
        }
      ])
    )

    expect(values).toEqual({ deliver: 'telegram' })
  })
})

// The backend's 422 for a bad slot arrives through api() as
// "POST /api/… → HTTP 422: <detail>"; the numeric prefix an Error picks up on
// the way is noise in a field-level hint.
describe('cleanBlueprintFieldError', () => {
  it('strips a leading status code', () => {
    expect(cleanBlueprintFieldError('422: time must be HH:MM')).toBe('time must be HH:MM')
  })

  it('leaves a message with no code alone', () => {
    expect(cleanBlueprintFieldError('time must be HH:MM')).toBe('time must be HH:MM')
  })

  it('only strips the prefix, not digits inside the message', () => {
    expect(cleanBlueprintFieldError('422: 24-hour clock only')).toBe('24-hour clock only')
  })
})

describe('blueprintSlotHelp', () => {
  it('shows help for a non-text slot', () => {
    expect(blueprintSlotHelp(field({ type: 'time', help: 'When to run' }))).toBe('When to run')
  })

  it('hides help for a text slot — its placeholder already carries it', () => {
    expect(blueprintSlotHelp(field({ type: 'text', help: 'What to watch' }))).toBeUndefined()
  })

  it('hides the dashboard-centric deliver help', () => {
    expect(blueprintSlotHelp(field({ name: 'deliver', type: 'enum', help: 'local = save only' }))).toBeUndefined()
  })

  it('returns undefined when a slot carries no help', () => {
    expect(blueprintSlotHelp(field({ type: 'enum', help: '' }))).toBeUndefined()
  })
})
