import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { I18nProvider } from '@/i18n'
import { $downloads, type DownloadItem } from '@/store/downloads'

import { DownloadsTray } from './downloads-tray'

/**
 * The tray button behaves like a browser's, which is a behaviour contract with
 * exactly two halves: it is ALWAYS there, and the panel it opens is legible
 * when there is nothing in it. The old `useTrayVisible` hook unmounted the
 * whole control 60 seconds after the last transfer finished, which made a
 * download from two minutes ago unreachable — these tests are what stops that
 * coming back.
 */
function row(overrides: Partial<DownloadItem> = {}): DownloadItem {
  return {
    dest: '/home/me/Downloads/report.pdf',
    id: 'dl-1',
    kind: 'file',
    name: 'report.pdf',
    owner: 'this-webview',
    received: 2048,
    srcPath: '/work/out/report.pdf',
    startedAt: 1000,
    status: 'done',
    total: 2048,
    ...overrides
  }
}

function openTray(name = 'Downloads') {
  render(
    <I18nProvider>
      <DownloadsTray />
    </I18nProvider>
  )

  const trigger = screen.getByRole('button', { name })

  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false })
  fireEvent.click(trigger)

  return trigger
}

beforeEach(() => {
  $downloads.set({})
})

afterEach(() => {
  cleanup()
  $downloads.set({})
})

describe('DownloadsTray', () => {
  it('renders the button with an empty table and opens to an empty state', () => {
    const trigger = openTray()

    expect(trigger).toBeTruthy()
    expect(screen.getAllByText('No downloads yet').length).toBeGreaterThan(0)
  })

  /**
   * The auto-hide is gone: a download that finished ten minutes ago is still
   * one click away, which is the entire point of the change.
   */
  it('still shows a download that finished long ago', () => {
    $downloads.set({ 'dl-1': row({ finishedAt: Date.now() - 10 * 60_000 }) })

    openTray()

    expect(screen.getAllByText('report.pdf').length).toBeGreaterThan(0)
    expect(screen.queryByText('No downloads yet')).toBeNull()
  })

  /**
   * The dot badge is now the ONLY thing that varies with activity, so what it
   * says has to stay exact: it names the count in the trigger's `aria-label`
   * (a digit at this size is unreadable) and it is absent when nothing moves.
   */
  it('names in-flight transfers on the trigger and is quiet otherwise', () => {
    $downloads.set({ 'dl-1': row({ finishedAt: 2000 }) })

    const { unmount } = render(
      <I18nProvider>
        <DownloadsTray />
      </I18nProvider>
    )

    expect(screen.getByRole('button', { name: 'Downloads' })).toBeTruthy()

    unmount()
    $downloads.set({ 'dl-1': row({ status: 'running' }) })

    render(
      <I18nProvider>
        <DownloadsTray />
      </I18nProvider>
    )

    expect(screen.getByRole('button', { name: '1 download in progress' })).toBeTruthy()
  })
})
