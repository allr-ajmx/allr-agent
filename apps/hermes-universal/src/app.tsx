import { ActivityScreenRoot } from '@/app/activity-screen'
import { HUD_SURFACE } from '@/app/hud/hud'
import { HudWindowRoot } from '@/app/hud/hud-window'
import { MobileController } from '@/app/mobile-controller'
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

  // A tile window (`?win=tile`, or the legacy `?win=secondary`) hosts exactly
  // ONE tile — a detached pane, or the single-chat pop-out — bypassing the full
  // shell/overlays entirely (MJX-104, generalized in MJXHRM-173).
  return isTileWindow() ? <TileWindowRoot /> : <MobileController />
}
