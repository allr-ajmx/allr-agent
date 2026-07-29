import { ActivityScreenRoot } from '@/app/activity-screen'
import { MobileController } from '@/app/mobile-controller'
import { SecondaryWindowRoot } from '@/app/secondary-window'
import { isActivityWindow, isSecondaryWindow } from '@/store/windows'

export function App() {
  // A native screen activity (`?win=activity`, Android/iOS) renders a single
  // full-screen windowable surface — Settings / Command Center / Profiles, chosen
  // live by the current route — with its own top bar + Home, bypassing the chat
  // shell (MJX-141).
  if (isActivityWindow()) {
    return <ActivityScreenRoot />
  }

  // A native pop-out window (`?win=secondary`) renders a single chat via
  // SecondaryWindowRoot, bypassing the full shell/overlays entirely (MJX-104).
  return isSecondaryWindow() ? <SecondaryWindowRoot /> : <MobileController />
}
