/**
 * Hover actions for directive chips in a composer.
 *
 * A directive chip (`@url:`, `@session:`, …) reads as the thing it points at
 * and is coloured like one, but a composer is an editor — a click inside the
 * contenteditable only places the caret, so there's no way to *act* on the
 * reference. Instead, hovering a chip whose kind has an action floats a small
 * pill above it that runs it.
 *
 * The kind → action table lives HERE rather than beside the transcript chip,
 * which is where desktop keeps it. Desktop's `DIRECTIVE_ACTIONS` feeds two
 * surfaces; universal's transcript chips (`components/assistant-ui/
 * directive-content.tsx`) already own their own click behaviour directly, so a
 * shared table would have exactly one consumer and would drag `open-session`
 * and `external-link` into `directive-text.ts` — a module the composer's rich
 * editor imports on its hot path.
 */
import { type RefObject, useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { openSessionRef } from '@/app/open-session'
import { composerFloatingPill } from '@/components/chat/composer-dock'
import { Codicon } from '@/components/ui/codicon'
import { type I18nContextValue, useI18n } from '@/i18n'
import { openExternalLink } from '@/lib/external-link'
import { parseSessionRefValue } from '@/lib/session-refs'
import { cn } from '@/lib/utils'

/** Moving between the chip and the pill crosses a gap where neither is hovered.
 *  Short enough that it still reads as instant on the way out. */
const HIDE_DELAY_MS = 120

/** What activating a directive of a given kind does. A kind with no entry is
 *  inert — no pill appears over it at all. */
interface DirectiveAction {
  icon: string
  label: (t: I18nContextValue['t']) => string
  run: (value: string) => void
}

const DIRECTIVE_ACTIONS: Record<string, DirectiveAction> = {
  session: {
    icon: 'link-external',
    label: t => t.composer.openDirective,
    // `tab`, not `in-place`: opening the referenced session must not steal the
    // main pane out from under the chat whose composer you are typing into.
    run: value => openSessionRef(parseSessionRefValue(value).sessionId, 'tab')
  },
  url: {
    icon: 'link-external',
    label: t => t.composer.openDirective,
    run: value => void openExternalLink(value)
  }
}

/** The actionable directive chip under `target` that also belongs to `editor`,
 *  if there is one. */
function actionableChipAt(target: EventTarget | null, editor: HTMLElement): HTMLElement | null {
  const chip = target instanceof Element ? target.closest<HTMLElement>('[data-ref-kind]') : null
  const kind = chip?.dataset.refKind

  return chip && kind && chip.dataset.refId && editor.contains(chip) && DIRECTIVE_ACTIONS[kind] ? chip : null
}

interface Anchor {
  action: DirectiveAction
  chip: HTMLElement
  left: number
  top: number
  value: string
}

function anchorFor(chip: HTMLElement): Anchor | null {
  const value = chip.dataset.refId
  const action = chip.dataset.refKind ? DIRECTIVE_ACTIONS[chip.dataset.refKind] : undefined

  if (!value || !action || !chip.isConnected) {
    return null
  }

  const rect = chip.getBoundingClientRect()

  return { action, chip, left: rect.left, top: rect.top, value }
}

/**
 * Renders the action pill for whichever actionable chip in `editorRef` is
 * hovered.
 *
 * Listeners bind to `document`, not the editor, so mount timing can't strand
 * them: the edit composer's contenteditable isn't reliably attached when this
 * effect first runs, and a document listener that reads the editor lazily works
 * regardless. Each instance filters to its own editor, so the docked and edit
 * composers never show two pills for one chip.
 */
export function ComposerDirectiveActions({ editorRef }: { editorRef: RefObject<HTMLElement | null> }) {
  const { t } = useI18n()
  const [anchor, setAnchor] = useState<Anchor | null>(null)
  const hideTimerRef = useRef<number | undefined>(undefined)
  const pillRef = useRef<HTMLDivElement | null>(null)

  const cancelHide = useCallback(() => {
    window.clearTimeout(hideTimerRef.current)
  }, [])

  const hideSoon = useCallback(() => {
    cancelHide()
    hideTimerRef.current = window.setTimeout(() => setAnchor(null), HIDE_DELAY_MS)
  }, [cancelHide])

  const hideNow = useCallback(() => {
    cancelHide()
    setAnchor(null)
  }, [cancelHide])

  /** The pill is a second hover surface, not a bystander — these listeners are
   *  on `document`, so they see its internals too. */
  const insidePill = useCallback(
    (node: EventTarget | null) => node instanceof Node && !!pillRef.current?.contains(node),
    []
  )

  useEffect(() => {
    const onPointerOver = (event: PointerEvent) => {
      // Arriving on the pill (or crossing between its own children) cancels the
      // hide that leaving the chip queued. Without this the wrapper's
      // `mouseenter` is the only cancel, and that fires exactly once — on the
      // way in — so the very next boundary inside the pill dismissed it.
      if (insidePill(event.target)) {
        cancelHide()

        return
      }

      const editor = editorRef.current
      const chip = editor && actionableChipAt(event.target, editor)

      if (!chip) {
        return
      }

      cancelHide()
      setAnchor(current => (current?.chip === chip ? current : anchorFor(chip)))
    }

    const onPointerOut = (event: PointerEvent) => {
      // `pointerout` fires at every element boundary, the pill's own included
      // (wrapper → button, icon → label). Only a move that actually leaves it
      // counts.
      if (insidePill(event.target)) {
        if (!insidePill(event.relatedTarget)) {
          hideSoon()
        }

        return
      }

      const editor = editorRef.current
      const chip = editor && actionableChipAt(event.target, editor)

      // A move within the same chip (its icon → its label) is not a leave.
      if (chip && editor && chip === actionableChipAt(event.relatedTarget, editor)) {
        return
      }

      // A finger does not hover: on touch these events bracket the TAP, so this
      // is the finger lifting off the chip it just revealed the pill over.
      // Hiding here would take the pill away 120ms later, every time, and the
      // action would be unreachable on a phone. A touch-opened pill stays until
      // it is used or something else is pressed (below).
      if (event.pointerType === 'touch') {
        return
      }

      hideSoon()
    }

    // Press anywhere that is neither the pill nor an actionable chip and the
    // pill is done — the dismissal a touch-opened pill has instead of a hover
    // ending, and the one that clears a stale pill a mouse left behind.
    const onPointerDown = (event: PointerEvent) => {
      const editor = editorRef.current

      if (insidePill(event.target) || (editor && actionableChipAt(event.target, editor))) {
        return
      }

      hideNow()
    }

    // The chip can move or vanish under a parked pointer: the editor scrolls,
    // the window resizes, or the user deletes the reference the pill points at.
    const reanchor = () => setAnchor(current => (current ? anchorFor(current.chip) : null))

    document.addEventListener('pointerover', onPointerOver)
    document.addEventListener('pointerout', onPointerOut)
    document.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('scroll', reanchor, true)
    window.addEventListener('resize', reanchor)

    return () => {
      document.removeEventListener('pointerover', onPointerOver)
      document.removeEventListener('pointerout', onPointerOut)
      document.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('scroll', reanchor, true)
      window.removeEventListener('resize', reanchor)
      window.clearTimeout(hideTimerRef.current)
    }
  }, [cancelHide, editorRef, hideNow, hideSoon, insidePill])

  if (!anchor) {
    return null
  }

  return createPortal(
    <div
      className="fixed z-(--z-over-modal) -translate-y-full pb-1"
      data-slot="composer-directive-action"
      data-value={anchor.value}
      ref={pillRef}
      style={{ left: anchor.left, top: anchor.top }}
    >
      <button
        className={cn(composerFloatingPill, 'shadow-nous')}
        onClick={() => {
          anchor.action.run(anchor.value)
          setAnchor(null)
        }}
        // Never let the press reach the editor: mousedown inside a
        // contenteditable moves the caret and can collapse a selection the user
        // still wants, and the edit composer treats a blur as "cancel".
        onMouseDown={event => event.preventDefault()}
        type="button"
      >
        <Codicon className="shrink-0 opacity-70" name={anchor.action.icon} size="0.75rem" />
        {anchor.action.label(t)}
      </button>
    </div>,
    document.body
  )
}
