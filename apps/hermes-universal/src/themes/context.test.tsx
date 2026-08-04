import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { __resetBackendSkinSync, ingestBackendSkin } from './backend-sync'
import { ThemeProvider, useTheme } from './context'

function Harness() {
  const { themeName, resolvedMode, setMode, setTheme } = useTheme()

  return (
    <div>
      <span data-testid="state">{`${themeName}:${resolvedMode}`}</span>
      <button onClick={() => setMode('dark')}>dark</button>
      <button onClick={() => setMode('light')}>light</button>
      <button onClick={() => setTheme('nous')}>nous</button>
      <button onClick={() => setTheme('ember')}>ember</button>
    </div>
  )
}

const root = () => document.documentElement

describe('ThemeProvider', () => {
  beforeEach(() => {
    localStorage.clear()
    root().className = ''
    root().removeAttribute('style')
  })
  afterEach(() => localStorage.clear())

  it('paints seeds onto :root and defaults to the nous skin', () => {
    render(
      <ThemeProvider>
        <Harness />
      </ThemeProvider>
    )
    // jsdom has no matchMedia, so system resolves to light.
    expect(screen.getByTestId('state')).toHaveTextContent('nous:light')
    expect(root().style.getPropertyValue('--theme-primary').toLowerCase()).toBe('#0053fd')
    expect(root().classList.contains('dark')).toBe(false)
  })

  it('toggles the .dark class and repaints seeds on mode change', () => {
    render(
      <ThemeProvider>
        <Harness />
      </ThemeProvider>
    )

    fireEvent.click(screen.getByText('dark'))
    expect(root().classList.contains('dark')).toBe(true)
    expect(root().dataset.hermesMode).toBe('dark')
    // Dark nous foreground is a light color (not the light-mode #17171a).
    expect(root().style.getPropertyValue('--theme-foreground')).not.toBe('#17171a')
    expect(localStorage.getItem('hermes.mode')).toBe('dark')

    fireEvent.click(screen.getByText('light'))
    expect(root().classList.contains('dark')).toBe(false)
  })

  it('switches skin and persists it', () => {
    render(
      <ThemeProvider>
        <Harness />
      </ThemeProvider>
    )
    fireEvent.click(screen.getByText('ember'))
    expect(screen.getByTestId('state')).toHaveTextContent('ember:')
    expect(localStorage.getItem('hermes.skin')).toBe('ember')
    expect(root().dataset.hermesTheme).toBe('ember')
  })

  it('writes the skin font tokens onto :root', () => {
    render(
      <ThemeProvider>
        <Harness />
      </ThemeProvider>
    )
    // nous inherits Courier Prime for mono; the bundled Segoe/JetBrains stacks
    // seed sans + the mono fallback. (Click nous explicitly — the persistent
    // skin atom carries the prior test's selection across cases.)
    fireEvent.click(screen.getByText('nous'))
    expect(root().style.getPropertyValue('--dt-font-sans')).toContain('Segoe WPC')
    expect(root().style.getPropertyValue('--dt-font-mono')).toContain('Courier Prime')

    fireEvent.click(screen.getByText('ember'))
    expect(root().style.getPropertyValue('--dt-font-mono')).toContain('IBM Plex Mono')
  })

  it('never injects an external web-font stylesheet (all faces are bundled)', () => {
    render(
      <ThemeProvider>
        <Harness />
      </ThemeProvider>
    )
    fireEvent.click(screen.getByText('ember'))
    fireEvent.click(screen.getByText('nous'))
    // Every mono face is self-hosted via @font-face; no runtime <link> fetch.
    expect(document.querySelector('link[data-hermes-theme-font]')).toBeNull()
  })
})

// The live-authoring loop: Hermes writes/edits one skin file and every surface
// repaints. An in-place edit keeps the NAME — only the palette moves.
const bloomberg = (foreground: string) => ({
  name: 'bloomberg',
  colors: { background: '#000000', ui_text: foreground, ui_accent: '#ff8000' }
})

const cssVar = (name: string) => root().style.getPropertyValue(name)

describe('ThemeProvider ← backend skin sync', () => {
  beforeEach(() => {
    localStorage.clear()
    __resetBackendSkinSync()
  })

  afterEach(cleanup)

  it('applies an activated backend skin', () => {
    render(
      <ThemeProvider>
        <div />
      </ThemeProvider>
    )

    act(() => ingestBackendSkin(bloomberg('#ff9f0a'), { apply: true }))

    expect(cssVar('--theme-foreground')).toBe('#ff9f0a')
    expect(cssVar('--theme-background-seed')).toBe('#000000')
  })

  it('repaints an in-place edit of the ACTIVE skin (same name, new palette)', () => {
    render(
      <ThemeProvider>
        <div />
      </ThemeProvider>
    )

    act(() => ingestBackendSkin(bloomberg('#ff9f0a'), { apply: true }))
    expect(cssVar('--theme-foreground')).toBe('#ff9f0a')

    // Recolor the same skin file. The same-name apply guard correctly no-ops
    // (that's what protects a manual pick from snapping back), so the repaint
    // must come from the registry update reaching the active theme derivation.
    act(() => ingestBackendSkin(bloomberg('#ff2d95'), { apply: true }))
    expect(cssVar('--theme-foreground')).toBe('#ff2d95')
  })

  it('does not repaint an edit to an INACTIVE skin', () => {
    render(
      <ThemeProvider>
        <div />
      </ThemeProvider>
    )

    act(() => ingestBackendSkin(bloomberg('#ff9f0a'), { apply: true }))

    // A different skin registered without apply (e.g. seeded on reconnect)
    // must not touch the painted theme.
    act(() =>
      ingestBackendSkin({ name: 'forest', colors: { background: '#001100', ui_text: '#66ff66' } }, { apply: false })
    )
    expect(cssVar('--theme-foreground')).toBe('#ff9f0a')
  })
})
