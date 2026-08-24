import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'

import { useSessionView } from '@/app/chat/session-view'
import { ModelMenuCloseContext } from '@/app/shell/model-menu-panel'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { GlyphSpinner } from '@/components/ui/glyph-spinner'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { ChevronDown } from '@/lib/icons'
import { formatModelStatusLabel } from '@/lib/model-status-label'
import { IS_MOBILE } from '@/lib/platform'
import { cn } from '@/lib/utils'
import { setModelMenuDropdownOpen, setModelPickerOpen } from '@/store/model'

import type { ChatBarState } from './types'

const PILL = cn(
  // `min-w-0` so the label's `truncate` can actually act if the controls row
  // does get tight — without it the pill is its content's width and pushes.
  //
  // And NOT `shrink-0`, which was defeating that: `min-w-0` only permits a flex
  // item to shrink, it does not make it shrinkable, so the pill kept its full
  // intrinsic width and shoved the dictation / wake / send buttons past the edge
  // of the composer the moment a model with a long name was selected. Shrinking
  // is what lets `truncate` clip the name instead.
  'h-(--composer-control-size) min-w-0 max-w-40 shrink gap-1 rounded-md px-2 text-xs font-normal',
  'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground'
)

/**
 * Composer model selector — the relocated status-bar pill. Reuses the live
 * `model.options` dropdown (`modelMenuContent`) verbatim; falls back to the
 * full picker when the gateway is closed and no live menu exists.
 *
 * Display follows THIS surface's SessionView (primary or tile), never the
 * primary-only globals — desktop parity. Reading `$currentModel` directly meant
 * a tile's (and a detached window's) pill LABELLED the primary chat's model
 * while every action on that surface targeted the tile's own session: the two
 * halves of one control disagreeing about which chat they mean.
 */
export function ModelPill({
  compact = false,
  disabled,
  model
}: {
  compact?: boolean
  disabled: boolean
  model: ChatBarState['model']
}) {
  const copy = useI18n().t.shell.statusbar
  const view = useSessionView()
  // Prefer the chat-bar snapshot (already view-scoped by ChatComposer); fall
  // back to the live SessionView atoms so a mid-flight session.info still
  // paints — including the PENDING model a mid-turn pick was queued as.
  const viewModel = useStore(view.$model)
  const viewProvider = useStore(view.$provider)
  const currentModel = model.model || viewModel
  const currentProvider = model.provider || viewProvider
  const fastMode = useStore(view.$fast)
  const reasoningEffort = useStore(view.$reasoningEffort)
  const [open, setOpen] = useState(false)
  const isHud = typeof document !== 'undefined' && document.documentElement.hasAttribute('data-hud')

  useEffect(() => {
    return () => {
      setModelMenuDropdownOpen(false)
    }
  }, [])

  // The model resolves a beat after the gateway/session comes up. Rather than
  // flash a literal "No model", show a quiet loader (inherits the pill text
  // color at half opacity) until a model lands.
  const label = compact ? (
    <ChevronDown className="size-3.5 shrink-0 opacity-70" />
  ) : (
    <>
      {currentModel.trim() ? (
        <span className="truncate">{formatModelStatusLabel(currentModel, { fastMode, reasoningEffort })}</span>
      ) : (
        <GlyphSpinner className="opacity-50" spinner="braille" />
      )}
      <ChevronDown className="size-2.5 shrink-0 opacity-50" />
    </>
  )

  // Compact (floating composer): a snug square holding just the chevron — no pill
  // padding, sized to match the other composer icon buttons.
  const pillClass = compact
    ? cn(
        'size-(--composer-control-size) shrink-0 justify-center gap-0 rounded-md p-0',
        'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground'
      )
    : PILL

  const title = currentProvider ? copy.modelTitle(currentProvider, currentModel || copy.modelNone) : copy.switchModel

  // Touch takes the drawer, not the dropdown. A menu anchored to a 48px pill on
  // a 390px screen is the thing this replaces: it opened off-edge, its rows were
  // sized by their text, and thinking depth hid behind a HOVER submenu a finger
  // cannot reach. Desktop and the HUD keep the dropdown, which works there.
  if (IS_MOBILE && model.modelDrawer) {
    return (
      <>
        <Button
          aria-label={title}
          className={pillClass}
          disabled={disabled}
          onClick={() => {
            setOpen(true)
            setModelMenuDropdownOpen(true)
          }}
          type="button"
          variant="ghost"
        >
          {label}
        </Button>
        {model.modelDrawer({
          onOpenChange: next => {
            setOpen(next)
            setModelMenuDropdownOpen(next)
          },
          open
        })}
      </>
    )
  }

  if (!model.modelMenuContent) {
    return (
      <Tip label={copy.openModelPicker} side="top">
        <Button
          aria-label={copy.openModelPicker}
          className={pillClass}
          disabled={disabled}
          onClick={() => setModelPickerOpen(true)}
          type="button"
          variant="ghost"
        >
          {label}
        </Button>
      </Tip>
    )
  }

  return (
    <DropdownMenu
      onOpenChange={isOpen => {
        setOpen(isOpen)
        setModelMenuDropdownOpen(isOpen)
      }}
      open={open}
    >
      <Tip label={title} side="top">
        <DropdownMenuTrigger asChild>
          <Button aria-label={title} className={pillClass} disabled={disabled} type="button" variant="ghost">
            {label}
          </Button>
        </DropdownMenuTrigger>
      </Tip>
      <DropdownMenuContent align="end" className="w-64 p-0" side={isHud ? 'bottom' : 'top'} sideOffset={8}>
        <ModelMenuCloseContext.Provider
          value={() => {
            setOpen(false)
            setModelMenuDropdownOpen(false)
          }}
        >
          {model.modelMenuContent}
        </ModelMenuCloseContext.Provider>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
