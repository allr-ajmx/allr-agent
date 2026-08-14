import { describe, expect, it } from 'vitest'

import type { ToolsetModelsResponse } from '@/types/hermes'

import { customSelectedModel } from './toolset-config-panel'

function catalog(over: Partial<ToolsetModelsResponse> = {}): ToolsetModelsResponse {
  return {
    name: 'image_gen',
    has_models: true,
    models: [{ id: 'google/gemini-3-pro-image', display: 'Gemini 3 Pro Image', speed: '', strengths: '', price: '' }],
    current: 'google/gemini-3-pro-image',
    default: 'google/gemini-3-pro-image',
    accepts_custom_model: true,
    ...over
  }
}

describe('customSelectedModel', () => {
  it('returns null when the in-use model came from the catalog', () => {
    expect(customSelectedModel(catalog())).toBeNull()
  })

  it('surfaces a hand-entered id so it does not read as unselected', () => {
    // Absent from the catalog by definition — without its own row every entry
    // renders unselected and the panel looks unconfigured.
    expect(customSelectedModel(catalog({ current: 'vendor/hand-typed' }))).toBe('vendor/hand-typed')
  })

  it('ignores an off-catalog id for backends with a closed id set', () => {
    // Stale config the gateway already resolves back to the default — showing
    // it would claim a model that will never be used.
    expect(customSelectedModel(catalog({ accepts_custom_model: false, current: 'vendor/stale' }))).toBeNull()
  })

  it('treats an older gateway (field absent) as closed', () => {
    const older = catalog({ current: 'vendor/stale' })
    delete older.accepts_custom_model

    expect(customSelectedModel(older)).toBeNull()
  })

  it('falls back to the default when nothing is selected', () => {
    expect(customSelectedModel(catalog({ current: null, default: 'vendor/custom-default' }))).toBe(
      'vendor/custom-default'
    )
  })

  it('returns null when there is no selection at all', () => {
    expect(customSelectedModel(catalog({ current: null, default: null }))).toBeNull()
  })
})
