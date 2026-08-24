import type { StorybookConfig } from '@storybook/react-vite'
import { fileURLToPath } from 'node:url'

/**
 * Storybook is a DESIGN HARNESS for the composer, not part of the build or the
 * gate. `npm run check` does not run it; nothing here may change app behaviour.
 *
 * The Vite builder loads the app's own `vite.config.ts` and merges it, so the
 * `@` alias, the React-singleton pins, Tailwind v4, the `__TRACE_RUN_DEFAULT__`
 * define, the deliberate empty-PostCSS guard and the `/emojibase` dev middleware
 * all come across for free. This file only adds the browser stubs.
 */

const mock = (name: string) => fileURLToPath(new URL(`./mocks/${name}`, import.meta.url))

/**
 * Storybook-only module substitutions.
 *
 * `@/lib/platform` makes the device flags switchable, which is what lets the
 * mobile story render the mobile composer rather than the desktop one wearing a
 * class. The rest stub the Tauri boundary at its entry points — `api/core` alone
 * has 36 importers — instead of stubbing the ~15 `@/store/*` and `@/lib/*`
 * modules stacked on top of them.
 *
 * `@tauri-apps/api-real/core` is not redundant next to `@tauri-apps/api/core`:
 * below `NODE_ENV=production` the app's config already points the public
 * specifier at its IPC-tracing wrapper, and that wrapper reaches the real module
 * through the `-real` escape hatch. Storybook dev is exactly that case, so
 * stubbing only the public name would leave the hatch open.
 */
const STORYBOOK_ALIASES: Record<string, string> = {
  '@/lib/platform': mock('platform.ts'),
  '@tauri-apps/api-real/core': mock('tauri-core.ts'),
  '@tauri-apps/api/app': mock('tauri-app.ts'),
  '@tauri-apps/api/core': mock('tauri-core.ts'),
  '@tauri-apps/api/event': mock('tauri-event.ts'),
  '@tauri-apps/plugin-dialog': mock('tauri-plugin-dialog.ts'),
  '@tauri-apps/plugin-fs': mock('tauri-plugin-fs.ts'),
  '@tauri-apps/plugin-haptics': mock('tauri-plugin-haptics.ts'),
  '@tauri-apps/plugin-notification': mock('tauri-plugin-notification.ts'),
  '@tauri-apps/plugin-os': mock('tauri-plugin-os.ts')
}

const config: StorybookConfig = {
  addons: [],
  // Off by choice. Storybook phones anonymous usage data home on every boot;
  // this is a private product repo and nobody asked for that outbound call.
  core: { disableTelemetry: true },
  framework: { name: '@storybook/react-vite', options: {} },
  stories: ['../src/**/*.stories.@(ts|tsx)'],

  /**
   * ORDER IS THE WHOLE TRICK, so these are PREPENDED to the app's alias list
   * rather than merged into it.
   *
   * Vite resolves an alias list in order and takes the first match, and the app
   * aliases the `@` PREFIX. Merged as objects the app's keys land first, so
   * `@/lib/platform` would match `@`, resolve straight back to the real module,
   * and the alias would look wired while doing nothing — the mobile story would
   * silently be a desktop composer. `vite.config.ts` hits the same trap and says
   * so: "Exact-match key, declared first so it wins over the `@` prefix below."
   */
  viteFinal: config => {
    const inherited = config.resolve?.alias ?? {}
    const asEntries = Array.isArray(inherited)
      ? inherited
      : Object.entries(inherited).map(([find, replacement]) => ({ find, replacement: String(replacement) }))

    return {
      ...config,
      resolve: {
        ...config.resolve,
        alias: [
          ...Object.entries(STORYBOOK_ALIASES).map(([find, replacement]) => ({ find, replacement })),
          ...asEntries
        ]
      }
    }
  }
}

export default config
