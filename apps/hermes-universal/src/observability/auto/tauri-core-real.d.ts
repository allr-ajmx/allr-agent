/**
 * Types for the escape-hatch specifier.
 *
 * `@tauri-apps/api-real/core` is an alias declared in vite.config.ts pointing at
 * the real module's resolved path. It exists for the same reason
 * `nanostores-real` does: the wrapper beside this file IS `@tauri-apps/api/core`
 * as far as the bundler is concerned, so a plain import of that specifier inside
 * it would resolve to itself.
 */
declare module '@tauri-apps/api-real/core' {
  export * from '@tauri-apps/api/core'
}
