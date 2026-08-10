import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/store/gateway', async () => {
  const { atom } = await import('@/store/atom')

  return {
    addGatewayEventListener: () => () => {},
    requestGateway: vi.fn().mockResolvedValue({}),
    $gatewayState: atom('open')
  }
})
vi.mock('@/store/notifications', () => ({ clearNotifications: vi.fn(), notify: vi.fn(), notifyError: vi.fn() }))

import { requestGateway } from '@/store/gateway'
import { $sessionStates } from '@/store/session-state-types'
import { resetSessionStates, seedActiveSession, seedSession } from '@/test-sessions'

import { $currentModel, $currentProvider, selectModel, setCurrentModel, setCurrentProvider } from './model'

// ⌘⇧M opens the picker for the pane under the pointer, so a selection names the
// session it is meant for. The composer's own dropdown omits it and keeps
// meaning "the primary chat" (MJXHRM-226).
describe('selectModel targeting', () => {
  beforeEach(() => {
    resetSessionStates()
    vi.mocked(requestGateway).mockReset().mockResolvedValue({})
    setCurrentModel('primary-model')
    setCurrentProvider('primary-provider')
  })

  it('switches the primary chat and its composer pill when no session is named', async () => {
    seedActiveSession('runtime-1')

    await expect(selectModel({ model: 'glm-5', provider: 'zai' })).resolves.toBe(true)

    expect(requestGateway).toHaveBeenCalledWith('config.set', {
      session_id: 'runtime-1',
      key: 'model',
      value: 'glm-5 --provider zai --session'
    })
    expect($currentModel.get()).toBe('glm-5')
    expect($currentProvider.get()).toBe('zai')
  })

  // The composer's globals belong to the primary chat. Writing them for a tile
  // would repaint its pill with a model the primary session is not running.
  it('switches a named tile without touching the composer pill', async () => {
    seedActiveSession('runtime-1')
    seedSession('runtime-2', { model: 'old-model', provider: 'old-provider' })

    await expect(selectModel({ model: 'glm-5', provider: 'zai', sessionId: 'runtime-2' })).resolves.toBe(true)

    expect(requestGateway).toHaveBeenCalledWith('config.set', expect.objectContaining({ session_id: 'runtime-2' }))
    expect($sessionStates.get()['runtime-2']).toMatchObject({ model: 'glm-5', provider: 'zai' })
    expect($currentModel.get()).toBe('primary-model')
    expect($currentProvider.get()).toBe('primary-provider')
  })

  it('rolls the tile back to its own previous model when the switch fails', async () => {
    seedActiveSession('runtime-1')
    seedSession('runtime-2', { model: 'old-model', provider: 'old-provider' })
    vi.mocked(requestGateway).mockRejectedValue(new Error('nope'))

    await expect(selectModel({ model: 'glm-5', provider: 'zai', sessionId: 'runtime-2' })).resolves.toBe(false)

    expect($sessionStates.get()['runtime-2']).toMatchObject({ model: 'old-model', provider: 'old-provider' })
    expect($currentModel.get()).toBe('primary-model')
  })

  // A draft has no live session, so the pick is pure UI state — session.create
  // ships it as that session's override.
  it('stores the pick without a config.set when there is no live session', async () => {
    seedActiveSession('draft-1', { runtimeSessionId: '' })

    await expect(selectModel({ model: 'glm-5', provider: 'zai' })).resolves.toBe(true)

    expect(requestGateway).not.toHaveBeenCalled()
    expect($currentModel.get()).toBe('glm-5')
  })
})
