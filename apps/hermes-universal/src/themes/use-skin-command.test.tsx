import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ThemeProvider } from './context'
import { useSkinCommand } from './use-skin-command'

function Harness() {
  const run = useSkinCommand()

  return (
    <div>
      <button onClick={() => (screen.getByTestId('out').textContent = run('ember'))}>set</button>
      <button onClick={() => (screen.getByTestId('out').textContent = run(''))}>cycle</button>
      <button onClick={() => (screen.getByTestId('out').textContent = run('nope'))}>bad</button>
      <span data-testid="out" />
    </div>
  )
}

const render_ = () =>
  render(
    <ThemeProvider>
      <Harness />
    </ThemeProvider>
  )

describe('useSkinCommand', () => {
  beforeEach(() => {
    localStorage.clear()
    document.documentElement.className = ''
    document.documentElement.removeAttribute('style')
  })
  afterEach(() => localStorage.clear())

  it('sets a named skin and persists it', () => {
    render_()
    fireEvent.click(screen.getByText('set'))
    expect(screen.getByTestId('out')).toHaveTextContent('Theme switched to Ember')
    expect(localStorage.getItem('hermes.skin')).toBe('ember')
  })

  it('cycles to the next skin on a bare command', () => {
    render_()
    fireEvent.click(screen.getByText('cycle'))
    // allr is the default and comes first; a bare /skin advances to the next
    // built-in.
    expect(screen.getByTestId('out')).toHaveTextContent('Theme switched to')
    expect(localStorage.getItem('hermes.skin')).not.toBe('allr')
  })

  it('reports an unknown skin without changing the selection', () => {
    render_()
    fireEvent.click(screen.getByText('bad'))
    expect(screen.getByTestId('out')).toHaveTextContent('Unknown theme: nope')
    expect(localStorage.getItem('hermes.skin')).toBeNull()
  })
})
