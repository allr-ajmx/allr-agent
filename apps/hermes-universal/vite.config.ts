import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
// `vitest/config` is a superset of Vite's defineConfig — using it lets the test
// harness share this file's `@` alias, React plugin, and Tailwind wiring.
import { defineConfig } from 'vitest/config'

// Extension-ful on purpose: Vite's `configLoader: 'native'` (the future
// default) resolves config imports through Node, which does not do extension
// inference. Without it the config loads today and warns, and stops loading
// the day that flag flips.
import { addStoreNames } from './src/observability/auto/store-names.ts'

// Tauri expects a fixed dev port and a non-clearing console.
//
// `TAURI_DEV_HOST` is the address the DEVICE dials — NOT the address this server
// binds. The two are different questions and conflating them is a trap: the CLI
// rewrites a `localhost` devUrl to a real address whenever the attached Android
// device is physical (tauri-cli `use_network_address_for_dev_url`), so on a phone
// run this is always set to something, and binding only to it would make the
// server unreachable over whichever transport it did not name. See `server` below.
const host = process.env.TAURI_DEV_HOST

const require = createRequire(import.meta.url)
const reactDir = dirname(require.resolve('react/package.json'))
// `core.js` explicitly, not `require.resolve('@tauri-apps/api/core')`. The
// package publishes no exports map, so resolution falls back to extension
// probing — and `require` probes `.cjs` first, which would alias the browser
// bundle at the CommonJS build of a module that is otherwise pure ESM.
const tauriCoreEsm = join(dirname(require.resolve('@tauri-apps/api/package.json')), 'core.js')

/**
 * Default label for traces, so an unlabelled capture still says where it came
 * from. `__hermesTrace.run(...)` overrides it at runtime — see
 * src/observability/run.ts.
 *
 * `HERMES_TRACE_RUN` names BOTH halves of a full-stack trace from one variable.
 * The Rust backend reads it from the real environment at startup; a webview has
 * no environment, so the same name has to be baked in at build time here.
 * Without this the two halves would need separate labels for the same run, and
 * the exact pair worth correlating — a frontend span and the Rust work it
 * caused — would be filed under different names in the one UI built to
 * correlate them.
 */
function traceRunDefault(): string {
  return process.env.HERMES_TRACE_RUN || gitBranch()
}

/**
 * Resolved here rather than in the app because the app cannot read git. Failure
 * is expected and silent: a tarball, a CI checkout in detached HEAD, or no git
 * at all should not break the build over a label.
 */
function gitBranch(): string {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: fileURLToPath(new URL('.', import.meta.url)),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
  } catch {
    return 'local'
  }
}

/**
 * Store autocapture, dev/bench only. Two pieces, both here because both are
 * build concerns rather than app code.
 *
 * The ALIAS points `nanostores` at our wrapper so every store write is timed,
 * covering the ~34 files that import the package directly as well as the ones
 * going through `@/store/atom`. A second alias, `nanostores-real`, resolves to
 * the actual package: the wrapper is `nanostores` as far as resolution is
 * concerned, so it cannot import itself, and the package's exports map offers no
 * deep subpath to escape through.
 *
 * The TRANSFORM gives each store a name. Every atom in the app is a module-level
 * `export const $Name = atom(...)`, so rewriting the call to pass `'$Name'` is
 * enough — and since real nanostores ignores extra arguments, the rewrite is
 * inert whenever the alias is off. Without it every span would say "anonymous",
 * which is the one thing that would make store autocapture useless.
 */
const STORE_TRACING = process.env.NODE_ENV !== 'production' || process.env.VITE_ENABLE_BENCH === 'true'

/**
 * IPC trace propagation, dev/bench only — same gate, separate concern.
 *
 * Aliases `@tauri-apps/api/core` to a wrapper that puts a W3C `traceparent` on
 * every `invoke`, so the Rust backend's spans join the frontend's trace instead
 * of forming their own. Aliased rather than hand-called because `invoke` is
 * reached from dozens of places and the point is that no call site has to know.
 *
 * `@tauri-apps/api-real/core` is the escape hatch, exactly as `nanostores-real`
 * is above: the wrapper IS the aliased specifier, so it cannot import it.
 */
const IPC_TRACING = STORE_TRACING

const storeNamePlugin = {
  enforce: 'pre' as const,
  name: 'hermes-store-names',
  transform(code: string, id: string) {
    // Test files are excluded because the transform matches raw TEXT, not
    // syntax: a spec containing `export const $x = atom(` inside a fixture
    // string is indistinguishable from the real thing. Its own tests are
    // exactly that shape. (addStoreNames is idempotent too, so this is the
    // second lock rather than the only one.)
    if (!id.includes('/src/') || !/\.tsx?$/.test(id) || /\.(test|spec)\.tsx?$/.test(id)) {
      return null
    }

    const next = addStoreNames(code)

    // `map: null` — the rewrite only ever APPENDS an argument inside an
    // existing call, so line numbers are unchanged and stack traces stay
    // truthful without a real sourcemap.
    return next === null ? null : { code: next, map: null }
  }
}

export default defineConfig({
  define: {
    __TRACE_RUN_DEFAULT__: JSON.stringify(traceRunDefault())
  },
  plugins: [react(), tailwindcss(), ...(STORE_TRACING ? [storeNamePlugin] : [])],
  // Tailwind v4 is handled entirely by `@tailwindcss/vite`; pin an explicit
  // empty PostCSS config so Vite doesn't walk UP the filesystem and pick up a
  // stray postcss/tailwind config from the install location (see desktop
  // vite.config.ts for the same guard).
  css: { postcss: { plugins: [] } },
  resolve: {
    alias: {
      // Store autocapture — see storeNamePlugin above for why this is two
      // entries. Order matters only for readability; the keys are exact.
      ...(STORE_TRACING
        ? {
            nanostores: fileURLToPath(new URL('./src/observability/auto/stores.ts', import.meta.url)),
            'nanostores-real': require.resolve('nanostores')
          }
        : {}),
      // IPC trace propagation — see IPC_TRACING above. Declared BEFORE the `@`
      // alias for the same reason the nanostores pair is: these keys are exact
      // matches, and reading them together keeps the two escape hatches in one
      // place.
      ...(IPC_TRACING
        ? {
            '@tauri-apps/api-real/core': tauriCoreEsm,
            '@tauri-apps/api/core': fileURLToPath(new URL('./src/observability/auto/tauri-core.ts', import.meta.url))
          }
        : {}),
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // The plugin SDK's public specifier. A bundled plugin writes
      // `import { host } from '@hermes/plugin-sdk'` and resolves here; a
      // runtime-loaded one gets the same object through sdk/runtime.ts's blob
      // shims. Same alias desktop's vite.config.ts declares.
      '@hermes/plugin-sdk': fileURLToPath(new URL('./src/sdk/index.ts', import.meta.url)),
      // React MUST be a singleton: sdk/runtime.ts hands plugins the app's own
      // React namespace, and a second copy reaching the bundle would break every
      // plugin hook with an unhelpful "invalid hook call".
      //
      // Resolved through Node from THIS package, not hardcoded to the workspace
      // root: npm hoists React to the root today, but any workspace whose range
      // drifts off the hoisted one gets a nested copy instead, and a root-pinned
      // alias would then hand app code one copy while react-dom keeps its peer
      // one — two dispatchers, and every hook in the test suite throws
      // "Cannot read properties of null (reading 'useCallback')". `require.resolve`
      // lands on exactly the copy react-dom resolves to, in every install layout.
      react: reactDir,
      'react-dom': dirname(require.resolve('react-dom/package.json')),
      'react/jsx-dev-runtime': join(reactDir, 'jsx-dev-runtime.js'),
      'react/jsx-runtime': join(reactDir, 'jsx-runtime.js')
    },
    // Shiki MUST be a singleton too, for size rather than correctness. Its bundle
    // entry statically pulls ~300 TextMate grammars and every bundled theme, so a
    // second copy anywhere in the graph emits the whole set twice — measured at
    // ~19.8 MB of byte-identical chunks, a third of the release bundle. That is
    // exactly what `@streamdown/code` (`shiki: ^3.19.0`) did until the root
    // package.json pinned it forward with an override; this line is the guard that
    // keeps a future nested copy from silently doing it again.
    dedupe: ['react', 'react-dom', 'shiki']
  },
  clearScreen: false,
  server: {
    // Always every interface, never `TAURI_DEV_HOST`. A phone reaches this server
    // one of two ways — through an `adb reverse` tunnel, which arrives on loopback,
    // or over Wi-Fi, which arrives on the LAN interface — and `npm run android:dev`
    // picks between them at the command line. Binding 0.0.0.0 serves both, so
    // switching transports to find the faster one never needs a config edit.
    host: '0.0.0.0',
    port: 5176,
    strictPort: true,
    // Only the CLIENT half is address-specific: this is what the HMR runtime in the
    // webview dials back on. Left `undefined` off-device so a desktop `npm run dev`
    // keeps Vite's default (infer from the page origin) rather than being pinned to
    // a port nothing is listening on.
    hmr: host ? { protocol: 'ws', host, port: 5177 } : undefined,
    // Transform the shell's entry path before the phone asks for it. On desktop this
    // is noise; over a phone link every module is a round trip, so serialising
    // "request → transform → respond" for the first few hundred modules is exactly
    // the wait being removed. Mobile files are listed alongside the shared entry
    // because the mobile shell is the surface that is slow to reach.
    warmup: {
      clientFiles: [
        './src/main.tsx',
        './src/app.tsx',
        './src/app/mobile-controller.tsx',
        './src/app/shell/mobile-shell.tsx',
        './src/app/shell/mobile-surface-shell.tsx'
      ]
    },
    // Never watch the Rust build trees or the generated mobile projects.
    // `src-tauri/target*` holds hundreds of thousands of build artifacts (every
    // cross-compile arch — Android i686, aarch64, …; the glob covers the
    // per-surface trees the dev:ext:* scripts point CARGO_TARGET_DIR at, so
    // desktop and Android never contend), and Vite recursively
    // watching it exhausts Linux's inotify watcher limit (ENOSPC). `src-tauri/gen`
    // holds the generated Android/iOS projects: during `tauri android dev`,
    // Gradle continuously rewrites files under `gen/android/build/` (e.g.
    // `reports/problems/problems-report.html`), and Vite would see each write as a
    // frontend change and fire a spurious full-page reload mid-build — resetting
    // app state to a fresh boot. Both trees are generated and gitignored; Tauri
    // already restarts the app on native changes, so the dev server has no reason
    // to look in either.
    watch: { ignored: ['**/src-tauri/target*/**', '**/src-tauri/gen/**'] }
  },
  // Serves the PRODUCTION bundle from dist/. `npm run dev:prodweb` points the
  // Tauri dev shell here instead of at the dev server, so the Rust side stays in
  // dev (fast rebuilds, devtools) while the frontend is exactly what ships —
  // minified, tree-shaken, no HMR runtime, no React dev-mode double-render.
  // Fixed port so src-tauri/tauri.prodweb.conf.json's devUrl can match it;
  // 5177 is taken by HMR on device builds, 5178 left as headroom.
  preview: {
    // 0.0.0.0 for the same reason `server.host` is — and here it is load-bearing:
    // there is no `adb reverse` mapping for 5179, so a device run of `dev:prodweb`
    // has to arrive over the LAN interface.
    host: '0.0.0.0',
    port: 5179,
    strictPort: true
  },
  // Pre-bundle the heavy dependencies that are only reachable through a dynamic
  // import, so they are ready before anything asks for them.
  //
  // The failure this prevents is specific: when Vite meets a dependency it did not
  // optimise at startup it re-runs the optimiser and RELOADS THE PAGE. A reload
  // costs a few hundred milliseconds on desktop and re-fetches the whole module
  // graph over the phone link on Android — so a lazy route silently converts
  // "navigate to Skills" into "boot the app again".
  //
  // Every entry here is a real dependency of this package that the production build
  // proves lives outside the entry chunk: the CodeMirror and xterm specifiers do not
  // appear in `index-*.js` at all, and mermaid/katex land in chunks of their own.
  // Deps reached statically from the entry (shiki, react-shiki, the assistant-ui
  // stack) are deliberately absent — the scanner already finds those on cold start,
  // and listing them would only be noise to keep in sync.
  optimizeDeps: {
    include: [
      '@codemirror/commands',
      '@codemirror/language',
      '@codemirror/language-data',
      '@codemirror/state',
      '@codemirror/view',
      '@streamdown/mermaid',
      '@xterm/addon-fit',
      '@xterm/addon-unicode11',
      '@xterm/addon-web-links',
      '@xterm/addon-webgl',
      '@xterm/xterm',
      'katex',
      'mermaid'
    ]
  },
  build: {
    // Android System WebView baseline — keep the transpile target conservative.
    target: 'es2021',
    minify: process.env.TAURI_DEBUG ? false : 'esbuild',
    sourcemap: !!process.env.TAURI_DEBUG
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
    // Components don't import CSS (styles.css is loaded once in main.tsx), so
    // skip stylesheet processing in tests.
    css: false
  }
})
