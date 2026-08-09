import { useStore } from '@nanostores/react'

import { ModelPickerDialog } from '@/components/model-picker'
import { $sessionId } from '@/store/chat'
import { $gatewayState, getGatewayClient } from '@/store/gateway'
import { $currentModel, $currentProvider, $modelPickerOpen, selectModel, setModelPickerOpen } from '@/store/model'
import { $activeGatewayProfile } from '@/store/profile'

interface ModelPickerOverlayProps {
  onOpenProviders: () => void
}

// Mount point for the full model picker — the ⌘⇧M surface, and the composer
// pill's fallback when the gateway is closed and no live dropdown exists.
// Ported from desktop's ModelPickerOverlay; adapted to universal's stores the
// same way ModelVisibilityOverlay next door is.
//
// Desktop targets the pane under the pointer here, reading its focused-tile
// atoms. Universal targets the ACTIVE session instead — pointer-under-pane
// targeting lands with the tile-focus rework (see MJXHRM-226).
export function ModelPickerOverlay({ onOpenProviders }: ModelPickerOverlayProps) {
  const sessionId = useStore($sessionId)
  const currentModel = useStore($currentModel)
  const currentProvider = useStore($currentProvider)
  const profile = useStore($activeGatewayProfile)
  const gatewayOpen = useStore($gatewayState) === 'open'
  const open = useStore($modelPickerOpen)

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
      onSelect={selection => void selectModel(selection)}
      open={open}
      profile={profile}
      sessionId={sessionId}
    />
  )
}
