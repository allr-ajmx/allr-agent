import { atom } from 'nanostores'

import { getGlobalModelInfo } from '@/hermes'
import { translateNow } from '@/i18n'
import { modelOptionsQueryKey } from '@/lib/model-options'
import { Codecs, persistentAtom } from '@/lib/persisted'
import { queryClient } from '@/lib/query-client'
import { $sessionId } from '@/store/chat'
import { requestGateway } from '@/store/gateway'
import { notify, notifyError } from '@/store/notifications'
import { $activeGatewayProfile } from '@/store/profile'
import { $sessionStates, updateSession } from '@/store/session-state-types'
import type { ModelOptionsResponse } from '@/types/hermes'

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
// Open flag for the composer model pill's dropdown menu panel.
export const $modelMenuDropdownOpen = atom(false)

export const setCurrentModel = (value: string): void => $currentModel.set(value)
export const setCurrentProvider = (value: string): void => $currentProvider.set(value)
export const setCurrentReasoningEffort = (value: string): void => $currentReasoningEffort.set(value)
export const setCurrentFastMode = (value: boolean): void => $currentFastMode.set(value)
export const setModelPickerOpen = (value: boolean): void => $modelPickerOpen.set(value)
export const setModelMenuDropdownOpen = (value: boolean): void => $modelMenuDropdownOpen.set(value)

export interface ModelSelection {
  model: string
  provider: string
  /** Target ONE surface's session — a tile, or the pane under the pointer.
   *  Omitted means the primary chat, which is what the composer's own dropdown
   *  wants; `null` means "no live session", i.e. pure UI state. */
  sessionId?: null | string
  /** Re-issue a switch the gateway parked behind its expensive-model guard.
   *  Only ever set by the confirm action on the warning that guard raises. */
  confirmExpensive?: boolean
}

/** The `config.set model` reply (`tui_gateway/server.py`). Every field matters:
 *  `confirm_required` means the switch did NOT happen, and `deferred` means it
 *  happened but only takes effect on the next turn. */
interface ModelSwitchResult {
  confirm_message?: string
  confirm_required?: boolean
  deferred?: boolean
  value?: string
  warning?: string
}

/**
 * Mirror a selection into the cached `model.options` payload.
 *
 * The composer menu's checkmark is NOT the composer's own atoms: with a live
 * session `currentPickerSelection` (lib/model-status-label) treats the
 * gateway's `model.options` as authoritative, because that is the only surface
 * that knows what the agent is really on. Nothing here ever patched or
 * invalidated that cache, and the shared client holds it for `staleTime`
 * (60s) — so a pick repainted the pill and the menu snapped its checkmark
 * straight back to the pre-pick model, and stayed there for a minute. Desktop
 * writes through in `use-model-controls`'s `updateModelOptionsCache`; universal
 * had no counterpart.
 *
 * A null `sessionId` addresses the sessionless bucket, which is exactly what a
 * pre-session pick means: there is no session to scope to, and that bucket is
 * what the next `session.create` will run. A LIVE session's pick never reaches
 * it — only Settings → Model writes the profile default.
 */
function writeModelOptionsCache(
  sessionId: null | string,
  provider: string,
  model: string,
  profile: null | string | undefined
): void {
  queryClient.setQueryData<ModelOptionsResponse>(
    modelOptionsQueryKey(profile, sessionId),
    prev => ({ ...(prev ?? {}), model, provider }) as ModelOptionsResponse
  )
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
 *
 * The named target is a session KEY (`$focusedRuntimeId`, a tile's
 * `tileRuntimeKey`), which is only equal to the wire id once the session is
 * live — a tile still hydrating carries a `hydrating:<stored>` placeholder key.
 * The slice is painted by KEY and the RPC is addressed by
 * `runtimeSessionId`, exactly as `use-slash-command`'s `targetSessionId`
 * resolves it, so the two can never mean different sessions.
 *
 * The `config.set` REPLY is read, not discarded:
 *  - `confirm_required` — the gateway's expensive-model guard REFUSED the
 *    switch and returned OK anyway. Painting it and reporting success is the
 *    lie this used to tell: the pill named a model the session was not running.
 *  - `deferred` — the pick was queued because a turn is in flight, and applies
 *    at the next turn start. The catalog must NOT be re-fetched: it reports the
 *    model still running, which would repaint the old name over the pick.
 */
export async function selectModel(selection: ModelSelection): Promise<boolean> {
  const primaryRuntimeId = $sessionId.get()
  const targetKey = 'sessionId' in selection ? (selection.sessionId ?? null) : primaryRuntimeId
  const touchesPrimary = !targetKey || targetKey === primaryRuntimeId
  const slice = targetKey ? $sessionStates.get()[targetKey] : undefined
  // The wire id. For the primary the key already IS the runtime id ($sessionId);
  // for a named surface it comes off the slice, and its absence means "no live
  // session", i.e. the pick is UI state the next session.create ships.
  const wireSessionId = touchesPrimary ? targetKey : (slice?.runtimeSessionId ?? null)
  const profile = $activeGatewayProfile.get()

  const prevModel = touchesPrimary ? $currentModel.get() : (slice?.model ?? '')
  const prevProvider = touchesPrimary ? $currentProvider.get() : (slice?.provider ?? '')

  const paint = (model: string, provider: string): void => {
    if (touchesPrimary) {
      // The draft default the next session.create ships.
      setCurrentModel(model)
      setCurrentProvider(provider)
    }

    if (targetKey) {
      // Optimistic slice paint — the primary composer reads its live slice
      // (app/chat/session-view `primaryField`), so the globals alone would leave
      // the pill on the old name until `session.info` confirms the switch.
      updateSession(targetKey, state => ({ ...state, model, provider }))
    }

    // A named surface with no runtime yet has no bucket of its own — writing the
    // sessionless one would publish a tile's pick as the PROFILE's model.
    if (touchesPrimary || wireSessionId) {
      writeModelOptionsCache(wireSessionId, provider, model, profile)
    }
  }

  paint(selection.model, selection.provider)

  if (!wireSessionId) {
    return true
  }

  try {
    const result = await requestGateway<ModelSwitchResult>('config.set', {
      session_id: wireSessionId,
      key: 'model',
      value: `${selection.model} --provider ${selection.provider} --session`,
      ...(selection.confirmExpensive ? { confirm_expensive_model: true } : {})
    })

    if (result?.confirm_required) {
      // The guard fired: `_apply_model_switch` returned BEFORE
      // `agent.switch_model()`, so nothing changed on the backend. Undo the
      // optimistic paint and hand the user the gateway's own message plus the
      // one action that resolves it — re-issuing with the confirm flag.
      paint(prevModel, prevProvider)
      notify({
        kind: 'warning',
        title: translateNow('shell.statusbar.switchModel'),
        message: result.confirm_message || result.warning || translateNow('desktop.modelSwitchFailed'),
        action: {
          label: translateNow('common.confirm'),
          onClick: () => void selectModel({ ...selection, confirmExpensive: true })
        }
      })

      return false
    }

    if (!result?.deferred) {
      void queryClient.invalidateQueries({ queryKey: modelOptionsQueryKey(profile, wireSessionId) })
    }

    return true
  } catch (err) {
    paint(prevModel, prevProvider)
    notifyError(err, translateNow('desktop.modelSwitchFailed'))

    return false
  }
}
