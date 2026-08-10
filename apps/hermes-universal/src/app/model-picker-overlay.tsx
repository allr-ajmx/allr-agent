import { useStore } from '@nanostores/react'

import { ModelPickerDialog } from '@/components/model-picker'
import { useStoreSelector } from '@/lib/use-session-slice'
import { $sessionId } from '@/store/chat'
import { $gatewayState, getGatewayClient } from '@/store/gateway'
import { $currentModel, $currentProvider, $modelPickerOpen, selectModel, setModelPickerOpen } from '@/store/model'
import { $activeGatewayProfile } from '@/store/profile'
import { $activeSessionKey } from '@/store/session-state-types'
import { $focusedRuntimeId, $focusedSessionState } from '@/store/session-states'

interface ModelPickerOverlayProps {
  onOpenProviders: () => void
}

// Mount point for the full model picker — the ⌘⇧M surface, and the composer
// pill's fallback when the gateway is closed and no live dropdown exists.
// Ported from desktop's ModelPickerOverlay; adapted to universal's stores the
// same way ModelVisibilityOverlay next door is.
//
// It targets the FOCUSED pane, not the active session. With tiles open, ⌘⇧M over
// a parked conversation has to switch THAT conversation's model — otherwise the
// shortcut silently retunes whichever chat the sidebar last selected, which is
// rarely the one under the pointer (MJXHRM-226).
export function ModelPickerOverlay({ onOpenProviders }: ModelPickerOverlayProps) {
  const primarySessionId = useStore($sessionId)
  const primaryModel = useStore($currentModel)
  const primaryProvider = useStore($currentProvider)
  const activeSessionKey = useStore($activeSessionKey)
  const focusedRuntimeId = useStore($focusedRuntimeId)
  // `$focusedSessionState` is a projection of `$sessionStates`, republished on
  // EVERY message delta — and this overlay is mounted app-wide. Only two fields
  // are read off it, so subscribing to the whole object would re-render this
  // component (and the un-memoized closed dialog below) once per token while the
  // focused session streams. Select each scalar so an unchanged model/provider
  // bails out instead, exactly as desktop does.
  const focusedModel = useStoreSelector($focusedSessionState, state => state.model)
  const focusedProvider = useStoreSelector($focusedSessionState, state => state.provider)
  const profile = useStore($activeGatewayProfile)
  const gatewayOpen = useStore($gatewayState) === 'open'
  const open = useStore($modelPickerOpen)

  // `$focusedRuntimeId` falls back to the active session key when no tile is
  // focused, so this is the one test that distinguishes "a tile is under the
  // pointer" from "the picker belongs to the primary chat" — and with no tiles
  // open the whole component behaves exactly as it did before.
  const targetsTile = Boolean(focusedRuntimeId) && focusedRuntimeId !== activeSessionKey

  const sessionId = targetsTile ? focusedRuntimeId : primarySessionId
  // The composer's globals are the PRIMARY chat's model; a tile carries its own
  // on its slice. An unrun tile has neither, so fall back rather than paint the
  // picker with a blank selection.
  const currentModel = targetsTile && focusedModel ? focusedModel : primaryModel
  const currentProvider = targetsTile && focusedProvider ? focusedProvider : primaryProvider

  if (!gatewayOpen) {
    return null
  }

  return (
    <ModelPickerDialog
      currentModel={currentModel}
      currentProvider={currentProvider}
      gw={getGatewayClient() ?? undefined}
      onOpenChange={setModelPickerOpen}
      onOpenProviders={onOpenProviders}
      onSelect={selection => void selectModel({ ...selection, sessionId })}
      open={open}
      profile={profile}
      sessionId={sessionId}
    />
  )
}
