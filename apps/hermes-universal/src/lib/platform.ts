import { platform } from '@tauri-apps/plugin-os'

// Platform gating (A6). `platform()` (from tauri-plugin-os) is synchronous in v2
// but reads a value injected by the Tauri runtime at startup, so it THROWS when
// there is no runtime — plain-browser `vite dev`, or vitest/jsdom. Guard it and
// fall back to 'unknown', which yields desktop-like defaults (the right choice
// for desktop dev and harmless in tests).
function detectPlatform(): string {
  try {
    return platform()
  } catch {
    return 'unknown'
  }
}

const MOBILE_MAX_WIDTH = 768

// UA/touch/width device sniff — the resilient fallback for when the OS-plugin global
// (`window.__TAURI_OS_PLUGIN_INTERNALS__`) isn't injected yet at the moment platform.ts
// is first imported and `platform()` throws (the iOS webview boot race, MJX-203). Pure +
// parameterized so it is unit-testable without a real navigator. Returns a specific OS
// when the UA names one, else 'generic' for an unnamed thin TOUCH device, else null.
// 'generic' flips IS_MOBILE but NOT IS_IOS/IS_ANDROID, so OS-specific native bridges
// (Home bridge, Android-only launch gate) aren't triggered for a device we can't identify.
export function detectMobileDevice(
  ua: string,
  maxTouchPoints: number,
  viewportWidth: number
): 'ios' | 'android' | 'generic' | null {
  if (/iPhone|iPod|iPad/.test(ua)) {
    return 'ios'
  }

  // iPadOS 13+ reports a desktop "Macintosh" UA; it's the only Mac with a touch screen,
  // so a touch-capable Mac UA ⇒ iPad.
  if (/Macintosh/.test(ua) && maxTouchPoints > 1) {
    return 'ios'
  }

  if (/Android/i.test(ua)) {
    return 'android'
  }

  // Thin TOUCH viewport the UA didn't name → generic mobile. Touch-gated so a narrow /
  // resized DESKTOP window (mouse, no touch) is never mis-tagged; width picks up small
  // phones / foldables the UA sniff missed.
  if (maxTouchPoints > 0 && viewportWidth > 0 && viewportWidth < MOBILE_MAX_WIDTH) {
    return 'generic'
  }

  return null
}

function detectMobileFallback(): 'ios' | 'android' | 'generic' | null {
  if (typeof navigator === 'undefined') {
    return null
  }

  const width = typeof window !== 'undefined' ? window.innerWidth : 0

  return detectMobileDevice(navigator.userAgent || '', navigator.maxTouchPoints ?? 0, width)
}

export const PLATFORM = detectPlatform()

// Trust a resolved native ios/android; otherwise — and ONLY when `platform()` gave us
// nothing (i.e. 'unknown', because it threw) — fall back to the device sniff. A resolved
// DESKTOP OS never runs the sniff, so a touchscreen laptop / narrow window can't be
// mis-tagged as mobile.
const MOBILE_DEVICE: 'ios' | 'android' | 'generic' | null =
  PLATFORM === 'ios' || PLATFORM === 'android' ? PLATFORM : PLATFORM === 'unknown' ? detectMobileFallback() : null

// IS_IOS / IS_ANDROID stay PRECISE (only a named OS); IS_MOBILE also covers 'generic'.
export const IS_ANDROID = MOBILE_DEVICE === 'android'
export const IS_IOS = MOBILE_DEVICE === 'ios'
export const IS_MOBILE = MOBILE_DEVICE !== null
// True when a real Tauri runtime is present (any target). `platform()` only
// returns 'unknown' when it throws for lack of a runtime (plain-browser dev /
// vitest), so this cleanly distinguishes "native app" from "web/test".
export const IS_TAURI = PLATFORM !== 'unknown'

// macOS host — drives ⌘/⌥/⇧/⌃ vs Ctrl/Alt/Shift key-cap rendering (see
// lib/keybinds/combo).
export const IS_MAC = PLATFORM === 'macos'

// A real Tauri runtime on a desktop OS (macOS/Windows/Linux) — i.e. not a phone
// and not plain-browser/test. Custom window chrome (frameless titlebar, min/max/
// close, drag region) only makes sense here.
export const IS_DESKTOP = IS_TAURI && !IS_MOBILE

// Local-spawn gateway mode is a desktop-only capability: Tauri also builds
// desktop targets, where a bundled backend could run, but a phone can't spawn
// one. DESKTOP-only UIs (the E2 mode picker, the local terminal) branch on this
// to stay hidden on Android/iOS. (Updates are NOT one of them: About checks the
// Play/App Store there instead — see lib/updates.ts.)
//
// This comment used to say "Mobile-only UIs", which reads as the opposite of
// what it gates, and to name a `pet-overlay` — the desktop's separate mascot
// window, which universal never ported and which nothing here has ever gated.
// The in-app pet ships on every platform; what varies is how it roams
// (app/pet/wall-geometry.ts).
export const LOCAL_MODE_SUPPORTED = !IS_MOBILE

// SSH gateway mode works EVERYWHERE — russh is pure Rust, so a phone can dial an
// SSH host just as a laptop can. That is the whole point of MJX-55, and why there
// is no SSH_MODE_SUPPORTED gate to go with this one.
//
// What a phone lacks is the local FILES the desktop flow leans on: there is no
// ~/.ssh to read a config or an IdentityFile from, no ssh-agent socket, and no
// file picker that hands back a path russh could open a private key through
// (Android SAF returns a content:// URI). So the key-path field and the
// ~/.ssh/config host dropdown are desktop-only, and mobile pastes a PEM into the
// OS keystore instead.
export const SSH_LOCAL_FILES_SUPPORTED = !IS_MOBILE
