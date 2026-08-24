import type { Decorator } from '@storybook/react-vite'
import { type ReactNode, useLayoutEffect } from 'react'

import { __setPlatform, type PlatformKind } from './mocks/platform'

/**
 * The three composer environments.
 *
 * There is only ONE composer component. Desktop, mobile and HUD are the same
 * `ChatBar` under different global state — a class on `<html>`, an attribute on
 * `<html>`, a JS device flag, and (for the HUD) a wrapper the stylesheet selects
 * on. `app/hud/hud-window.tsx` is explicit that this is deliberate: "Nothing
 * here swaps in a lighter version … A second composer would be a second set of
 * bugs." These decorators reproduce the environment, never the component.
 */

interface ShellProps {
  children: ReactNode
  /** HUD band state — drives the collapse-at-rest / reveal-on-focus behaviour. */
  bandState?: 'collapsed' | 'open'
  engaged?: boolean
  hud?: boolean
  platform: PlatformKind
  /** Height of the fake app window the composer docks into. */
  viewport: string
}

function EnvironmentShell({ bandState = 'open', children, engaged, hud, platform, viewport }: ShellProps) {
  // Set during RENDER, not in an effect. `IS_MOBILE` is read while the composer
  // renders, and an effect runs after its children have already mounted — by
  // which point a mobile story would have drawn its desktop self once and the
  // hook-order branch in `use-composer-drop.ts` would have been decided wrong.
  // Idempotent, so StrictMode's double render is harmless.
  __setPlatform(platform)

  // The class and attribute are CSS-only, so a layout effect (before paint) is
  // soon enough — and it gives us an unmount hook, which matters: leaking
  // `data-hud` into the next story would restyle a composer that is not the HUD.
  useLayoutEffect(() => {
    const root = document.documentElement

    root.classList.toggle('is-mobile', platform !== 'desktop')

    if (hud) {
      root.setAttribute('data-hud', '')
    }

    return () => {
      root.classList.remove('is-mobile')
      root.removeAttribute('data-hud')
    }
  }, [hud, platform])

  // `.chat` is the app's own container (styles.css) and the composer is
  // positioned against it — `absolute bottom-0` when docked. It is
  // `flex: 1 1 auto; min-height: 0`, so it needs a flex-column parent with a
  // real height or the composer docks to nothing. The filler div stands in for
  // <Thread />.
  const composer = (
    <div className="flex flex-col" style={{ height: viewport }}>
      <div className="chat">
        <div className="flex-1" />
        {children}
      </div>
    </div>
  )

  if (!hud) {
    return composer
  }

  // Copied from hud-window.tsx. The `html[data-hud]` block in styles.css selects
  // on these exact hooks, so without them the HUD story would render a normal
  // docked composer on a transparent background and look like it worked.
  return (
    <div
      className="flex h-full w-full flex-col bg-transparent"
      data-hud-engaged={engaged ? '' : undefined}
      data-hud-root
    >
      <div
        className="group/hud relative flex h-full min-h-0 w-full flex-col bg-transparent"
        data-hud-band-state={bandState}
        data-hud-card
        style={{ '--hud-band-max': '420px' } as React.CSSProperties}
      >
        {composer}
      </div>
    </div>
  )
}

/**
 * `key` on the shell, derived from the environment, so switching stories
 * UNMOUNTS rather than re-renders. Load-bearing for mobile: `IS_MOBILE` gates an
 * early return inside `use-composer-drop.ts`, so a tree that survived the flip
 * would change its hook count between renders and React would throw.
 */
const shell = (props: Omit<ShellProps, 'children'>): Decorator =>
  function Environment(Story) {
    return (
      <EnvironmentShell key={`${props.platform}-${props.hud ? 'hud' : 'app'}`} {...props}>
        <Story />
      </EnvironmentShell>
    )
  }

export const withDesktop = shell({ platform: 'desktop', viewport: '100vh' })

/** iOS rather than 'generic': the precise flag is what native-bridge branches
 *  read, and a phone we cannot name takes different paths. */
export const withMobile = shell({ platform: 'ios', viewport: '100vh' })

export const withHud = shell({ bandState: 'open', hud: true, platform: 'desktop', viewport: '100%' })
