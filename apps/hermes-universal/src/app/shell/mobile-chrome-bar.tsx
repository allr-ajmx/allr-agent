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
      style={{ paddingTop: 'var(--safe-area-inset-top)' }}
    >
      {/* Tall enough to contain a touch target. Every button in this row is
          floored at 44px on a coarse pointer (see styles.css), so an `h-8` row
          — 36px — clipped the title button on the chat and on Settings. The row
          is the constraint the buttons already had, made explicit. */}
      <div className="flex h-11 items-center gap-1 px-2">
        {left}
        <div className="min-w-0 flex-1 overflow-hidden">{center}</div>
        {right}
      </div>
    </div>
  )
}
