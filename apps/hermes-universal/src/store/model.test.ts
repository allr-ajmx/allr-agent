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
import { modelOptionsQueryKey } from '@/lib/model-options'
import { queryClient } from '@/lib/query-client'
import { requestGateway } from '@/store/gateway'
import type { NotificationInput } from '@/store/notifications'
import { notify } from '@/store/notifications'
import { $activeGatewayProfile } from '@/store/profile'
import { $sessionStates } from '@/store/session-state-types'
import { resetSessionStates, seedActiveSession, seedSession } from '@/test-sessions'
import type { ModelOptionsResponse } from '@/types/hermes'

import { $currentModel, $currentProvider, selectModel, setCurrentModel, setCurrentProvider } from './model'

const optionsKey = (sessionId: null | string) => modelOptionsQueryKey($activeGatewayProfile.get(), sessionId)

const cachedModel = (sessionId: null | string): string | undefined =>
  queryClient.getQueryData<ModelOptionsResponse>(optionsKey(sessionId))?.model

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
    // The primary composer reads its live slice, so the optimistic paint has to
    // land there too — not only on the draft-default globals.
    expect($sessionStates.get()['runtime-1']).toMatchObject({ model: 'glm-5', provider: 'zai' })
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

  // A named surface hands over a session KEY (`$focusedRuntimeId`, a tile's
  // `tileRuntimeKey`). That is only the wire id once the session is live — a
  // tile still hydrating carries a `hydrating:<stored>` placeholder, and sending
  // that as `session_id` addresses a session the gateway has never heard of.
  it('paints the tile by KEY but addresses the RPC by runtime id', async () => {
    seedActiveSession('runtime-1')
    seedSession('hydrating:stored-9', { runtimeSessionId: 'runtime-9', model: 'old-model' })

    await expect(selectModel({ model: 'glm-5', provider: 'zai', sessionId: 'hydrating:stored-9' })).resolves.toBe(true)

    expect(requestGateway).toHaveBeenCalledWith('config.set', expect.objectContaining({ session_id: 'runtime-9' }))
    expect($sessionStates.get()['hydrating:stored-9']).toMatchObject({ model: 'glm-5', provider: 'zai' })
  })

  // No runtime yet = nothing to switch. It must NOT fall through to the
  // sessionless options bucket either: that one is the PROFILE's catalog, and a
  // tile's pick is not the profile's model.
  it('holds a named surface with no runtime as UI state only', async () => {
    seedActiveSession('runtime-1')
    seedSession('draft:2', { runtimeSessionId: '' })
    queryClient.setQueryData<ModelOptionsResponse>(optionsKey(null), { model: 'profile-model' } as ModelOptionsResponse)

    await expect(selectModel({ model: 'glm-5', provider: 'zai', sessionId: 'draft:2' })).resolves.toBe(true)

    expect(requestGateway).not.toHaveBeenCalled()
    expect($sessionStates.get()['draft:2']).toMatchObject({ model: 'glm-5' })
    expect(cachedModel(null)).toBe('profile-model')
  })
})

/**
 * MJXHRM-304 item 4 — a pick has to SURVIVE being made.
 *
 * The composer menu's checkmark is not the composer's atoms: with a live session
 * `currentPickerSelection` treats the gateway's `model.options` as authoritative.
 * Nothing wrote through to that cache, and the shared client holds it for 60s —
 * so the checkmark snapped back to the pre-pick model and stayed there. Mid-turn
 * it is worse: `model.options` reports the model still RUNNING, because
 * `config.set model` on a busy session only queues the pick (`deferred`).
 */
describe('selectModel round trip', () => {
  beforeEach(() => {
    resetSessionStates()
    queryClient.clear()
    vi.mocked(notify).mockReset()
    vi.mocked(requestGateway).mockReset().mockResolvedValue({})
    setCurrentModel('primary-model')
    setCurrentProvider('primary-provider')
  })

  it('writes the pick through to the session-scoped model.options cache', async () => {
    seedActiveSession('runtime-1')
    queryClient.setQueryData<ModelOptionsResponse>(optionsKey('runtime-1'), {
      model: 'old-model'
    } as ModelOptionsResponse)

    await selectModel({ model: 'glm-5', provider: 'zai' })

    expect(cachedModel('runtime-1')).toBe('glm-5')
  })

  // The one case the ticket names. A refetch here answers with the model the
  // turn is still running and repaints the old name over the user's choice.
  it('does not re-fetch the catalog when the gateway defers the switch mid-turn', async () => {
    seedActiveSession('runtime-1', { busy: true })
    vi.mocked(requestGateway).mockResolvedValue({ deferred: true, value: 'glm-5' })
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue()

    await expect(selectModel({ model: 'glm-5', provider: 'zai' })).resolves.toBe(true)

    expect(invalidate).not.toHaveBeenCalled()
    expect(cachedModel('runtime-1')).toBe('glm-5')
    expect($currentModel.get()).toBe('glm-5')
    invalidate.mockRestore()
  })

  it('re-fetches the catalog when the switch applied immediately', async () => {
    seedActiveSession('runtime-1')
    vi.mocked(requestGateway).mockResolvedValue({ deferred: false, value: 'glm-5' })
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue()

    await selectModel({ model: 'glm-5', provider: 'zai' })

    expect(invalidate).toHaveBeenCalledWith({ queryKey: optionsKey('runtime-1') })
    invalidate.mockRestore()
  })

  // `_apply_model_switch` returns BEFORE `agent.switch_model()` when its
  // expensive-model guard fires — 200 OK, `confirm_required: true`, nothing
  // switched. Reporting success and keeping the paint is a pill naming a model
  // the session is not running.
  it('rolls back and reports failure when the gateway refuses with confirm_required', async () => {
    seedActiveSession('runtime-1')
    queryClient.setQueryData<ModelOptionsResponse>(optionsKey('runtime-1'), {
      model: 'primary-model'
    } as ModelOptionsResponse)
    vi.mocked(requestGateway).mockResolvedValue({
      confirm_required: true,
      confirm_message: 'Opus 5 costs $15/Mtok.',
      value: 'opus-5'
    })

    await expect(selectModel({ model: 'opus-5', provider: 'anthropic' })).resolves.toBe(false)

    expect($currentModel.get()).toBe('primary-model')
    expect($currentProvider.get()).toBe('primary-provider')
    expect(cachedModel('runtime-1')).toBe('primary-model')
    expect(vi.mocked(notify).mock.calls[0][0]).toMatchObject({
      kind: 'warning',
      message: 'Opus 5 costs $15/Mtok.'
    })
  })

  // The refusal is answerable, not a dead end: the warning carries the one
  // action that resolves it. Also pins the three i18n paths — translateNow
  // returns the KEY when a path is wrong, so a typo would render as
  // `common.confirm` on screen with typecheck and every other test still green.
  it('offers a confirm action that re-issues the switch with the confirm flag', async () => {
    seedActiveSession('runtime-1')
    vi.mocked(requestGateway).mockResolvedValue({ confirm_required: true, confirm_message: 'pricey' })

    await selectModel({ model: 'opus-5', provider: 'anthropic' })

    const input = vi.mocked(notify).mock.calls[0][0] as NotificationInput

    expect(input.title).toBe('Switch model')
    expect(input.action?.label).toBe('Confirm')

    vi.mocked(requestGateway).mockResolvedValue({})
    input.action?.onClick()
    await vi.waitFor(() =>
      expect(requestGateway).toHaveBeenLastCalledWith(
        'config.set',
        expect.objectContaining({ confirm_expensive_model: true, session_id: 'runtime-1' })
      )
    )
    expect($currentModel.get()).toBe('opus-5')
  })

  it('rolls the cache back with the pill when the RPC throws', async () => {
    seedActiveSession('runtime-1')
    queryClient.setQueryData<ModelOptionsResponse>(optionsKey('runtime-1'), {
      model: 'primary-model'
    } as ModelOptionsResponse)
    vi.mocked(requestGateway).mockRejectedValue(new Error('nope'))

    await expect(selectModel({ model: 'glm-5', provider: 'zai' })).resolves.toBe(false)

    expect($currentModel.get()).toBe('primary-model')
    expect(cachedModel('runtime-1')).toBe('primary-model')
  })
})
