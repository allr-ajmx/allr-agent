import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/store/gateway', () => ({ requestGateway: vi.fn() }))

import { requestGateway } from '@/store/gateway'

import {
  $petGallery,
  $petGalleryStatus,
  adoptPet,
  loadPetGallery,
  loadPetThumb,
  rankedGalleryPets,
  setPetEnabled
} from './pet-gallery'
import type { PetGallery } from './pet-gallery'

const rpc = vi.mocked(requestGateway)

const gallery = (over: Partial<PetGallery> = {}): PetGallery => ({
  enabled: false,
  active: '',
  pets: [
    { slug: 'cat', displayName: 'Cat', installed: true },
    { slug: 'dog', displayName: 'Dog', installed: false, generated: true }
  ],
  ...over
})

describe('pet-gallery store', () => {
  beforeEach(() => {
    rpc.mockReset()
    $petGallery.set(null)
    $petGalleryStatus.set('idle')
  })
  afterEach(() => $petGallery.set(null))

  it('loads local then the full gallery', async () => {
    rpc.mockImplementation(async (method: string) => {
      if (method === 'pet.gallery') {
        return gallery() as never
      }

      if (method === 'pet.info') {
        return {
          addGatewayEventListener: () => () => {},
          enabled: false
        } as never
      }

      return {} as never
    })
    await loadPetGallery()
    expect($petGalleryStatus.get()).toBe('ready')
    expect($petGallery.get()?.pets.map(p => p.slug)).toEqual(['cat', 'dog'])
  })

  it('marks the backend stale on a missing-method error', async () => {
    rpc.mockRejectedValue(new Error('method not found: pet.gallery'))
    await loadPetGallery()
    expect($petGalleryStatus.get()).toBe('stale')
  })

  it('adopts a pet: selects it + marks active/installed', async () => {
    $petGallery.set(gallery())
    rpc.mockResolvedValue({} as never)
    await adoptPet('dog')
    expect(rpc).toHaveBeenCalledWith('pet.select', { slug: 'dog' })
    const g = $petGallery.get()!
    expect(g.active).toBe('dog')
    expect(g.enabled).toBe(true)
    expect(g.pets.find(p => p.slug === 'dog')?.installed).toBe(true)
  })

  it('disables the pet via pet.disable', async () => {
    $petGallery.set(gallery({ enabled: true, active: 'cat' }))
    rpc.mockResolvedValue({} as never)
    await setPetEnabled(false)
    expect(rpc).toHaveBeenCalledWith('pet.disable')
    expect($petGallery.get()?.enabled).toBe(false)
  })
})

describe('rankedGalleryPets', () => {
  const g = (over: Partial<PetGallery> = {}): PetGallery => ({
    enabled: true,
    active: 'cat',
    pets: [
      { slug: 'plain', displayName: 'Plain', installed: false },
      { slug: 'curated-one', displayName: 'Curated One', installed: false, curated: true },
      { slug: 'cat', displayName: 'Cat', installed: true },
      { slug: 'clawd', displayName: 'Clawd', installed: true },
      { slug: 'clawd-mini', displayName: 'Clawd Mini', installed: true },
      { slug: 'mine', displayName: 'Mine', installed: true, generated: true }
    ],
    ...over
  })

  it('drops the internal clawd pets', () => {
    expect(rankedGalleryPets(g()).map(p => p.slug)).not.toContain('clawd')
    expect(rankedGalleryPets(g()).map(p => p.slug)).not.toContain('clawd-mini')
  })

  it('ranks generated, then active, then installed, then curated', () => {
    expect(rankedGalleryPets(g()).map(p => p.slug)).toEqual(['mine', 'cat', 'curated-one', 'plain'])
  })

  it('filters on slug or display name', () => {
    expect(rankedGalleryPets(g(), 'CURATED').map(p => p.slug)).toEqual(['curated-one'])
    expect(rankedGalleryPets(g(), '  mine ').map(p => p.slug)).toEqual(['mine'])
    expect(rankedGalleryPets(null, 'x')).toEqual([])
  })
})

describe('loadPetThumb', () => {
  beforeEach(() => {
    rpc.mockReset()
    localStorage.clear()
  })

  it('serves a cached thumbnail without an RPC', async () => {
    localStorage.setItem('hermes.pet.thumb.warm', 'data:image/png;base64,WARM')

    await expect(loadPetThumb('warm')).resolves.toBe('data:image/png;base64,WARM')
    expect(rpc).not.toHaveBeenCalled()
  })

  it('caches a fetched thumbnail and dedupes concurrent callers', async () => {
    rpc.mockResolvedValue({ ok: true, dataUri: 'data:image/png;base64,NEW' } as never)

    const [a, b] = await Promise.all([loadPetThumb('fresh', 'u'), loadPetThumb('fresh', 'u')])

    expect(a).toBe('data:image/png;base64,NEW')
    expect(b).toBe(a)
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem('hermes.pet.thumb.fresh')).toBe('data:image/png;base64,NEW')
  })

  it('never runs more than four pet.thumb RPCs at once', async () => {
    let inFlight = 0
    let peak = 0
    const release: (() => void)[] = []

    rpc.mockImplementation(
      () =>
        new Promise(resolve => {
          inFlight += 1
          peak = Math.max(peak, inFlight)
          release.push(() => {
            inFlight -= 1
            resolve({ ok: false } as never)
          })
        }) as never
    )

    const all = Promise.all(Array.from({ length: 20 }, (_, i) => loadPetThumb(`slug-${i}`)))

    // Drain the queue a wave at a time; each release lets the pump start another.
    for (let i = 0; i < 20; i += 1) {
      await Promise.resolve()
      release.shift()?.()
    }

    await expect(all).resolves.toHaveLength(20)
    expect(peak).toBeLessThanOrEqual(4)
    expect(rpc).toHaveBeenCalledTimes(20)
  })
})
