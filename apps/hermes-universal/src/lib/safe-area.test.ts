import { afterEach, describe, expect, it } from 'vitest'

import { readKeyboardInset, readSafeAreaInsets } from './safe-area'

const VARS = [
  '--safe-area-inset-top',
  '--safe-area-inset-right',
  '--safe-area-inset-bottom',
  '--safe-area-inset-left',
  '--keyboard-inset'
] as const

function setVar(name: string, value: string): void {
  document.documentElement.style.setProperty(name, value)
}

afterEach(() => {
  for (const name of VARS) {
    document.documentElement.style.removeProperty(name)
  }
})

describe('readSafeAreaInsets', () => {
  it('answers zeroes before the publisher has run', () => {
    expect(readSafeAreaInsets()).toEqual({ bottom: 0, left: 0, right: 0, top: 0 })
  })

  it('reads the published px values', () => {
    setVar('--safe-area-inset-top', '47px')
    setVar('--safe-area-inset-right', '0px')
    setVar('--safe-area-inset-bottom', '34px')
    setVar('--safe-area-inset-left', '12px')

    expect(readSafeAreaInsets()).toEqual({ bottom: 34, left: 12, right: 0, top: 47 })
  })

  it('reads fractional insets', () => {
    setVar('--safe-area-inset-top', '20.5px')

    expect(readSafeAreaInsets().top).toBeCloseTo(20.5)
  })

  it('reads a unitless or non-px value as zero rather than NaN', () => {
    // An unresolved env() or a rem value must not poison the geometry that
    // depends on this — a NaN inset would silently void every clamp.
    setVar('--safe-area-inset-top', '2rem')
    setVar('--safe-area-inset-bottom', 'env(safe-area-inset-bottom)')

    const insets = readSafeAreaInsets()

    expect(insets.top).toBe(0)
    expect(insets.bottom).toBe(0)
    expect(Number.isNaN(insets.top)).toBe(false)
  })

  it('reads an explicit zero', () => {
    setVar('--safe-area-inset-top', '0px')

    expect(readSafeAreaInsets().top).toBe(0)
  })
})

describe('readKeyboardInset', () => {
  it('is zero with the keyboard closed', () => {
    expect(readKeyboardInset()).toBe(0)
  })

  it('reads the published keyboard height', () => {
    setVar('--keyboard-inset', '312px')

    expect(readKeyboardInset()).toBe(312)
  })
})
