import type { ReactNode } from 'react'

// The one mobile top bar.
//
// Every phone surface draws the same row — the chat shell, the Workspace, the
// windowable screens (Settings / Command Center / Profiles) — so its height,
// gutter and safe-area handling have to be defined in exactly one place. They
// had drifted (h-8/px-2 against h-10/px-1 with a wide text button), and the
// chrome visibly jumped height and gutter the moment you opened the Workspace.
//
// It owns the safe-area TOP inset: the chrome fills the status-bar / notch area
// and the controls sit below it. Callers own the bottom and side insets.
//
// `left` and `right` take a fragment rather than a single node so a surface can
// hang a contributed slot off its edge button without re-implementing the row.
export function MobileChromeBar({
  center,
  left,
  right
}: {
  /**
   * Takes every pixel the edge controls don't, and truncates — a title, a
   * session pill, a menu trigger. Left-aligned, not centred: a centred title
   * has to be balanced against whatever sits opposite it, which means a bar
   * with one button spends the other side on a spacer and a long title
   * truncates while empty space sits beside it.
   */
  center?: ReactNode
  left?: ReactNode
  right?: ReactNode
}) {
  return (
    <div
      className="shrink-0 border-b border-(--ui-stroke-tertiary) bg-(--ui-bg-chrome) select-none"
      // Named so the pet's walk box can find it: this bar is the phone's
      // ceiling, the way the desktop statusbar is its floor.
      data-slot="mobile-chrome-bar"
      style={{ paddingTop: 'var(--safe-area-inset-top)' }}
    >
      {/* Tall enough to contain a touch target with room to spare. Every button
          in this row is floored at 44px on a coarse pointer (see styles.css), so
          an `h-8` row — 36px — clipped the title button on the chat and on
          Settings. 44px exactly then made the row fit its contents to the pixel,
          which reads as cramped and leaves a mistimed tap landing on the border;
          48px gives the floor 2px of air on each side.

          `self-stretch` on the centre cell, not `items-stretch` on the row: the
          centre is the only slot whose occupant is asked to fill the bar (a
          title menu is a wide target, an edge icon is not), and it is the only
          way its `h-full` resolves — `items-center` leaves this div auto-height,
          against which a percentage height silently falls back to the content's,
          leaving the title a small pill floating in a mostly empty row.

          It has to carry its own `items-center` with it: stretching the cell
          takes its content out of the row's centring, so a `center` that is a
          plain span — the Workspace's project name, the sidebar's "Sessions" —
          lands at the TOP of a 48px box while the edge buttons stay centred,
          and the bar reads as two rows. A `center` that asks for `h-full` still
          gets the full height; an explicit height beats align-items. */}
      <div className="flex h-12 items-center gap-1 px-2">
        {left}
        <div className="flex min-w-0 flex-1 items-center self-stretch overflow-hidden">{center}</div>
        {right}
      </div>
    </div>
  )
}
