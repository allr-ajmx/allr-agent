import { useStore } from '@nanostores/react'

import { ModelVisibilityDialog } from '@/components/model-visibility-dialog'
import { $sessionId } from '@/store/chat'
import { $gatewayState, getGatewayClient } from '@/store/gateway'
import { $modelVisibilityOpen, setModelVisibilityOpen } from '@/store/model-visibility'

interface ModelVisibilityOverlayProps {
  onOpenProviders: () => void
}

// Mount point for the "Edit models" dialog opened from the composer's model
// menu (ModelMenuPanel → setModelVisibilityOpen). Ported from desktop's
// ModelVisibilityOverlay; adapted to universal's stores ($gatewayState in
// @/store/gateway, $sessionId in @/store/chat) and self-sources the gateway
// via getGatewayClient() the way the composer does.
export function ModelVisibilityOverlay({ onOpenProviders }: ModelVisibilityOverlayProps) {
  const sessionId = useStore($sessionId)
  const gatewayOpen = useStore($gatewayState) === 'open'
  const open = useStore($modelVisibilityOpen)

  if (!gatewayOpen) {
    return null
  }

  return (
    <ModelVisibilityDialog
      gw={getGatewayClient() ?? undefined}
      onOpenChange={setModelVisibilityOpen}
      onOpenProviders={onOpenProviders}
      open={open}
      sessionId={sessionId}
    />
  )
}
