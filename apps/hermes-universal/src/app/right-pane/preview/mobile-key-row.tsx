import type { CodeEditorApi } from '@/components/ui/code-editor'
import { Codicon } from '@/components/ui/codicon'
import { triggerHaptic } from '@/lib/haptics'
import { cn } from '@/lib/utils'

// The accessory key row: the thing that makes editing code on a phone possible
// rather than merely available.
//
// A phone keyboard has no Tab, no arrow keys, and buries every bracket, quote and
// operator two layers deep — so every serious mobile editor (Textastic, Termux's
// extra-keys, Blink) grows a row exactly like this. It sits directly above the
// system keyboard because the Workspace lifts its content by `--keyboard-inset`.
//
// Keys drive the editor through CodeEditorApi rather than synthesising key events:
// Tab means "indent this line", not "insert \t", and undo/redo have to reach
// CodeMirror's own history.
//
// Two rows, not one: the scrolling character strip and the fixed navigation
// cluster were fighting for the same 360px, and the cluster won — six ~40px keys
// left the characters a sliver. Splitting them lets each row use the full width
// and lets the keys themselves shrink to accessory-strip size.

interface MobileKeyRowProps {
  api: CodeEditorApi | null
  onSave: () => void
}

/** The character keys, in reach order: the ones you type constantly first, since
 *  the row scrolls and the left edge is what you get for free. */
const CHARS = [
  '{',
  '}',
  '(',
  ')',
  '[',
  ']',
  '<',
  '>',
  '/',
  '=',
  ':',
  ';',
  "'",
  '"',
  '`',
  '_',
  '-',
  '.',
  ',',
  '|',
  '&',
  '#',
  '$',
  '*',
  '+'
]

export function MobileKeyRow({ api, onSave }: MobileKeyRowProps) {
  const press = (action: () => void) => () => {
    void triggerHaptic('selection')
    action()
  }

  return (
    <div
      className="flex shrink-0 flex-col gap-1 border-t border-(--ui-stroke-tertiary) bg-(--ui-bg-chrome) px-1 py-1"
      // The row must never take focus: stealing it would close the keyboard and
      // drop the cursor, which is the one thing it exists to protect.
      onPointerDown={event => event.preventDefault()}
    >
      {/* Row 1 — indentation and characters. This one scrolls, so it gets the
          whole width: sharing it with the pinned cluster left ~100px of a
          360px handset for 25 characters. */}
      <div className="flex min-w-0 gap-1 overflow-x-auto">
        <KeyCap label="Tab" onPress={press(() => api?.indent())} wide />
        <KeyCap icon="chevron-left" label="Outdent" onPress={press(() => api?.outdent())} />

        {CHARS.map(char => (
          <KeyCap key={char} label={char} onPress={press(() => api?.insert(char))} />
        ))}
      </div>

      {/* Row 2 — navigation and the two commit actions. Fixed, never scrolls:
          these are the controls that must be in the same place every time. */}
      <div className="flex shrink-0 gap-1">
        <KeyCap grow icon="arrow-left" label="Left" onPress={press(() => api?.move('left'))} />
        <KeyCap grow icon="arrow-up" label="Up" onPress={press(() => api?.move('up'))} />
        <KeyCap grow icon="arrow-down" label="Down" onPress={press(() => api?.move('down'))} />
        <KeyCap grow icon="arrow-right" label="Right" onPress={press(() => api?.move('right'))} />
        <KeyCap grow icon="discard" label="Undo" onPress={press(() => api?.undo())} />
        <KeyCap grow icon="save" label="Save" onPress={press(onSave)} tone="primary" />
      </div>
    </div>
  )
}

// Deliberately under the 44px touch minimum the rest of the app holds to: this
// is a keyboard accessory strip, and every one of them — iOS's, Termux's,
// Blink's — sits in the 32-40px band, because the keys have to fit next to the
// keyboard they extend rather than compete with it for screen. Two rows is what
// buys that back: each key is smaller but nothing is crowded off the edge.
function KeyCap({
  grow,
  icon,
  label,
  onPress,
  tone,
  wide
}: {
  /** Share the row's width evenly — for the fixed row, which never scrolls. */
  grow?: boolean
  icon?: string
  label: string
  onPress: () => void
  tone?: 'primary'
  wide?: boolean
}) {
  return (
    <button
      aria-label={label}
      className={cn(
        'flex min-h-8 items-center justify-center rounded-md border border-(--ui-stroke-tertiary) bg-(--ui-bg-tertiary) font-code text-sm active:bg-(--chrome-action-hover)',
        grow ? 'min-w-0 flex-1' : 'shrink-0',
        !grow && (wide ? 'px-3' : 'w-8'),
        tone === 'primary' ? 'text-primary' : 'text-foreground'
      )}
      onClick={onPress}
      type="button"
    >
      {icon ? <Codicon name={icon} size="0.95rem" /> : label}
    </button>
  )
}
