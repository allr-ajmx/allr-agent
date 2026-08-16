/**
 * Chrome contribution surfaces — the bridge between the registry and universal's
 * statusbar / titlebar. Desktop splits this across app/contrib/panes.tsx (the
 * statusbar collector) and app/contrib/surfaces.tsx (the wiring that feeds it);
 * universal has no `WiringActions` layer, so one small module covers both.
 *
 * The AREA CONSTANTS live here rather than in `sdk/index.ts` so core shell files
 * (statusbar.tsx, titlebar.tsx, mobile-top-bar.tsx) never import from `@/sdk` —
 * the SDK re-exports them, not the other way round.
 *
 * Universal delta vs desktop: there is no `TitlebarTool` descriptor area
 * (`titleBar.tools.*`). Universal's titlebar is composed of `TitlebarButton` JSX
 * rather than descriptors, so `titleBar.*` is mounted as a plain `Slot` and
 * contributions use `render()`. Same mechanism on desktop chrome and on the
 * mobile top bar.
 */

import { useMemo } from 'react'

import { ContribBoundary, ContribRender } from '@/contrib/react/boundary'
import { useContributions } from '@/contrib/react/use-contributions'

import type { StatusbarItem, StatusbarItemSide } from '../shell/statusbar-controls'

export const STATUSBAR_AREAS = {
  left: 'statusBar.left',
  right: 'statusBar.right'
} as const

export const TITLEBAR_AREAS = {
  center: 'titleBar.center',
  left: 'titleBar.left',
  right: 'titleBar.right'
} as const

/** Collect statusbar contributions for one side. A `render()` contribution
 *  becomes a render-item (arbitrary stateful node); otherwise the declarative
 *  `data` payload is the StatusbarItem.
 *
 *  MEMOIZED on the registry snapshot (MJXHRM-303). `useContributions` already
 *  hands back a reference-stable array — `registry.getArea` caches per area and
 *  `EMPTY` covers the empty case — but mapping it inline minted a fresh array
 *  (and a fresh render-item, with a fresh `render` closure) on EVERY render of
 *  the caller. Both callers pass the result straight into `useStatusbarItems` as
 *  `extraLeftItems`/`extraRightItems`, so that hook's returned arrays were
 *  re-minted unconditionally — with zero plugins installed as much as with one —
 *  and every contributed chip missed `StatusbarItemView`'s memo on every one of
 *  the ~20 stores the bar subscribes to. */
export function useStatusbarContributions(side: StatusbarItemSide): readonly StatusbarItem[] {
  const items = useContributions(STATUSBAR_AREAS[side])

  return useMemo(
    () =>
      items
        .map(c =>
          c.render
            ? ({
                id: c.id,
                render: () => (
                  <ContribBoundary id={c.id} variant="chip">
                    <ContribRender render={c.render} />
                  </ContribBoundary>
                )
              } satisfies StatusbarItem)
            : (c.data as StatusbarItem)
        )
        .filter(Boolean),
    [items]
  )
}
