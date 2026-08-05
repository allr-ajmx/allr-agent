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
      className="flex shrink-0 items-stretch gap-1 border-t border-(--ui-stroke-tertiary) bg-(--ui-bg-chrome) px-1 py-1"
      // The row must never take focus: stealing it would close the keyboard and
      // drop the cursor, which is the one thing it exists to protect.
      onPointerDown={event => event.preventDefault()}
    >
      <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
        <KeyCap label="Tab" onPress={press(() => api?.indent())} wide />
        <KeyCap icon="chevron-left" label="Outdent" onPress={press(() => api?.outdent())} />

        {CHARS.map(char => (
          <KeyCap key={char} label={char} onPress={press(() => api?.insert(char))} />
        ))}
      </div>

      {/* Pinned cluster: navigation and undo stay put while the character strip
          scrolls under them, so the two most-used controls never move. */}
      <div className="flex shrink-0 gap-1 border-l border-(--ui-stroke-tertiary) pl-1">
        <KeyCap icon="arrow-left" label="Left" onPress={press(() => api?.move('left'))} />
        <KeyCap icon="arrow-up" label="Up" onPress={press(() => api?.move('up'))} />
        <KeyCap icon="arrow-down" label="Down" onPress={press(() => api?.move('down'))} />
        <KeyCap icon="arrow-right" label="Right" onPress={press(() => api?.move('right'))} />
        <KeyCap icon="discard" label="Undo" onPress={press(() => api?.undo())} />
        <KeyCap icon="save" label="Save" onPress={press(onSave)} tone="primary" />
      </div>
    </div>
  )
}

function KeyCap({
  icon,
  label,
  onPress,
  tone,
  wide
}: {
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
        'flex min-h-9 shrink-0 items-center justify-center rounded-md border border-(--ui-stroke-tertiary) bg-(--ui-bg-tertiary) font-code text-sm active:bg-(--chrome-action-hover)',
        wide ? 'px-3' : 'w-9',
        tone === 'primary' ? 'text-primary' : 'text-foreground'
      )}
      onClick={onPress}
      type="button"
    >
      {icon ? <Codicon name={icon} size="0.95rem" /> : label}
    </button>
  )
}
