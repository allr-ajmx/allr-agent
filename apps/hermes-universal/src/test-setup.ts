// Vitest global setup — adds the jest-dom matchers (toBeInTheDocument,
// toHaveClass, …) to Vitest's expect.
import '@testing-library/jest-dom/vitest'

import { configureQueryClientForTests } from '@/lib/query-client'

// A dozen test files render against the app's SHARED React Query client — they
// have to, because the cache writers close over that instance. Its production
// defaults carry React Query's retry ladder, which stretches any REJECTED query
// to ~7s and blows Vitest's 5s testTimeout, so no test could assert a
// failed-load state. Disabled once here, where no file can forget it.
configureQueryClientForTests()

// Node 26 defines its own `localStorage` accessor on the global object, which
// returns `undefined` unless the process was started with --localstorage-file
// (it warns: "localStorage is not available because --localstorage-file was
// not provided"). In the jsdom environment `globalThis` IS the window, so that
// accessor shadows jsdom's Storage and every `localStorage.getItem(...)` in a
// test throws "Cannot read properties of undefined". Install a real in-memory
// Storage when the global resolves to nothing, before any test module reads it.
// Same shim as apps/desktop/vitest.setup.ts — keep the two in step.
if (typeof (globalThis as unknown as { localStorage?: Storage }).localStorage === 'undefined') {
  const store = new Map<string, string>()

  const storage: Storage = {
    clear: () => store.clear(),
    getItem: (k: string) => store.get(String(k)) ?? null,
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size
    },
    removeItem: (k: string) => void store.delete(String(k)),
    setItem: (k: string, v: string) => void store.set(String(k), String(v))
  }

  for (const target of [globalThis, (globalThis as unknown as { window?: Window }).window].filter(Boolean)) {
    Object.defineProperty(target, 'localStorage', {
      configurable: true,
      value: storage,
      writable: true
    })
  }
}

// jsdom lacks these DOM APIs that Radix primitives (dropdown/dialog/…) call
// while opening. Stub them so component tests can drive those overlays.
if (typeof Element !== 'undefined') {
  Element.prototype.hasPointerCapture ??= () => false

  Element.prototype.setPointerCapture ??= () => {}

  Element.prototype.releasePointerCapture ??= () => {}

  Element.prototype.scrollIntoView ??= () => {}
}

// jsdom has no ResizeObserver, and several chat components construct one in a
// layout effect (expandable-block, user-message clamp, tool windows). A no-op
// stub is enough: jsdom never lays anything out, so a real implementation would
// only ever report zeroes anyway.
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    disconnect() {}
    observe() {}
    unobserve() {}
  } as unknown as typeof ResizeObserver
}
