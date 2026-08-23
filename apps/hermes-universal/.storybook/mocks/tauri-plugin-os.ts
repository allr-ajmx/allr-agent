/**
 * `@tauri-apps/plugin-os`, stubbed for the browser.
 *
 * Only reachable if something loads the REAL `src/lib/platform.ts` past the
 * `@/lib/platform` alias (a deep relative import, say). `platform.ts` already
 * try/catches this call and falls back to a UA sniff, so this stub only makes
 * the fallback unnecessary — it does not decide the story's device mode. That
 * is `.storybook/mocks/platform.ts` and the environment decorators.
 */

export function platform(): string {
  return 'macos'
}

export function type(): string {
  return 'macos'
}

export function version(): string {
  return '15.0.0'
}

export function family(): string {
  return 'unix'
}

export function arch(): string {
  return 'aarch64'
}

export function locale(): Promise<string | null> {
  return Promise.resolve('en-US')
}

export function hostname(): Promise<string | null> {
  return Promise.resolve('storybook')
}

export function exeExtension(): string {
  return ''
}

export const EOL = '\n'
