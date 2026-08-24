import type { Decorator, Preview } from '@storybook/react-vite'
import { QueryClientProvider } from '@tanstack/react-query'
import { HashRouter } from 'react-router-dom'

import '../src/styles.css'
import '@vscode/codicons/dist/codicon.css'
import 'katex/dist/katex.min.css'

import { ChatRuntimeProvider } from '../src/app/chat/runtime'
import { RootTooltipProvider } from '../src/components/ui/tooltip'
import { I18nProvider } from '../src/i18n'
import { queryClient } from '../src/lib/query-client'
import { $gatewayState } from '../src/store/gateway'
import { ThemeProvider } from '../src/themes'

/**
 * The provider stack, mirroring `main.tsx` plus the one thing the composer adds.
 *
 * `ChatRuntimeProvider` is not optional: `ComposerPrimitive.Root` / `.Input` /
 * `.Unstable_TriggerPopoverRoot` all read the assistant-ui runtime and throw
 * without it.
 *
 * Two providers the app mounts are deliberately absent. `ComposerScopeProvider`
 * and `SessionViewProvider` both have sensible context defaults
 * (`MAIN_COMPOSER_SCOPE`, `PRIMARY_SESSION_VIEW`), which is exactly the primary
 * chat a story wants. `HapticsProvider` is skipped so `triggerHaptic` stays the
 * no-op it already is when nothing registers a trigger.
 */
const withProviders: Decorator = Story => (
  <I18nProvider>
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <HashRouter>
          <RootTooltipProvider>
            <ChatRuntimeProvider>
              <Story />
            </ChatRuntimeProvider>
          </RootTooltipProvider>
        </HashRouter>
      </QueryClientProvider>
    </ThemeProvider>
  </I18nProvider>
)

/**
 * Nanostores are module singletons, so story state is set by writing to the
 * store rather than by aliasing the module.
 *
 * This one is load-bearing: the composer reads `$gatewayState` and renders
 * disabled — no send, no attach menu, placeholder swapped for a reconnecting
 * notice — until it is `'open'`. Left at its `'idle'` default every story would
 * show the greyed-out composer.
 */
const withOpenGateway: Decorator = Story => {
  $gatewayState.set('open')

  return <Story />
}

const preview: Preview = {
  decorators: [withProviders, withOpenGateway],
  parameters: {
    // The composer is a bottom-docked bar; a padded canvas misrepresents it.
    layout: 'fullscreen',
    controls: { matchers: { color: /(background|color)$/i } }
  }
}

export default preview
