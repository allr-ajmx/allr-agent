import { ActivityScreenRoot } from '@/app/activity-screen'
import { CloseConfirm } from '@/app/close-confirm'
import { HUD_SURFACE } from '@/app/hud/hud'
import { HudWindowRoot } from '@/app/hud/hud-window'
import { MobileController } from '@/app/mobile-controller'
import { QUICK_ENTRY_SURFACE } from '@/app/quick-entry/quick-entry'
import { QuickEntryWindowRoot } from '@/app/quick-entry/quick-entry-window'
import { RemoteFolderPicker } from '@/app/right-pane/files/remote-picker'
import { TileWindowRoot } from '@/app/tile-window'
import { FindBar } from '@/components/find-bar'
import { isActivityWindow, isTileWindow, satelliteSurface } from '@/store/windows'

/**
 * Every window root, plus the surfaces that must exist in ALL of them.
 *
 * `RemoteFolderPicker` is one such surface: it is not a view, it is the
 * registration that gives `selectDesktopPaths` / `selectRemotePaths` somewhere
 * to send a pick. Unregistered, both resolve `[]`, which every caller reads as
 * "cancelled" — so the composer's `Files… ▸ Remote…`, Settings ▸ Archived's
 * "choose folder" and Profiles ▸ import were dead clicks in exactly the roots
 * that skip `ContribController`: the detached tile window, the HUD, and the
 * Android/iOS activity screen (which IS the Settings/Profiles surface there).
 *
 * `FindBar` (MJXHRM-387) is the second. It used to mount inside
 * `MobileController` only, so ⌘F searched the main shell and nothing else —
 * dead in a detached chat window showing a whole transcript, dead in the HUD
 * holding the same conversation, dead on the Android activity screen. It renders
 * nothing until opened and carries its own accelerator where no dispatcher
 * exists, so mounting it per window is free.
 *
 * `CloseConfirm` (MJXHRM-390) is the third, and it was the same mistake one
 * level down: the "close a working chat?" gate mounted inside
 * `ContribController`, i.e. only in the DOCKED TILE TREE. A phone renders
 * `MobileShell` and a narrow window renders `AppShell`, so on both the gate
 * could park a pending close and nothing would ever draw the question — which
 * is why the mobile bubble strip dropped a chat mid-turn without asking.
 *
 * Mounted HERE rather than once per root so the next root cannot forget them —
 * the failure mode is silence, which is the kind that ships.
 */
export function App() {
  return (
    <>
      <AppRoot />
      <RemoteFolderPicker />
      <FindBar />
      <CloseConfirm />
    </>
  )
}

function AppRoot() {
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
