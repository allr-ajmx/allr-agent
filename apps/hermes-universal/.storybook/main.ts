import type { StorybookConfig } from '@storybook/react-vite'
import { fileURLToPath } from 'node:url'
import { mergeConfig } from 'vite'

/**
 * Storybook is a DESIGN HARNESS for the composer, not part of the build or the
 * gate. `npm run check` does not run it; nothing here may change app behaviour.
 *
 * The Vite builder loads the app's own `vite.config.ts` and merges it, so the
 * `@` alias, the React-singleton pins, Tailwind v4, the `__TRACE_RUN_DEFAULT__`
 * define, the deliberate empty-PostCSS guard and the `/emojibase` dev middleware
 * all come across for free. `viteFinal` only adds what is Storybook-specific:
 * the browser stubs.
 */

const mock = (name: string) => fileURLToPath(new URL(`./mocks/${name}`, import.meta.url))

const config: StorybookConfig = {
  addons: [],
  framework: { name: '@storybook/react-vite', options: {} },
  stories: ['../src/**/*.stories.@(ts|tsx)'],
  viteFinal: config =>
    mergeConfig(config, {
      resolve: {
        alias: {
          // Device mode. See mocks/platform.ts for why the flags have to be
          // mutable rather than sniffed.
          '@/lib/platform': mock('platform.ts'),

          // The Tauri boundary, stubbed at its four entry points rather than at
          // the ~15 app modules sitting on top of them.
          //
          // `api-real/core` is here for a specific reason: when
          // `NODE_ENV !== 'production'` the app's own config already aliases
          // `@tauri-apps/api/core` to its tracing wrapper, and that wrapper
          // reaches the real module through the `-real` escape hatch. Storybook
          // dev IS that case, so stubbing only the public specifier would leave
          // the escape hatch pointing at a module that rejects every invoke.
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
      }
    })
}

export default config
