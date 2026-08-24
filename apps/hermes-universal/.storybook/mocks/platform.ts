/**
 * `@/lib/platform`, with the device flags made switchable.
 *
 * WHY THIS EXISTS
 *
 * The mobile composer is not just a stylesheet. `html.is-mobile` carries the
 * layout, but five JS branches read the `IS_MOBILE` CONSTANT and decide real
 * structure — most visibly `{IS_MOBILE && <BubbleRow />}` in
 * `app/chat/composer/index.tsx`, plus the status stack going in-flow rather than
 * `absolute bottom-full`, and pop-out / drag-drop / autofocus all standing down.
 * A mobile story that only added the class would be missing the bubble row and
 * would quietly misrepresent the thing we are redesigning.
 *
 * The real module decides those once, at import, from a `platform()` call and a
 * UA/touch/width sniff — neither of which a story can steer. So Storybook (and
 * ONLY Storybook: this file is reached through an alias in `.storybook/main.ts`;
 * the app build and the vitest run never see it) re-exports the pure parts
 * unchanged and republishes the flags as mutable bindings.
 *
 * WHY `let` AND NOT A GETTER
 *
 * Consumers write `import { IS_MOBILE } from '@/lib/platform'`. ESM imports are
 * live bindings, so reassigning the export here is visible at every import site
 * on the next read — no consumer has to change, and every render-time read picks
 * up the new value.
 *
 * THE TRAP THIS CANNOT SOLVE
 *
 * `hooks/use-composer-drop.ts` early-returns on `IS_MOBILE` INSIDE a hook. Flip
 * the flag under a mounted tree and the hook count changes between renders,
 * which React throws on. So `__setPlatform` must be called BEFORE mount, and the
 * environment decorators key their wrapper on the platform so a switch remounts
 * rather than re-renders. Do not call it from an event handler.
 */

// Re-exported unchanged: pure, and its own unit test covers it.
export { detectMobileDevice } from '../../src/lib/platform'

export type PlatformKind = 'android' | 'desktop' | 'ios'

export let PLATFORM = 'macos'
export let IS_ANDROID = false
export let IS_IOS = false
export let IS_MOBILE = false
export let IS_NATIVE_MOBILE = false
export let IS_MAC = true
export let IS_DESKTOP = true
export let LOCAL_MODE_SUPPORTED = true
export let SSH_LOCAL_FILES_SUPPORTED = true

/**
 * True in the real app whenever a Tauri runtime is present. Pinned TRUE here
 * even though Storybook is a plain browser: a lot of code reads it as "we are
 * the app, not the marketing site" and takes the read-only/degraded branch when
 * it is false. The Tauri entry points are all stubbed, so claiming a runtime is
 * safe — the calls resolve instead of reaching a native bridge.
 */
export const IS_TAURI = true

/** Set the device the next mounted story renders as. Call before mount. */
export function __setPlatform(kind: PlatformKind): void {
  IS_ANDROID = kind === 'android'
  IS_IOS = kind === 'ios'
  IS_MOBILE = kind !== 'desktop'
  IS_NATIVE_MOBILE = IS_ANDROID || IS_IOS
  IS_MAC = kind === 'desktop'
  IS_DESKTOP = !IS_MOBILE
  LOCAL_MODE_SUPPORTED = !IS_MOBILE
  SSH_LOCAL_FILES_SUPPORTED = !IS_MOBILE
  PLATFORM = kind === 'desktop' ? 'macos' : kind
}
