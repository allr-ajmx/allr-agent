import { ActivityScreenRoot } from '@/app/activity-screen'
import { MobileController } from '@/app/mobile-controller'
import { TileWindowRoot } from '@/app/tile-window'
import { isActivityWindow, isTileWindow } from '@/store/windows'

export function App() {
  // A native screen activity (`?win=activity`, Android/iOS) renders a single
  // full-screen windowable surface — Settings / Command Center / Profiles, chosen
  // live by the current route — with its own top bar + Home, bypassing the chat
  // shell (MJX-141).
  if (isActivityWindow()) {
    return <ActivityScreenRoot />
  }

  // A satellite window (`?win=tile`, or the legacy `?win=secondary`) hosts
  // exactly ONE tile — a detached pane, or the single-chat pop-out — bypassing
  // the full shell/overlays entirely (MJX-104, generalized in MJXHRM-173).
  return isTileWindow() ? <TileWindowRoot /> : <MobileController />
}
