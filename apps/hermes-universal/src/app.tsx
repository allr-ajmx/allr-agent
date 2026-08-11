import { ActivityScreenRoot } from '@/app/activity-screen'
import { HUD_SURFACE } from '@/app/hud/hud'
import { HudWindowRoot } from '@/app/hud/hud-window'
import { MobileController } from '@/app/mobile-controller'
import { QUICK_ENTRY_SURFACE } from '@/app/quick-entry/quick-entry'
import { QuickEntryWindowRoot } from '@/app/quick-entry/quick-entry-window'
import { TileWindowRoot } from '@/app/tile-window'
import { isActivityWindow, isTileWindow, satelliteSurface } from '@/store/windows'

export function App() {
  // A native screen activity (`?win=activity`, Android/iOS) renders a single
  // full-screen windowable surface — Settings / Command Center / Profiles, chosen
  // live by the current route — with its own top bar + Home, bypassing the chat
  // shell (MJX-141).
  if (isActivityWindow()) {
    return <ActivityScreenRoot />
  }

  // The HUD (`?win=hud`) — a floating surface over other applications, holding
  // the same conversation the summoning window had (MJXHRM-213). Branched here
  // rather than inside the tile root because it is not a detached pane: it is a
  // different SHAPE of the app, and the window it lives in is a native surface
  // negotiated before this code runs (`lib/surface.ts`).
  if (satelliteSurface() === HUD_SURFACE) {
    return <HudWindowRoot />
  }

  // Quick Entry (`?win=quick`) — a one-line capture surface summoned by a global
  // chord (MJXHRM-384). Branched beside the HUD because it is the same KIND of
  // thing and the opposite trade: the HUD is the whole conversation moved
  // somewhere else, this is a single prompt with no gateway of its own, handed
  // to the primary window to send.
  if (satelliteSurface() === QUICK_ENTRY_SURFACE) {
    return <QuickEntryWindowRoot />
  }

  // A tile window (`?win=tile`, or the legacy `?win=secondary`) hosts exactly
  // ONE tile — a detached pane, or the single-chat pop-out — bypassing the full
  // shell/overlays entirely (MJX-104, generalized in MJXHRM-173).
  return isTileWindow() ? <TileWindowRoot /> : <MobileController />
}
