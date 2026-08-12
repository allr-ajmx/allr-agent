/**
 * The surfaces that must exist in EVERY window root.
 *
 * All three were shipped mounted inside one root and silently dead in the
 * others — the folder picker (fixed earlier), the ⌘F find bar (MJXHRM-387),
 * which searched the main shell and nothing else while a detached chat window,
 * the HUD and the Android activity screen all render real text, and the close
 * confirmation (MJXHRM-390), which lived in `ContribController` — the DOCKED
 * TILE TREE only — so a phone could park a "this chat is still working" prompt
 * that nothing would ever draw.
 */

import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/app/activity-screen', () => ({ ActivityScreenRoot: () => <div>activity</div> }))
vi.mock('@/app/hud/hud-window', () => ({ HudWindowRoot: () => <div>hud</div> }))
vi.mock('@/app/mobile-controller', () => ({ MobileController: () => <div>shell</div> }))
vi.mock('@/app/quick-entry/quick-entry-window', () => ({ QuickEntryWindowRoot: () => <div>quick</div> }))
vi.mock('@/app/tile-window', () => ({ TileWindowRoot: () => <div>tile</div> }))
vi.mock('@/app/right-pane/files/remote-picker', () => ({
  RemoteFolderPicker: () => <div data-testid="remote-picker" />
}))
vi.mock('@/components/find-bar', () => ({ FindBar: () => <div data-testid="find-bar" /> }))
vi.mock('@/app/close-confirm', () => ({ CloseConfirm: () => <div data-testid="close-confirm" /> }))

let activity = false
let tile = false
let surface: string | null = null

vi.mock('@/store/windows', () => ({
  isActivityWindow: () => activity,
  isTileWindow: () => tile,
  satelliteSurface: () => surface
}))

import { HUD_SURFACE } from '@/app/hud/hud'
import { QUICK_ENTRY_SURFACE } from '@/app/quick-entry/quick-entry'

import { App } from './app'

beforeEach(() => {
  activity = false
  tile = false
  surface = null
})

const ROOTS: [name: string, arrange: () => void, marker: string][] = [
  ['the main shell', () => undefined, 'shell'],
  ['a detached tile window', () => void (tile = true), 'tile'],
  ['the HUD', () => void (surface = HUD_SURFACE), 'hud'],
  ['Quick Entry', () => void (surface = QUICK_ENTRY_SURFACE), 'quick'],
  ['an activity screen', () => void (activity = true), 'activity']
]

describe('App', () => {
  it.each(ROOTS)('mounts the find bar, the folder picker and the close gate in %s', (_name, arrange, marker) => {
    arrange()

    render(<App />)

    expect(screen.getByText(marker)).toBeInTheDocument()
    expect(screen.getByTestId('find-bar')).toBeInTheDocument()
    expect(screen.getByTestId('remote-picker')).toBeInTheDocument()
    expect(screen.getByTestId('close-confirm')).toBeInTheDocument()
  })
})
