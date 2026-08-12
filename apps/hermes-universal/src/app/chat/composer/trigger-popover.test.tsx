import type { Unstable_TriggerItem } from '@assistant-ui/core'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ComposerTriggerPopover, nearestScrollTop } from './trigger-popover'

/**
 * The composer's completion list — the ONE row `@`, `/` and `:` all render
 * through since MJXHRM-400 folded two layouts into one.
 *
 * Universal shipped that unification with no test at all: upstream's own
 * `trigger-popover-parity.test.tsx` was part of the very commit being ported
 * (`d83d296473`) and did not come across, so every claim the unification makes
 * — one row shape, one icon vocabulary, an icon-less emoji row — was
 * unguarded. These are those guards, plus the keyboard
 * reachability the unification never covered on either app.
 */

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: {
      composer: {
        lookupLoading: 'Loading…',
        lookupNoMatches: 'No matches',
        lookupOr: 'or',
        lookupTry: 'Try'
      }
    }
  })
}))

function atItem(type: string, display: string, rawText: string, meta = ''): Unstable_TriggerItem {
  return {
    id: `${rawText}|0`,
    label: display,
    metadata: { display, icon: type, insertId: display, meta, rawText },
    type
  }
}

function slashItem(command: string, group: string, meta = ''): Unstable_TriggerItem {
  return {
    id: `${command}|0`,
    label: command.slice(1),
    metadata: { action: '', command, display: command, group, meta, rawText: command },
    type: 'slash'
  }
}

const noop = () => {}

/** The rendered shape of one row: does it have an icon, and how is it laid out?
 *  Icons are codicons — an `<i class="codicon codicon-<name>">`, not an SVG. */
function rowShape(root: HTMLElement) {
  const row = root.querySelector('button') as HTMLElement
  const icon = row.querySelector('i.codicon')

  return {
    classes: row.className,
    hasIcon: Boolean(icon),
    iconName: icon?.className.match(/codicon-([\w-]+)/)?.[1]
  }
}

function renderPopover(
  kind: ':' | '@' | '/',
  items: Unstable_TriggerItem[],
  extra: { activeIndex?: number; loading?: boolean; onHover?: () => void; onPick?: () => void } = {}
) {
  return render(
    <ComposerTriggerPopover
      activeIndex={extra.activeIndex ?? 0}
      items={items}
      kind={kind}
      loading={extra.loading ?? false}
      onHover={extra.onHover ?? noop}
      onPick={extra.onPick ?? noop}
    />
  )
}

afterEach(cleanup)

describe('@ and / are one row', () => {
  it('a slash row has an icon, and the same row box as an @ row', () => {
    const at = renderPopover('@', [atItem('folder', 'apps/hermes-universal/', '@folder:apps/hermes-universal/', 'dir')])
    const atShape = rowShape(at.container)

    at.unmount()

    const slash = renderPopover('/', [slashItem('/work', 'Skills', 'Start in a worktree')])
    const slashShape = rowShape(slash.container)

    // The whole point: `/` used to render a stacked, icon-less row.
    expect(slashShape.hasIcon).toBe(true)
    expect(atShape.hasIcon).toBe(true)
    expect(slashShape.classes).toBe(atShape.classes)

    // And the glyph reflects the kind, not one generic bullet.
    expect(slashShape.iconName).toBe('zap')
    expect(atShape.iconName).toBe('folder')
  })

  it('draws a file with the same glyph its chip will use', () => {
    // The local `AT_ICON_BY_TYPE` this replaced said `book` here while the chip
    // said `file`, so a row and the thing it turned into disagreed on sight.
    const { container } = renderPopover('@', [atItem('file', 'src/main.tsx', '@file:src/main.tsx', 'src')])

    expect(rowShape(container).iconName).toBe('file')
  })

  it('keys the slash glyph on the completion group', () => {
    for (const [group, icon] of [
      ['Skills', 'zap'],
      ['Themes', 'symbol-color'],
      ['Commands', 'terminal'],
      // An unknown group is a command, not a blank column.
      ['Something else', 'terminal']
    ] as const) {
      const { container, unmount } = renderPopover('/', [slashItem('/x', group)])

      expect(rowShape(container).iconName).toBe(icon)
      unmount()
    }
  })

  it('gives the gateway simple refs their own glyphs despite one shared type', () => {
    const diff = renderPopover('@', [atItem('other', '@diff', '@diff')])

    expect(rowShape(diff.container).iconName).toBe('diff')
    diff.unmount()

    const staged = renderPopover('@', [atItem('other', '@staged', '@staged')])

    expect(rowShape(staged.container).iconName).toBe('diff-added')
  })

  it('renders the name and the description for both kinds', () => {
    const slash = renderPopover('/', [slashItem('/work', 'Skills', 'Start in a worktree')])

    expect(screen.getByText('/work')).toBeTruthy()
    expect(screen.getByText('Start in a worktree')).toBeTruthy()
    slash.unmount()

    renderPopover('@', [atItem('file', 'src/main.tsx', '@file:src/main.tsx', 'src')])

    expect(screen.getByText('src/main.tsx')).toBeTruthy()
    expect(screen.getByText('src')).toBeTruthy()
  })

  it('an emoji row stays icon-less — the emoji IS the icon', () => {
    const { container } = renderPopover(':', [
      { id: ':joy:|0', label: '😂  :joy:', metadata: { display: '😂  :joy:' }, type: 'emoji' }
    ])

    expect(rowShape(container).hasIcon).toBe(false)
    expect(container.querySelector('button')?.textContent).toBe('😂  :joy:')
  })

  it('labels the active browse scope from the shared vocabulary', () => {
    render(
      <ComposerTriggerPopover
        activeIndex={0}
        items={[atItem('folder', 'apps/', '@folder:apps/', 'dir')]}
        kind="@"
        loading={false}
        onHover={noop}
        onPick={noop}
        scope="folder"
      />
    )

    expect(screen.getByText('Folders')).toBeTruthy()
  })

  it('breaks the slash list on the group, once per group', () => {
    const { container } = renderPopover('/', [
      slashItem('/work', 'Skills'),
      slashItem('/plan', 'Skills'),
      slashItem('/dark', 'Themes')
    ])

    const headers = [...container.querySelectorAll('div')]
      .filter(el => el.className.includes('uppercase'))
      .map(el => el.textContent)

    expect(headers).toEqual(['Skills', 'Themes'])
  })
})

describe('reachability', () => {
  it('picks on click and highlights on hover', () => {
    const onHover = vi.fn()
    const onPick = vi.fn()
    const items = [slashItem('/work', 'Skills'), slashItem('/plan', 'Skills')]
    const { container } = renderPopover('/', items, { onHover, onPick })
    const rows = container.querySelectorAll('button')

    fireEvent.mouseEnter(rows[1])
    expect(onHover).toHaveBeenCalledWith(1)

    fireEvent.click(rows[1])
    expect(onPick).toHaveBeenCalledWith(items[1])
  })

  it('keeps the composer focused when a row is pressed', () => {
    // The drawer swallows mousedown so the contenteditable never blurs — losing
    // focus mid-completion closes the popover before the click resolves.
    const { container } = renderPopover('/', [slashItem('/work', 'Skills')])
    const drawer = container.querySelector('[data-slot="composer-completion-drawer"]') as HTMLElement

    expect(fireEvent.mouseDown(drawer)).toBe(false)
  })

  it('scrolls the active row into view when the keyboard walks past the fold', () => {
    const items = Array.from({ length: 40 }, (_, i) => slashItem(`/cmd${i}`, 'Commands'))
    const rendered = renderPopover('/', items)
    const drawer = rendered.container.querySelector('[data-slot="composer-completion-drawer"]') as HTMLElement

    // jsdom has no layout: give the drawer a 100px scrollport and every row a
    // 20px box, so row N sits at 20 * N.
    Object.defineProperty(drawer, 'clientHeight', { configurable: true, value: 100 })

    for (const [index, row] of [...rendered.container.querySelectorAll('button')].entries()) {
      Object.defineProperty(row, 'offsetHeight', { configurable: true, value: 20 })
      Object.defineProperty(row, 'offsetTop', { configurable: true, value: index * 20 })
    }

    // Row 4 ends exactly at the fold — still nothing to do.
    rendered.rerender(
      <ComposerTriggerPopover activeIndex={4} items={items} kind="/" loading={false} onHover={noop} onPick={noop} />
    )
    expect(drawer.scrollTop).toBe(0)

    // Row 7 is past it: scroll the minimum that brings its bottom edge in.
    rendered.rerender(
      <ComposerTriggerPopover activeIndex={7} items={items} kind="/" loading={false} onHover={noop} onPick={noop} />
    )
    expect(drawer.scrollTop).toBe(60)

    // ArrowUp back to the top scrolls the other way.
    rendered.rerender(
      <ComposerTriggerPopover activeIndex={0} items={items} kind="/" loading={false} onHover={noop} onPick={noop} />
    )
    expect(drawer.scrollTop).toBe(0)
  })
})

describe('nearestScrollTop', () => {
  const view = { height: 100, scrollTop: 40 }

  it('leaves a row already inside the scrollport alone', () => {
    expect(nearestScrollTop(view, { height: 20, top: 60 })).toBe(40)
  })

  it('aligns a row above the scrollport to its top', () => {
    expect(nearestScrollTop(view, { height: 20, top: 10 })).toBe(10)
  })

  it('scrolls the minimum for a row below the scrollport', () => {
    expect(nearestScrollTop(view, { height: 20, top: 150 })).toBe(70)
  })

  it('aligns a row taller than the scrollport to its top, so its label stays visible', () => {
    expect(nearestScrollTop(view, { height: 180, top: 150 })).toBe(150)
  })
})

describe('empty and loading states', () => {
  it('hints at the browse scopes when @ finds nothing', () => {
    const { container } = renderPopover('@', [])

    expect(screen.getByText('No matches')).toBeTruthy()
    expect(container.textContent).toContain('@file:')
    expect(container.textContent).toContain('@folder:')
  })

  it('hints at /help when a slash lookup finds nothing', () => {
    const { container } = renderPopover('/', [])

    expect(container.textContent).toContain('/help')
  })

  it('hints at a shortcode when an emoji lookup finds nothing', () => {
    const { container } = renderPopover(':', [])

    expect(container.textContent).toContain(':joy:')
  })

  it('shows only the spinner while the lookup is in flight', () => {
    const { container } = renderPopover('/', [], { loading: true })

    expect(screen.getByText('Loading…')).toBeTruthy()
    // The `/help` hint belongs to the resolved empty state, not to loading.
    expect(container.textContent).not.toContain('/help')
  })
})
