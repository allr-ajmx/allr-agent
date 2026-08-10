import { atom } from 'nanostores'

import { getGlobalModelInfo } from '@/hermes'
import { Codecs, persistentAtom } from '@/lib/persisted'
import { $sessionId } from '@/store/chat'
import { requestGateway } from '@/store/gateway'
import { notifyError } from '@/store/notifications'
import { $sessionStates, updateSession } from '@/store/session-state-types'

// Composer model state (ported from desktop's session-store model atoms +
// use-model-controls). The current model/provider drives the composer model
// pill; switching is SESSION-SCOPED via the gateway `config.set` --session path
// (desktop parity) and never rewrites the global default (Settings → Model).

export const $currentModel = persistentAtom('hermes.model.current', '', Codecs.text)
export const $currentProvider = persistentAtom('hermes.model.provider', '', Codecs.text)
export const $currentReasoningEffort = persistentAtom('hermes.model.effort', '', Codecs.text)
export const $currentFastMode = persistentAtom('hermes.model.fast', false, Codecs.bool)
// Open flag for the full model picker (components/model-picker, mounted by
// app/model-picker-overlay). Raised by ⌘⇧M (`composer.modelPicker`) and by the
// composer pill when the gateway is closed and no live dropdown exists.
export const $modelPickerOpen = atom(false)

export const setCurrentModel = (value: string): void => $currentModel.set(value)
export const setCurrentProvider = (value: string): void => $currentProvider.set(value)
export const setCurrentReasoningEffort = (value: string): void => $currentReasoningEffort.set(value)
export const setCurrentFastMode = (value: boolean): void => $currentFastMode.set(value)
export const setModelPickerOpen = (value: boolean): void => $modelPickerOpen.set(value)

export interface ModelSelection {
  model: string
  provider: string
  /** Target ONE surface's session — a tile, or the pane under the pointer.
   *  Omitted means the primary chat, which is what the composer's own dropdown
   *  wants; `null` means "no live session", i.e. pure UI state. */
  sessionId?: null | string
}

/**
 * Seed the composer's model state from the profile default. Only fills an EMPTY
 * selection unless `force` (a profile swap), so a user's pick survives the
 * lifecycle refreshes that fire on boot / session events. A live session's own
 * session.info sync (store/chat) takes over once it lands.
 */
export async function refreshCurrentModel(force = false): Promise<void> {
  try {
    if (!force && $currentModel.get()) {
      return
    }

    const result = await getGlobalModelInfo()

    if (!force && $currentModel.get()) {
      return
    }

    if (typeof result.model === 'string') {
      setCurrentModel(result.model)
    }

    if (typeof result.provider === 'string') {
      setCurrentProvider(result.provider)
    }
  } catch {
    // A later session.info event still updates this once the agent is ready.
  }
}

/**
 * Switch the model for ONE session. Optimistic update, then `config.set` with
 * `--session` so only that session's model changes. With no live session it's
 * pure UI state (applied on session.create). Rolls back on failure. Returns
 * whether the switch succeeded.
 *
 * `selection.sessionId` names the surface being switched — a tile, or the pane
 * under the pointer when the picker was opened. Without it the target is the
 * primary chat, which is what the composer's own dropdown means. A tile switch
 * must NOT touch the composer's globals: they belong to the primary chat, and
 * writing them would repaint its pill with a model it isn't running.
 */
export async function selectModel(selection: ModelSelection): Promise<boolean> {
  const primaryRuntimeId = $sessionId.get()
  const sessionId = 'sessionId' in selection ? (selection.sessionId ?? null) : primaryRuntimeId
  const touchesPrimary = !sessionId || sessionId === primaryRuntimeId
  const slice = sessionId ? $sessionStates.get()[sessionId] : undefined

  const prevModel = touchesPrimary ? $currentModel.get() : (slice?.model ?? '')
  const prevProvider = touchesPrimary ? $currentProvider.get() : (slice?.provider ?? '')

  const paint = (model: string, provider: string): void => {
    if (touchesPrimary) {
      setCurrentModel(model)
      setCurrentProvider(provider)
    } else if (sessionId) {
      // Optimistic tile paint — the agent's own `session.info` confirms it.
      updateSession(sessionId, state => ({ ...state, model, provider }))
    }
  }

  paint(selection.model, selection.provider)

  if (!sessionId) {
    return true
  }

  try {
    await requestGateway('config.set', {
      session_id: sessionId,
      key: 'model',
      value: `${selection.model} --provider ${selection.provider} --session`
    })

    return true
  } catch (err) {
    paint(prevModel, prevProvider)
    notifyError(err, 'Failed to switch model')

    return false
  }
}
