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

export const PLATFORM = detectPlatform()
export const IS_ANDROID = PLATFORM === 'android'
export const IS_IOS = PLATFORM === 'ios'
export const IS_MOBILE = IS_ANDROID || IS_IOS
// True when a real Tauri runtime is present (any target). `platform()` only
// returns 'unknown' when it throws for lack of a runtime (plain-browser dev /
// vitest), so this cleanly distinguishes "native app" from "web/test".
export const IS_TAURI = PLATFORM !== 'unknown'

// macOS host — drives ⌘/⌥/⇧/⌃ vs Ctrl/Alt/Shift key-cap rendering (see lib/kbd).
export const IS_MAC = PLATFORM === 'macos'

// A real Tauri runtime on a desktop OS (macOS/Windows/Linux) — i.e. not a phone
// and not plain-browser/test. Custom window chrome (frameless titlebar, min/max/
// close, drag region) only makes sense here.
export const IS_DESKTOP = IS_TAURI && !IS_MOBILE

// Local-spawn gateway mode is a desktop-only capability: Tauri also builds
// desktop targets, where a bundled backend could run, but a phone can't spawn
// one. Mobile-only UIs (E2 mode picker, terminal, updater, pet-overlay) branch
// on this to stay hidden on Android/iOS.
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
