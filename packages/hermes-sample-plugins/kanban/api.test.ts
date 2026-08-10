/**
 * `bindApi` is the board's whole footprint on the host: four persisted atoms
 * and one live `task_events` socket, all handed to `ctx.onDispose`. Unloading
 * the plugin has to leave NOTHING behind — a surviving socket keeps
 * reconnecting to a board nobody is looking at, and a surviving atom listener
 * keeps writing to the storage of a plugin that is off.
 */

import type { PluginStorage } from '@hermes/plugin-sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $boardSlug, $lanesByProfile, bindApi } from './api'

const rest = vi.fn(async () => ({}) as never)

function fakeStorage(seed: Record<string, unknown> = {}): { storage: PluginStorage; written: Record<string, unknown> } {
  const written: Record<string, unknown> = {}

  return {
    written,
    storage: {
      get: <T>(key: string, fallback: T) => (key in seed ? (seed[key] as T) : fallback),
      set: (key, value) => void (written[key] = value),
      remove: key => void delete written[key]
    }
  }
}

function fakeSocket() {
  const opened: string[] = []
  const closed: string[] = []

  const socket = (path: string) => {
    opened.push(path)

    return () => closed.push(path)
  }

  return { closed, opened, socket }
}

beforeEach(() => {
  $boardSlug.set('')
  $lanesByProfile.set(false)
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('bindApi', () => {
  it('hydrates the persisted atoms from plugin storage', () => {
    const { storage } = fakeStorage({ boardSlug: 'ops', lanesByProfile: true })

    const dispose = bindApi(rest, storage, fakeSocket().socket)

    expect($boardSlug.get()).toBe('ops')
    expect($lanesByProfile.get()).toBe(true)

    dispose()
  })

  it('pins the events socket to the selected board, reopening on a switch', () => {
    const { storage } = fakeStorage()
    const { closed, opened, socket } = fakeSocket()

    const dispose = bindApi(rest, storage, socket)

    expect(opened).toEqual(['/events'])

    $boardSlug.set('ops')

    // The handshake carries the board, so a switch is a close + reopen.
    expect(closed).toEqual(['/events'])
    expect(opened).toEqual(['/events', '/events?board=ops'])

    dispose()
  })

  it('leaves nothing behind on unload — this is the ctx.onDispose contract', () => {
    const { storage, written } = fakeStorage()
    const { closed, opened, socket } = fakeSocket()

    const dispose = bindApi(rest, storage, socket)

    dispose()

    expect(closed).toEqual(['/events'])

    // Post-dispose the atoms are inert: no reopened socket, no storage write
    // from a plugin the user has switched off.
    $boardSlug.set('ops')
    $lanesByProfile.set(true)

    expect(opened).toEqual(['/events'])
    expect(written).toEqual({})
  })

  it('rejects calls once unbound rather than reaching a stale REST door', async () => {
    const { storage } = fakeStorage()

    bindApi(rest, storage, fakeSocket().socket)()

    const { fetchBoards } = await import('./api')

    await expect(fetchBoards()).rejects.toThrow(/not ready/)
  })
})
