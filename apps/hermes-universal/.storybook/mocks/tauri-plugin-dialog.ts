/**
 * `@tauri-apps/plugin-dialog`, stubbed for the browser.
 *
 * Named exports rather than a Proxy: the consumers use static named imports
 * (`import { open } from …`), which a bundler resolves at build time — a Proxy
 * namespace would fail to resolve them.
 *
 * `open` resolving null is the "user cancelled the picker" path, which every
 * caller already handles (`chat-composer.tsx`'s attachment pickers, and
 * `lib/desktop-fs.ts`).
 */

export function open(): Promise<null> {
  console.debug('[storybook] dialog.open — resolving as cancelled')

  return Promise.resolve(null)
}

export function save(): Promise<null> {
  return Promise.resolve(null)
}

export function message(): Promise<void> {
  return Promise.resolve()
}

export function ask(): Promise<boolean> {
  return Promise.resolve(false)
}

export function confirm(): Promise<boolean> {
  return Promise.resolve(false)
}
