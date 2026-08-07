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
  /** Fills the middle and truncates — a title, a session pill, a menu trigger. */
  center?: ReactNode
  left?: ReactNode
  right?: ReactNode
}) {
  return (
    <div
      className="shrink-0 border-b border-(--ui-stroke-tertiary) bg-(--ui-bg-chrome) select-none"
      style={{ paddingTop: 'var(--safe-area-inset-top)' }}
    >
      <div className="flex h-8 items-center gap-1 px-2">
        {left}
        <div className="min-w-0 flex-1 overflow-hidden">{center}</div>
        {right}
      </div>
    </div>
  )
}

/** Balances a single edge button so `center` stays optically centred. */
export function MobileChromeSpacer() {
  return <div aria-hidden className="size-4 shrink-0" />
}
