/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { I18nProvider } from '@/i18n'

// The overlay ladder, asserted end-to-end.
//
// MJXHRM-365 was a stacking-order bug — a dropdown at `z-50` opened inside a
// dialog at `z-[130]` rendered behind it — and nothing in the suite could see
// it, because no test had ever read a z-index. The two halves below close that:
//
//  1. RENDER: open each portaled surface for real and read the z utility class
//     off the DOM node the app actually ships, resolving it against the ladder
//     parsed out of styles.css. Radix portals every one of these to
//     document.body, so a rung is the ONLY thing ordering them — which is
//     exactly why the ordering has to be asserted rather than eyeballed.
//  2. SOURCE: the ladder's own comment says app-wide surfaces "must not compete
//     through ad-hoc z-index literals". A literal that happens to equal a rung
//     is the failure mode that produced this ticket (the rung existed; the
//     dropdown just didn't take it), so a literal spelling of any rung value is
//     a failure here.
//
// jsdom computes no layout and no paint order, so this cannot prove what a
// WebKitGTK window paints. It proves the invariant that decides it.

// The ladder lives in styles.css, and Vitest stubs EVERY css import to an empty
// string (`test.css` is off) — `?raw` included, because Vite classifies the
// request by extension before the query. So the stylesheet is read off disk;
// the `/// <reference types="node" />` above is what keeps the app's
// browser-only tsconfig happy about that. Source text stays on
// `import.meta.glob`, the pattern no-native-title.test.ts established.
const STYLESHEET = readFileSync(join(__dirname, '..', '..', 'styles.css'), 'utf8')

const SOURCES = import.meta.glob('/src/**/*.{ts,tsx}', {
  eager: true,
  import: 'default',
  query: '?raw'
}) as Record<string, string>

// The ladder itself, read from the stylesheet rather than restated here — a
// copy would drift and would stop the test from noticing a renumber.
const LADDER: Record<string, number> = (() => {
  const rungs: Record<string, number> = {}

  for (const [, name, value] of STYLESHEET.matchAll(/(--z-[a-z-]+):\s*(\d+);/g)) {
    rungs[name] = Number(value)
  }

  return rungs
})()

/**
 * The numeric z-index a rendered element resolves to. Handles all three
 * spellings the codebase can produce: `z-(--rung)`, `z-[140]`, `z-50`. Throws
 * on an unresolvable class rather than returning a default, so a surface that
 * quietly loses its z-index fails loudly instead of comparing as 0.
 */
function zOf(element: Element | null, what: string): number {
  expect(element, `${what}: not rendered`).not.toBeNull()

  for (const cls of (element as Element).className.split(/\s+/)) {
    const token = /^z-\((--[a-z-]+)\)$/.exec(cls)

    if (token) {
      const value = LADDER[token[1]]

      expect(value, `${what}: ${cls} names a rung styles.css does not define`).toBeTypeOf('number')

      return value
    }

    const literal = /^z-\[(\d+)\]$/.exec(cls) ?? /^z-(\d+)$/.exec(cls)

    if (literal) {
      return Number(literal[1])
    }
  }

  throw new Error(`${what}: no z-index utility on ${(element as Element).className}`)
}

const query = (slot: string) => document.querySelector(`[data-slot='${slot}']`)

afterEach(cleanup)

describe('overlay ladder — styles.css', () => {
  it('defines the rungs in the order their names claim', () => {
    // Anything reordered here silently re-layers the whole app, so pin the
    // relation rather than the numbers (values are meant to be re-spaceable).
    expect(LADDER['--z-modal-backdrop']).toBeLessThan(LADDER['--z-modal'])
    expect(LADDER['--z-modal']).toBeLessThan(LADDER['--z-modal-popover'])
    expect(LADDER['--z-modal-popover']).toBeLessThan(LADDER['--z-over-modal'])
    expect(LADDER['--z-over-modal']).toBeLessThan(LADDER['--z-over-modal-content'])
    expect(LADDER['--z-over-modal-content']).toBeLessThan(LADDER['--z-switcher-backdrop'])
    expect(LADDER['--z-switcher-backdrop']).toBeLessThan(LADDER['--z-switcher'])
    expect(LADDER['--z-switcher']).toBeLessThan(LADDER['--z-crash'])
  })
})

describe('overlay ladder — rendered surfaces', () => {
  it('puts the dialog above its own backdrop', () => {
    render(
      <I18nProvider>
        <Dialog open>
          <DialogContent>body</DialogContent>
        </Dialog>
      </I18nProvider>
    )

    expect(zOf(query('dialog-content'), 'dialog content')).toBeGreaterThan(
      zOf(query('dialog-overlay'), 'dialog overlay')
    )
  })

  it.each([
    [
      'dropdown menu',
      'dropdown-menu-content',
      <DropdownMenu key="d" open>
        <DropdownMenuTrigger>open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>item</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    ],
    [
      'dropdown submenu',
      'dropdown-menu-sub-content',
      <DropdownMenu key="s" open>
        <DropdownMenuTrigger>open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuSub open>
            <DropdownMenuSubTrigger>more</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem>item</DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>
    ],
    [
      'popover',
      'popover-content',
      <Popover key="p" open>
        <PopoverTrigger>open</PopoverTrigger>
        <PopoverContent>body</PopoverContent>
      </Popover>
    ],
    [
      'select',
      'select-content',
      <Select key="l" open>
        <SelectTrigger>
          <SelectValue placeholder="pick" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="a">a</SelectItem>
        </SelectContent>
      </Select>
    ]
  ])('stacks the %s above a dialog', (what, slot, tree) => {
    render(
      <I18nProvider>
        <Dialog open>
          <DialogContent>{tree}</DialogContent>
        </Dialog>
      </I18nProvider>
    )

    // Both are portaled to document.body, so the dialog is what the menu
    // competes with — not the trigger it visually belongs to. This is the
    // assertion MJXHRM-365 was: `z-50` here loses to the dialog's rung.
    expect(zOf(query(slot), what)).toBeGreaterThan(zOf(query('dialog-content'), 'dialog content'))
  })

  it('stacks the context menu above a dialog', () => {
    const { getByText } = render(
      <I18nProvider>
        <Dialog open>
          <DialogContent>
            <ContextMenu>
              <ContextMenuTrigger>right-click me</ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuItem>item</ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          </DialogContent>
        </Dialog>
      </I18nProvider>
    )

    fireEvent.contextMenu(getByText('right-click me'), { clientX: 4, clientY: 4 })

    expect(zOf(query('context-menu-content'), 'context menu')).toBeGreaterThan(
      zOf(query('dialog-content'), 'dialog content')
    )
  })

  it('keeps the tooltip above an open menu', () => {
    // The one ordering the MJXHRM-365 fix could plausibly have inverted: the
    // menu moved up a rung, and a tip must still be readable over it.
    render(
      <>
        <DropdownMenu open>
          <DropdownMenuTrigger>open</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem>item</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <TooltipProvider>
          <Tooltip open>
            <TooltipTrigger>hover</TooltipTrigger>
            <TooltipContent>tip</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </>
    )

    expect(zOf(query('tooltip-content'), 'tooltip')).toBeGreaterThan(
      zOf(query('dropdown-menu-content'), 'dropdown menu')
    )
  })
})

describe('overlay ladder — no ad-hoc literals', () => {
  it('spells every rung value as its token', () => {
    const rungValues = new Map(Object.entries(LADDER).map(([name, value]) => [value, name]))
    const offenders: string[] = []

    for (const [path, source] of Object.entries(SOURCES)) {
      if (/\.test\.tsx?$/.test(path)) {
        continue
      }

      for (const [, value] of source.matchAll(/\bz-\[(\d+)\]/g)) {
        const rung = rungValues.get(Number(value))

        if (rung) {
          offenders.push(`${path}: z-[${value}] — use z-(${rung})`)
        }
      }
    }

    expect(offenders).toEqual([])
  })
})
