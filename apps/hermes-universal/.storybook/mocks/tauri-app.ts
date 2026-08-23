/**
 * `@tauri-apps/api/app`, stubbed for the browser.
 *
 * `supportsMultipleWindows()` returning false is load-bearing rather than
 * arbitrary: `store/windows.ts` feeds it into `isSecondaryWindow()`, which the
 * composer's pop-out and metrics hooks read. False makes every story behave as
 * the PRIMARY window, which is the one the composer is designed against.
 */

export function getVersion(): Promise<string> {
  return Promise.resolve('0.0.6-storybook')
}

export function getName(): Promise<string> {
  return Promise.resolve('Allr')
}

export function getTauriVersion(): Promise<string> {
  return Promise.resolve('2.0.0')
}

export function supportsMultipleWindows(): boolean {
  return false
}

export function show(): Promise<void> {
  return Promise.resolve()
}

export function hide(): Promise<void> {
  return Promise.resolve()
}

export function setTheme(): Promise<void> {
  return Promise.resolve()
}

export function defaultWindowIcon(): Promise<null> {
  return Promise.resolve(null)
}
