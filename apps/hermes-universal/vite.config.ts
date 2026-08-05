import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
// `vitest/config` is a superset of Vite's defineConfig — using it lets the test
// harness share this file's `@` alias, React plugin, and Tailwind wiring.
import { defineConfig } from 'vitest/config'

// Tauri expects a fixed dev port and a non-clearing console. For Android
// device dev the host must be reachable from the phone, so bind 0.0.0.0.
const host = process.env.TAURI_DEV_HOST

const require = createRequire(import.meta.url)
const reactDir = dirname(require.resolve('react/package.json'))

/**
 * Default label for traces, so an unlabelled capture still says where it came
 * from. `VITE_TRACE_RUN` overrides it at dev/build time and
 * `__hermesTrace.run(...)` overrides it at runtime — see src/observability/run.ts.
 *
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

export default defineConfig({
  define: {
    __TRACE_RUN_DEFAULT__: JSON.stringify(gitBranch())
  },
  plugins: [react(), tailwindcss()],
  // Tailwind v4 is handled entirely by `@tailwindcss/vite`; pin an explicit
  // empty PostCSS config so Vite doesn't walk UP the filesystem and pick up a
  // stray postcss/tailwind config from the install location (see desktop
  // vite.config.ts for the same guard).
  css: { postcss: { plugins: [] } },
  resolve: {
    alias: {
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
    dedupe: ['react', 'react-dom']
  },
  clearScreen: false,
  server: {
    host: host || '0.0.0.0',
    port: 5176,
    strictPort: true,
    hmr: host ? { protocol: 'ws', host, port: 5177 } : undefined,
    // Never watch the Rust build tree or the generated mobile projects.
    // `src-tauri/target` holds hundreds of thousands of build artifacts (every
    // cross-compile arch — Android i686, aarch64, …), and Vite recursively
    // watching it exhausts Linux's inotify watcher limit (ENOSPC). `src-tauri/gen`
    // holds the generated Android/iOS projects: during `tauri android dev`,
    // Gradle continuously rewrites files under `gen/android/build/` (e.g.
    // `reports/problems/problems-report.html`), and Vite would see each write as a
    // frontend change and fire a spurious full-page reload mid-build — resetting
    // app state to a fresh boot. Both trees are generated and gitignored; Tauri
    // already restarts the app on native changes, so the dev server has no reason
    // to look in either.
    watch: { ignored: ['**/src-tauri/target/**', '**/src-tauri/gen/**'] }
  },
  // Serves the PRODUCTION bundle from dist/. `npm run dev:prodweb` points the
  // Tauri dev shell here instead of at the dev server, so the Rust side stays in
  // dev (fast rebuilds, devtools) while the frontend is exactly what ships —
  // minified, tree-shaken, no HMR runtime, no React dev-mode double-render.
  // Fixed port so src-tauri/tauri.prodweb.conf.json's devUrl can match it;
  // 5177 is taken by HMR on device builds, 5178 left as headroom.
  preview: {
    host: host || '0.0.0.0',
    port: 5179,
    strictPort: true
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
