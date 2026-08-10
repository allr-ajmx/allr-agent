import 'katex/dist/katex.min.css'
import '@vscode/codicons/dist/codicon.css'
import './styles.css'
// Dev-only render counter. MUST precede the `react-dom` import below: react-dom
// captures the devtools hook at module init, so bippy has to install during THIS
// import's evaluation or every commit goes unseen. `vite.config.ts` aliases this
// specifier to a no-op module for non-dev builds, so neither the counter nor
// bippy reaches a shipped renderer.
import '@/debug/dev-only'
// Side-effect import: the hermes-media:// scheme handler lives in Rust and can't
// read the connection store, so this subscription pushes the gateway target in.
import './lib/media-stream'
// Side-effect import: the gateway event router must be listening before any
// connection is opened below. It self-registers, so this import IS the wiring.
import './store/event-router'
// Likewise: every WebView must be listening for another WebView's gateway switch
// before it dials, or it keeps serving the gateway the user just moved off.
import './store/gateway-switch-sync'
// Likewise again: `preview.read.request` / `window.read.request` park a running
// agent tool until the client answers, so the responder has to be listening
// before the first turn — see store/agent-read-requests.ts.
import './store/agent-read-requests'

import { installWindowBelowReader } from './store/window-below'

// And the reader that gives `window.read.request` something to say. Installed at
// boot, next to the responder it feeds, because the first turn can ask before
// any component has mounted (MJXHRM-213).
installWindowBelowReader()

import { QueryClientProvider } from '@tanstack/react-query'
import { createRoot } from 'react-dom/client'
import { HashRouter } from 'react-router-dom'

import { App } from './app'
import { RootErrorBoundary } from './components/error-boundary'
import { HapticsProvider } from './components/haptics-provider'
import { RootTooltipProvider } from './components/ui/tooltip'
import { I18nProvider } from './i18n'
import { warmKatexFonts } from './lib/katex-fonts'
import { IS_MOBILE } from './lib/platform'
import { queryClient } from './lib/query-client'
import { initSafeAreaInsets } from './lib/safe-area'
import { restoreSessionCookies } from './lib/session-persist'
import { installObservability } from './observability/install'
import { autoRestoreConnection } from './store/gateway-restore'
import { initKeepAwake } from './store/keep-awake'
import { ThemeProvider } from './themes'

// Span tracing. Installed FIRST so boot-time work falls inside the trace rather
// than before it. Recording is off by default, so this is a no-op until someone
// asks for it — see src/observability/index.ts.
installObservability()

// Rehydrate a persisted gateway/cloud session into the Rust cookie jar (R2b), THEN
// auto-reconnect to the last-used gateway (D8). Cookies first so a cookie-backed
// login (ticket/oauth/cloud) re-dials without an interactive sign-in; the restore
// runs even if the cookie read fails (it degrades to a fresh sign-in). `$restoring`
// is seeded true synchronously from the saved target, so the connecting screen —
// not the picker — shows from the first paint while this resolves.
void restoreSessionCookies().finally(() => {
  void autoRestoreConnection()
})

// The keep-awake preference lives in the webview but the inhibitor lives in
// Rust and dies with the process, so a relaunch has to re-arm it — otherwise the
// toggle reads "on" while the machine is free to sleep. No-op off desktop.
initKeepAwake()

// Pull KaTeX's faces in at idle. They are `font-display: block`, so the first
// equation of a session otherwise renders INVISIBLE until they land (see
// lib/katex-fonts).
warmKatexFonts()

// Publish deterministic `--safe-area-inset-*` CSS vars so mobile chrome sits
// correctly from the first frame instead of flashing at the 0 that env()
// reports before the webview resolves it (see lib/safe-area). No-op on web/
// desktop. Mark the platform so mobile-only CSS can key off `html.is-mobile`.
initSafeAreaInsets()
document.documentElement.classList.toggle('is-mobile', IS_MOBILE)

const container = document.getElementById('root')

if (!container) {
  throw new Error('root container missing')
}

createRoot(container).render(
  <RootErrorBoundary>
    <I18nProvider>
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <HapticsProvider>
            {/* ONE tooltip provider for the whole app. Every `Tip` used to carry
                its own, and with ~100 call sites those subtrees dominated
                unrelated interactions. Radix's provider holds only refs and
                stable callbacks, so hoisting is what it is for. */}
            <RootTooltipProvider>
              <HashRouter>
                <App />
              </HashRouter>
            </RootTooltipProvider>
          </HapticsProvider>
        </QueryClientProvider>
      </ThemeProvider>
    </I18nProvider>
  </RootErrorBoundary>
)
