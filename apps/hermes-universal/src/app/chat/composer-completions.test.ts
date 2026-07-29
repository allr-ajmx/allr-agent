import { describe, expect, it, vi } from 'vitest'

vi.mock('@/store/gateway', async () => {
  const { atom } = await import('@/store/atom')

  return {
    addGatewayEventListener: () => () => {},
    requestGateway: vi.fn(),
    $gatewayState: atom('idle')
  }
})
import { requestGateway } from '@/store/gateway'

import { applyCompletion, detectTrigger, fetchCompletions } from './composer-completions'

describe('composer completions', () => {
  it('detects a slash trigger only at the start of the input', () => {
    expect(detectTrigger('/mod', 4)).toMatchObject({ kind: 'slash', token: '/mod' })
    expect(detectTrigger('hello /x', 8)).toBeNull()
  })

  it('detects an @-mention token touching the cursor', () => {
    expect(detectTrigger('see @src/ap', 11)).toMatchObject({ kind: 'path', token: '@src/ap' })
    expect(detectTrigger('plain text', 10)).toBeNull()
  })

  it('applyCompletion splices the entry text over the token', () => {
    const r = applyCompletion('see @src/ap', 11, 4, { text: '@src/app.tsx' })
    expect(r.text).toBe('see @src/app.tsx')
    expect(r.cursor).toBe('see @src/app.tsx'.length)
  })

  it('fetchCompletions calls complete.slash and normalizes replace_from', async () => {
    vi.mocked(requestGateway).mockResolvedValue({ items: [{ text: '/clear' }], replace_from: 1 })
    const res = await fetchCompletions({ kind: 'slash', token: '/cl', cursor: 3 })
    expect(requestGateway).toHaveBeenCalledWith('complete.slash', { text: '/cl' })
    expect(res.items).toEqual([{ text: '/clear' }])
    expect(res.replaceFrom).toBe(0)
  })

  it('fetchCompletions calls complete.path for @ tokens', async () => {
    vi.mocked(requestGateway).mockResolvedValue({ items: [{ text: '@src/app.tsx' }] })
    const res = await fetchCompletions({ kind: 'path', token: '@src', cursor: 8 })
    expect(requestGateway).toHaveBeenCalledWith('complete.path', expect.objectContaining({ word: '@src' }))
    expect(res.replaceFrom).toBe(4) // 8 - '@src'.length
  })
})
