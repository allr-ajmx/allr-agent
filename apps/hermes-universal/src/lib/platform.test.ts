import { beforeEach, describe, expect, it, vi } from 'vitest'

import { detectMobileDevice, IS_ANDROID, IS_MOBILE, IS_NATIVE_MOBILE, LOCAL_MODE_SUPPORTED, PLATFORM } from './platform'

// In jsdom there is no Tauri runtime, so platform() throws and the helper falls
// back to 'unknown'. jsdom's UA names no mobile device and maxTouchPoints is 0
// (and innerWidth defaults to 1024), so the device sniff also returns null →
// desktop-like defaults.
describe('platform gating (no Tauri runtime)', () => {
  it('falls back to unknown', () => {
    expect(PLATFORM).toBe('unknown')
  })

  it('is not detected as mobile', () => {
    expect(IS_ANDROID).toBe(false)
    expect(IS_MOBILE).toBe(false)
    expect(IS_NATIVE_MOBILE).toBe(false)
  })

  it('allows local mode off-device', () => {
    expect(LOCAL_MODE_SUPPORTED).toBe(true)
  })
})

// IS_NATIVE_MOBILE gates the sign-in flows that navigate the app away and back
// (store/cloud.ts `cloudSignIn`, store/connection.ts `beginOAuthLogin`). Getting it
// wrong on either side is silent and costly: false-negative loses the resume marker, so
// the user finishes a login and lands back on a blank picker; false-positive parks a
// marker on desktop, where the promise DOES resolve, and the next boot jumps to a Cloud
// card nobody asked for. So pin both named phones and the unnamed device separately.
describe('IS_NATIVE_MOBILE', () => {
  const loadOn = async (ua: string, maxTouchPoints: number, width: number) => {
    vi.resetModules()
    vi.stubGlobal('navigator', { maxTouchPoints, userAgent: ua })
    vi.stubGlobal('window', { ...globalThis.window, innerWidth: width })

    return import('./platform')
  }

  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('is true for iOS — the platform this gate was widened for', async () => {
    const m = await loadOn('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', 5, 390)

    expect(m.IS_IOS).toBe(true)
    expect(m.IS_NATIVE_MOBILE).toBe(true)
  })

  it('is true for Android', async () => {
    const m = await loadOn('Mozilla/5.0 (Linux; Android 14; Pixel 8)', 5, 412)

    expect(m.IS_ANDROID).toBe(true)
    expect(m.IS_NATIVE_MOBILE).toBe(true)
  })

  // 'generic' means the sniff saw a touch device it could NOT name. IS_MOBILE takes it
  // (layout is safe to get wrong); a native bridge is not, so this one must stay false.
  it('is false for an unnamed thin touch device, which IS_MOBILE still takes', async () => {
    const m = await loadOn('Some/UA', 5, 400)

    expect(m.IS_MOBILE).toBe(true)
    expect(m.IS_NATIVE_MOBILE).toBe(false)
  })
})

// The resilient fallback used when platform() can't report ios/android (the iOS
// webview boot race). Device-id (UA + touch) first, then a thin-touch width signal.
describe('detectMobileDevice', () => {
  const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15'
  const IPAD = 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15'
  const IPADOS_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15'
  const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36'
  const DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/537.36 Chrome/120'

  it('tags iPhone / iPad by UA regardless of width or touch', () => {
    expect(detectMobileDevice(IPHONE, 0, 1200)).toBe('ios')
    expect(detectMobileDevice(IPAD, 5, 400)).toBe('ios')
  })

  it('treats a touch-capable Macintosh UA as iPadOS', () => {
    expect(detectMobileDevice(IPADOS_MAC, 5, 1024)).toBe('ios')
  })

  it('leaves a real (mouse) Mac as not-mobile', () => {
    expect(detectMobileDevice(DESKTOP, 0, 1440)).toBeNull()
  })

  it('tags Android by UA', () => {
    expect(detectMobileDevice(ANDROID, 5, 400)).toBe('android')
  })

  it('tags an unnamed thin TOUCH device as generic mobile', () => {
    expect(detectMobileDevice('Some/UA', 5, 400)).toBe('generic')
  })

  it('does not tag a narrow desktop window (no touch)', () => {
    expect(detectMobileDevice('Some/UA', 0, 400)).toBeNull()
  })

  it('does not tag a wide touch device', () => {
    expect(detectMobileDevice('Some/UA', 5, 1200)).toBeNull()
  })
})
