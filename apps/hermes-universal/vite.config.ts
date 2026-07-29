import { fileURLToPath } from 'node:url'

import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
// `vitest/config` is a superset of Vite's defineConfig — using it lets the test
// harness share this file's `@` alias, React plugin, and Tailwind wiring.
import { defineConfig } from 'vitest/config'

// Tauri expects a fixed dev port and a non-clearing console. For Android
// device dev the host must be reachable from the phone, so bind 0.0.0.0.
const host = process.env.TAURI_DEV_HOST

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Tailwind v4 is handled entirely by `@tailwindcss/vite`; pin an explicit
  // empty PostCSS config so Vite doesn't walk UP the filesystem and pick up a
  // stray postcss/tailwind config from the install location (see desktop
  // vite.config.ts for the same guard).
  css: { postcss: { plugins: [] } },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  clearScreen: false,
  server: {
    host: host || '0.0.0.0',
    port: 5176,
    strictPort: true,
    hmr: host ? { protocol: 'ws', host, port: 5177 } : undefined,
    // Never watch the Rust build tree. `src-tauri/target` holds hundreds of
    // thousands of build artifacts (every cross-compile arch — Android i686,
    // aarch64, …), and Vite recursively watching it exhausts Linux's inotify
    // watcher limit (ENOSPC). Tauri already restarts the app on Rust changes,
    // so the frontend dev server has no reason to look in there.
    watch: { ignored: ['**/src-tauri/target/**'] }
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
