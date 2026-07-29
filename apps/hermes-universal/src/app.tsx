import { ActivityScreenRoot } from '@/app/activity-screen'
import { MobileController } from '@/app/mobile-controller'
import { SecondaryWindowRoot } from '@/app/secondary-window'
import { activityScreen, isSecondaryWindow } from '@/store/windows'

export function App() {
  // A native activity screen (`?win=activity&screen=…`, Android) renders a single
  // full-screen surface — Settings or the Command Center — with its own top bar
  // and Home button, bypassing the chat shell (MJX-141).
  const screen = activityScreen()

  if (screen) {
    return <ActivityScreenRoot screen={screen} />
  }

  // A native pop-out window (`?win=secondary`) renders a single chat via
  // SecondaryWindowRoot, bypassing the full shell/overlays entirely (MJX-104).
  return isSecondaryWindow() ? <SecondaryWindowRoot /> : <MobileController />
}
