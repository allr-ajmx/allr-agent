import { MobileController } from '@/app/mobile-controller'
import { SecondaryWindowRoot } from '@/app/secondary-window'
import { isSecondaryWindow } from '@/store/windows'

export function App() {
  // A native pop-out window (`?win=secondary`) renders a single chat via
  // SecondaryWindowRoot, bypassing the full shell/overlays entirely (MJX-104).
  return isSecondaryWindow() ? <SecondaryWindowRoot /> : <MobileController />
}
