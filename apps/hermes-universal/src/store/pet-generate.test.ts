import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/store/gateway', () => ({
  addGatewayEventListener: () => () => {},
  requestGateway: vi.fn(),
  subscribeGateway: vi.fn(() => () => {})
}))
vi.mock('@/store/pet-gallery', () => ({ loadPetGallery: vi.fn() }))

import { requestGateway } from '@/store/gateway'

import {
  $petGenAvailable,
  $petGenDrafts,
  $petGenPreview,
  $petGenSelected,
  $petGenStatus,
  adoptHatched,
  checkPetGenAvailable,
  cleanPetName,
  generateDrafts,
  hatchSelected,
  resetPetGen
} from './pet-generate'

const rpc = vi.mocked(requestGateway)

beforeEach(() => {
  rpc.mockReset()
  resetPetGen()
  $petGenAvailable.set(null)
})
afterEach(() => resetPetGen())

describe('cleanPetName', () => {
  it('drops stopwords and title-cases', () => {
    expect(cleanPetName('a cute dragon in the style of ragnarok')).toBe('Dragon Ragnarok')
  })
  it('falls back to Pet on an empty prompt', () => {
    expect(cleanPetName('   ')).toBe('Pet')
  })
})

describe('checkPetGenAvailable', () => {
  it('reflects the backend availability', async () => {
    rpc.mockResolvedValue({ available: true } as never)
    await checkPetGenAvailable()
    expect($petGenAvailable.get()).toBe(true)
  })
  it('stays optimistic on a failed probe', async () => {
    rpc.mockRejectedValue(new Error('boom'))
    await checkPetGenAvailable()
    expect($petGenAvailable.get()).toBe(true)
  })
})

describe('generateDrafts', () => {
  it('populates drafts + selects the first on success', async () => {
    rpc.mockResolvedValue({
      ok: true,
      token: 'tok',
      drafts: [
        { index: 0, dataUri: 'a' },
        { index: 1, dataUri: 'b' }
      ]
    } as never)
    const ok = await generateDrafts('a friendly cat')
    expect(ok).toBe(true)
    expect($petGenStatus.get()).toBe('ready')
    expect($petGenDrafts.get()).toHaveLength(2)
    expect($petGenSelected.get()).toBe(0)
  })

  it('marks the backend stale on a missing-method error', async () => {
    rpc.mockRejectedValue(new Error('method not found: pet.generate'))
    await generateDrafts('a cat')
    expect($petGenStatus.get()).toBe('stale')
  })

  it('rejects an empty prompt without a call', async () => {
    const ok = await generateDrafts('   ')
    expect(ok).toBe(false)
    expect(rpc).not.toHaveBeenCalled()
  })
})

describe('hatchSelected', () => {
  it('loads the preview from a successful hatch', async () => {
    $petGenStatus.set('ready')
    $petGenSelected.set(0)
    // token is set by a successful generate; seed via the generate path.
    rpc.mockResolvedValueOnce({ ok: true, token: 'tok', drafts: [{ index: 0, dataUri: 'a' }] } as never)
    await generateDrafts('a cat')

    rpc.mockResolvedValueOnce({
      ok: true,
      slug: 'cat-1',
      displayName: 'Cat',
      pet: { enabled: true, slug: 'cat-1', spritesheetBase64: 'xxx' }
    } as never)
    const ok = await hatchSelected('Cat')
    expect(ok).toBe(true)
    expect($petGenStatus.get()).toBe('preview')
    expect($petGenPreview.get()?.slug).toBe('cat-1')
  })
})

describe('adoptHatched', () => {
  it('selects the previewed pet + resets state', async () => {
    $petGenPreview.set({ enabled: true, slug: 'cat-1', displayName: 'Cat', spritesheetBase64: 'xxx' })
    rpc.mockResolvedValue({ ok: true, slug: 'cat-1', displayName: 'Cat' } as never)
    const ok = await adoptHatched('Cat')
    expect(ok).toBe(true)
    expect(rpc).toHaveBeenCalledWith('pet.select', { slug: 'cat-1' })
    expect($petGenStatus.get()).toBe('idle')
    expect($petGenPreview.get()).toBeNull()
  })
})
