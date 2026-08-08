import globals from 'globals'

import shared from '../../eslint.config.shared.mjs'

// The samples live outside either app's `src/`, and an ESLint flat config only
// reaches files under its OWN directory — linting them from an app's config
// silently matches nothing. So the config sits here, and each app's `lint`
// script points at it with `--config` (which is what sets the base path).
export default [
  ...shared,
  {
    // Plugin code is React running in the app's webview, same as the surfaces
    // it contributes to. The shared config only supplies globals.node.
    files: ['**/*.{js,ts,tsx}'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node
      }
    }
  }
]
