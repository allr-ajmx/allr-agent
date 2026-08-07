import { Codicon } from '@/components/ui/codicon'
import { triggerHaptic } from '@/lib/haptics'
import { cn } from '@/lib/utils'

// The terminal's extra-keys row.
//
// A phone keyboard cannot send Esc, Tab, Ctrl or an arrow key, which is most of
// what a shell is driven by — so every mobile terminal worth using (Termux,
// Termius, Blink) grows a row like this. The layout follows their consensus set
// rather than inventing one.
//
// Ctrl and Alt are STICKY modifiers, not keys: tap arms them for the next
// keystroke (including one typed on the system keyboard), tap again locks them,
// tap a third time clears. That is the only way a modifier can work when the
// modifier and the letter come from two different keyboards.

/** Written as escapes, never as raw control bytes in the source. */
const ESC = '\u001b'

export interface TerminalModifiers {
  alt: 'armed' | 'locked' | 'off'
  ctrl: 'armed' | 'locked' | 'off'
}

interface MobileTerminalKeysProps {
  modifiers: TerminalModifiers
  onCycleModifier: (modifier: 'alt' | 'ctrl') => void
  /** Send raw bytes to the PTY, with the armed modifiers already applied. */
  onSend: (data: string) => void
}

/** Keys that scroll: the long tail you reach for a few times a session. */
const EXTRA_KEYS: readonly { label: string; send: string }[] = [
  { label: '^C', send: '\u0003' },
  { label: '^D', send: '\u0004' },
  { label: '^Z', send: '\u001a' },
  { label: '^L', send: '\u000c' },
  { label: '|', send: '|' },
  { label: '~', send: '~' },
  { label: '/', send: '/' },
  { label: '-', send: '-' },
  { label: '_', send: '_' },
  { label: '$', send: '$' },
  { label: '*', send: '*' },
  { label: '"', send: '"' },
  { label: "'", send: "'" },
  { label: '`', send: '`' },
  { label: 'Home', send: `${ESC}[H` },
  { label: 'End', send: `${ESC}[F` },
  { label: 'PgUp', send: `${ESC}[5~` },
  { label: 'PgDn', send: `${ESC}[6~` }
]

export function MobileTerminalKeys({ modifiers, onCycleModifier, onSend }: MobileTerminalKeysProps) {
  const send = (data: string) => () => {
    void triggerHaptic('selection')
    onSend(data)
  }

  const cycle = (modifier: 'alt' | 'ctrl') => () => {
    void triggerHaptic('selection')
    onCycleModifier(modifier)
  }

  return (
    <div
      className="flex shrink-0 items-stretch gap-1 border-t border-(--ui-stroke-tertiary) bg-(--ui-bg-chrome) px-1 py-1"
      // Never take focus: the terminal's textarea has to keep it, or the system
      // keyboard closes on every key-row tap.
      onPointerDown={event => event.preventDefault()}
    >
      <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
        <Key label="Esc" onPress={send(ESC)} wide />
        <Key label="Tab" onPress={send('\t')} wide />
        <Key label="Ctrl" onPress={cycle('ctrl')} state={modifiers.ctrl} wide />
        <Key label="Alt" onPress={cycle('alt')} state={modifiers.alt} wide />

        {EXTRA_KEYS.map(key => (
          <Key key={key.label} label={key.label} onPress={send(key.send)} />
        ))}
      </div>

      {/* Arrows stay pinned: history and line editing are what the row is for,
          and they can't be allowed to scroll away. */}
      <div className="flex shrink-0 gap-1 border-l border-(--ui-stroke-tertiary) pl-1">
        <Key icon="arrow-left" label="Left" onPress={send(`${ESC}[D`)} />
        <Key icon="arrow-up" label="Up" onPress={send(`${ESC}[A`)} />
        <Key icon="arrow-down" label="Down" onPress={send(`${ESC}[B`)} />
        <Key icon="arrow-right" label="Right" onPress={send(`${ESC}[C`)} />
      </div>
    </div>
  )
}

function Key({
  icon,
  label,
  onPress,
  state = 'off',
  wide
}: {
  icon?: string
  label: string
  onPress: () => void
  /** Modifier keys only: armed for one keystroke, or locked until cleared. */
  state?: 'armed' | 'locked' | 'off'
  wide?: boolean
}) {
  return (
    <button
      aria-label={label}
      aria-pressed={state === 'off' ? undefined : true}
      className={cn(
        'flex min-h-9 shrink-0 items-center justify-center rounded-md border font-code text-sm active:bg-(--chrome-action-hover)',
        wide ? 'px-2.5' : 'w-9',
        state === 'off'
          ? 'border-(--ui-stroke-tertiary) bg-(--ui-bg-tertiary) text-foreground'
          : // Armed reads as a highlight, locked as a filled key — a one-shot and
            // a lock have to be distinguishable at a glance or Ctrl gets stuck.
            state === 'armed'
            ? 'border-(--ui-accent-primary) bg-(--ui-accent-primary)/15 text-(--ui-accent-primary)'
            : 'border-(--ui-accent-primary) bg-(--ui-accent-primary) text-white'
      )}
      onClick={onPress}
      type="button"
    >
      {icon ? <Codicon name={icon} size="0.95rem" /> : label}
    </button>
  )
}

/**
 * Apply the armed modifiers to a keystroke on its way to the PTY.
 *
 * Ctrl maps a letter to its control code (a → 0x01), which is what a terminal
 * means by Ctrl; Alt prefixes ESC, the standard "meta" encoding. Anything the
 * mapping doesn't cover passes through untouched rather than being mangled.
 */
export function applyTerminalModifiers(data: string, modifiers: TerminalModifiers): string {
  let out = data

  if (modifiers.ctrl !== 'off' && out.length === 1) {
    const upper = out.toUpperCase()
    const code = upper.charCodeAt(0)

    if (code >= 64 && code <= 95) {
      // @ A–Z [ \ ] ^ _  →  0x00–0x1f
      out = String.fromCharCode(code - 64)
    } else if (out === '?') {
      out = '\u007f'
    }
  }

  if (modifiers.alt !== 'off') {
    out = `${ESC}${out}`
  }

  return out
}

/** off → armed → locked → off. */
export function nextModifierState(state: 'armed' | 'locked' | 'off'): 'armed' | 'locked' | 'off' {
  return state === 'off' ? 'armed' : state === 'armed' ? 'locked' : 'off'
}
