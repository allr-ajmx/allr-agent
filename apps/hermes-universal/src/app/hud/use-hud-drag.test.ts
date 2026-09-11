import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { HUD_POSITION_STORAGE_KEY, useHudDrag } from './use-hud-drag'

const startDraggingMock = vi.fn()
const setPositionMock = vi.fn()
const outerPositionMock = vi.fn().mockResolvedValue({ x: 400, y: 300 })

vi.mock('@/lib/platform', () => ({
  IS_TAURI: true
}))

vi.mock('@tauri-apps/api/webviewWindow', () => ({
  getCurrentWebviewWindow: () => ({
    outerPosition: outerPositionMock,
    setPosition: setPositionMock,
    startDragging: startDraggingMock
  })
}))

vi.mock('@tauri-apps/api/dpi', () => ({
  PhysicalPosition: class {
    constructor(
      public x: number,
      public y: number
    ) {}
  }
}))

describe('useHudDrag', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.localStorage.clear()
  })

  afterEach(() => {
    window.localStorage.clear()
  })

  it('tracks Command/Ctrl key press for grab cursor state', () => {
    const { result } = renderHook(() => useHudDrag())

    expect(result.current.commandHeld).toBe(false)

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Meta' }))
    })
    expect(result.current.commandHeld).toBe(true)

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Meta' }))
    })
    expect(result.current.commandHeld).toBe(false)

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control' }))
    })
    expect(result.current.commandHeld).toBe(true)

    act(() => {
      window.dispatchEvent(new Event('blur'))
    })
    expect(result.current.commandHeld).toBe(false)
  })

  it('initiates native window drag on pointerdown when metaKey or ctrlKey is active', () => {
    const { result } = renderHook(() => useHudDrag())

    // Plain click does nothing
    const plainEvent = {
      ctrlKey: false,
      metaKey: false,
      preventDefault: vi.fn()
    } as unknown as React.PointerEvent

    result.current.onPointerDown(plainEvent)
    expect(startDraggingMock).not.toHaveBeenCalled()
    expect(plainEvent.preventDefault).not.toHaveBeenCalled()

    // Command + Click starts window dragging
    const cmdEvent = {
      ctrlKey: false,
      metaKey: true,
      preventDefault: vi.fn()
    } as unknown as React.PointerEvent

    result.current.onPointerDown(cmdEvent)
    expect(cmdEvent.preventDefault).toHaveBeenCalled()
    expect(startDraggingMock).toHaveBeenCalledTimes(1)

    // Ctrl + Click also starts window dragging
    const ctrlEvent = {
      ctrlKey: true,
      metaKey: false,
      preventDefault: vi.fn()
    } as unknown as React.PointerEvent

    result.current.onPointerDown(ctrlEvent)
    expect(ctrlEvent.preventDefault).toHaveBeenCalled()
    expect(startDraggingMock).toHaveBeenCalledTimes(2)
  })

  it('restores resting position from localStorage on mount', async () => {
    window.localStorage.setItem(HUD_POSITION_STORAGE_KEY, JSON.stringify({ x: 250, y: 150 }))

    renderHook(() => useHudDrag())

    // Allow promise tick in effect
    await act(async () => {
      await Promise.resolve()
    })

    expect(setPositionMock).toHaveBeenCalledWith(expect.objectContaining({ x: 250, y: 150 }))
  })

  it('persists resting position to localStorage on drag end (pointerup)', async () => {
    const { result } = renderHook(() => useHudDrag())

    const cmdEvent = {
      ctrlKey: false,
      metaKey: true,
      preventDefault: vi.fn()
    } as unknown as React.PointerEvent

    result.current.onPointerDown(cmdEvent)

    expect(startDraggingMock).toHaveBeenCalledTimes(1)

    // Trigger pointerup to complete drag
    await act(async () => {
      window.dispatchEvent(new Event('pointerup'))
      await Promise.resolve()
    })

    expect(outerPositionMock).toHaveBeenCalled()
    expect(window.localStorage.getItem(HUD_POSITION_STORAGE_KEY)).toBe(JSON.stringify({ x: 400, y: 300 }))
  })
})
