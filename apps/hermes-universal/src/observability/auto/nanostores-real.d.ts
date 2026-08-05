/**
 * Types for the escape-hatch specifier.
 *
 * `nanostores-real` is an alias declared in vite.config.ts pointing at the real
 * package's resolved path. It exists because the wrapper beside this file IS
 * `nanostores` as far as the bundler is concerned — a plain
 * `import { atom } from 'nanostores'` inside it would resolve to itself.
 *
 * The obvious escape (`nanostores/index.js`) is not available: the package
 * publishes an exports map with only `"."` and `"./package.json"`, so a deep
 * subpath import is refused. A second alias to the absolute path is the way
 * through, and this declaration is what tells TypeScript the specifier is real.
 */
declare module 'nanostores-real' {
  export * from 'nanostores'
}
