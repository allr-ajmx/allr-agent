import type { Unstable_TriggerItem } from '@assistant-ui/core'
import { Fragment, useLayoutEffect, useRef } from 'react'

import { referenceKind, referenceStyle } from '@/components/assistant-ui/reference-kinds'
import { Codicon } from '@/components/ui/codicon'
import { GlyphSpinner } from '@/components/ui/glyph-spinner'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'

import { COMPLETION_DRAWER_BELOW_CLASS, COMPLETION_DRAWER_CLASS, CompletionDrawerEmpty } from './completion-drawer'
import type { DirectiveScope } from './text-utils'

interface RowMeta {
  display?: string
  group?: string
  meta?: string
}

/** The kind a row represents, for its icon. `@` rows carry it as the item type;
 *  `/` rows carry it as the completion group (Skills / Themes / Commands). */
function rowKind(item: Unstable_TriggerItem, isSlash: boolean): string {
  const meta = item.metadata as (RowMeta & { rawText?: string }) | undefined

  if (isSlash) {
    const group = meta?.group?.trim()

    return group === 'Skills' ? 'skill' : group === 'Themes' ? 'theme' : 'command'
  }

  // The gateway's simple refs (`@diff`, `@staged`) share one item type, so the
  // glyph comes from the directive itself.
  const raw = meta?.rawText || item.label

  if (raw.startsWith('@diff')) {
    return 'diff'
  }

  if (raw.startsWith('@staged')) {
    return 'staged'
  }

  return item.type
}

const ROW_CLASS = [
  'relative flex w-full cursor-default select-none items-center gap-2 rounded-md px-2 py-1 text-left',
  'outline-hidden transition-colors hover:bg-(--ui-bg-tertiary)',
  'data-[highlighted]:bg-(--ui-bg-tertiary) data-[highlighted]:text-foreground'
].join(' ')

const GROUP_HEADER_CLASS =
  'select-none px-2 pb-0.5 text-[0.625rem] font-semibold uppercase tracking-wider text-(--ui-text-tertiary)'

/**
 * Where the scrollport has to sit for the active row to be inside it.
 *
 * The drawer caps at 22rem — about twelve rows — and a bare `/` lists every
 * command, every skill and every theme, while `@` lists whatever the workspace
 * has. Arrowing past the twelfth row moved the highlight out of sight and left
 * the list motionless, so a keyboard user was navigating a menu they could no
 * longer see. The mouse never hit this (hovering a row means it is on screen),
 * which is why it survived the row unification unnoticed.
 *
 * Numbers in, number out — no DOM, so it unit-tests without layout, and the
 * caller writes `scrollTop` only when this returns something new (a no-op write
 * still cancels a smooth scroll in WebKit).
 */
export function nearestScrollTop(view: { height: number; scrollTop: number }, row: { height: number; top: number }) {
  if (row.top < view.scrollTop) {
    return row.top
  }

  const overshoot = row.top + row.height - (view.scrollTop + view.height)

  // A row taller than the scrollport must align to its TOP, not its bottom, or
  // its label scrolls off the top edge to reveal empty padding.
  return overshoot > 0 ? (row.height > view.height ? row.top : view.scrollTop + overshoot) : view.scrollTop
}

interface ComposerTriggerPopoverProps {
  activeIndex: number
  items: readonly Unstable_TriggerItem[]
  kind: ':' | '@' | '/'
  loading: boolean
  onHover: (index: number) => void
  onPick: (item: Unstable_TriggerItem) => void
  placement?: 'bottom' | 'top'
  /** The `@kind:` browse the list is filtered to, when there is one. Rendered
   *  as a header so the scope reads as the mode it is — the raw `@folder:` in
   *  the editor otherwise looks like syntax the user has to maintain. */
  scope?: DirectiveScope
}

/**
 * The composer's completion list, for every trigger.
 *
 * `@` and `/` render through the SAME row: icon, name, description. They used
 * to be two layouts in one file — `@` horizontal with an icon, `/` stacked with
 * none — which is why picking a file and picking a skill felt like features
 * from different apps. Icons and accents come from the shared reference
 * vocabulary (`reference-kinds`), so a row looks like the chip it will become;
 * the local `AT_ICON_BY_TYPE` this replaced had already drifted from it (it drew
 * a file as `book`, the chip as `file`).
 *
 * `:` emoji is the one exception: the emoji IS the icon, so it renders as a
 * single display string. The old `@` branch drew it a `symbol-misc` glyph
 * beside the emoji, because `AT_ICON_BY_TYPE` had no emoji entry to find.
 *
 * The list following the keyboard's highlight into view is deliberately NOT
 * desktop's (see MJXHRM-400) — the row unification covered how a row LOOKS on
 * both apps and never covered reaching one.
 */
export function ComposerTriggerPopover({
  activeIndex,
  items,
  kind,
  loading,
  onHover,
  onPick,
  placement = 'top',
  scope
}: ComposerTriggerPopoverProps) {
  const { t } = useI18n()
  const copy = t.composer
  const isSlash = kind === '/'
  const isEmoji = kind === ':'
  const listRef = useRef<HTMLDivElement | null>(null)
  const activeRowRef = useRef<HTMLButtonElement | null>(null)

  // Follow the keyboard. Layout effect, not an effect: the scroll must land in
  // the same frame the highlight moves, or the row visibly jumps.
  useLayoutEffect(() => {
    const list = listRef.current
    const row = activeRowRef.current

    if (!list || !row) {
      return
    }

    const next = nearestScrollTop(
      { height: list.clientHeight, scrollTop: list.scrollTop },
      { height: row.offsetHeight, top: row.offsetTop }
    )

    if (next !== list.scrollTop) {
      list.scrollTop = next
    }
  }, [activeIndex, items])

  let lastGroup: string | undefined

  return (
    <div
      className={placement === 'bottom' ? COMPLETION_DRAWER_BELOW_CLASS : COMPLETION_DRAWER_CLASS}
      data-slot="composer-completion-drawer"
      data-state="open"
      onMouseDown={event => event.preventDefault()}
      ref={listRef}
      role="listbox"
    >
      {scope && <div className={cn(GROUP_HEADER_CLASS, 'pt-0.5')}>{referenceStyle(scope).label}</div>}
      {items.length === 0 ? (
        loading ? (
          <div className="flex items-center gap-2 px-2 py-1.5 text-(--ui-text-tertiary)">
            <GlyphSpinner ariaLabel={copy.lookupLoading} className="text-foreground/70" spinner="braille" />
            <span>{copy.lookupLoading}</span>
          </div>
        ) : (
          <CompletionDrawerEmpty title={copy.lookupNoMatches}>
            {kind === '@' ? (
              <>
                {copy.lookupTry} <span className="font-mono text-foreground/80">@file:</span> {copy.lookupOr}{' '}
                <span className="font-mono text-foreground/80">@folder:</span>.
              </>
            ) : isEmoji ? (
              <>
                {copy.lookupTry} <span className="font-mono text-foreground/80">:joy:</span>.
              </>
            ) : (
              <>
                {copy.lookupTry} <span className="font-mono text-foreground/80">/help</span>.
              </>
            )}
          </CompletionDrawerEmpty>
        )
      ) : (
        items.map((item, index) => {
          const meta = item.metadata as RowMeta | undefined
          const display = meta?.display ?? (isSlash ? `/${item.label}` : item.label)
          const description = meta?.meta || item.description
          const group = meta?.group?.trim()
          const showHeader = isSlash && Boolean(group) && group !== lastGroup
          const isFirstHeader = lastGroup === undefined
          lastGroup = group || lastGroup
          const active = index === activeIndex
          const refKind = referenceKind(rowKind(item, isSlash))

          return (
            <Fragment key={item.id}>
              {showHeader && <div className={cn(GROUP_HEADER_CLASS, isFirstHeader ? 'pt-0.5' : 'pt-2')}>{group}</div>}
              <button
                className={ROW_CLASS}
                data-highlighted={active ? '' : undefined}
                onClick={() => onPick(item)}
                onMouseEnter={() => onHover(index)}
                ref={active ? activeRowRef : undefined}
                type="button"
              >
                {isEmoji ? (
                  // The emoji is its own icon — a glyph column beside it reads
                  // as decoration.
                  <span className="min-w-0 shrink truncate leading-5 text-foreground">{display}</span>
                ) : (
                  <>
                    <span className="grid size-4 shrink-0 place-items-center text-(--ref-color)" data-ref={refKind}>
                      <Codicon name={referenceStyle(refKind).codicon} size="0.875rem" />
                    </span>
                    <span className="min-w-0 shrink truncate font-medium leading-5 text-foreground">{display}</span>
                    {description && (
                      <span className="min-w-0 flex-1 truncate leading-5 text-(--ui-text-tertiary)">{description}</span>
                    )}
                  </>
                )}
              </button>
            </Fragment>
          )
        })
      )}
    </div>
  )
}
