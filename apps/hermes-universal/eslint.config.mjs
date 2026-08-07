import betterTailwind from 'eslint-plugin-better-tailwindcss'
import globals from 'globals'

import shared from '../../eslint.config.shared.mjs'

// Real classes the rule cannot see: plain `.foo {}` rules in styles.css (it only
// resolves Tailwind utilities and `@layer components`), and vendor CSS imported
// at runtime rather than through the entry point (@vscode/codicons). Each name
// below was checked against the app's CSS before being listed — this list is for
// classes that EXIST, never for silencing a hit.
// `(^|:)` not `^`: the rule reports a class with its variant chain attached
// (`data-[state=open]:animate-in`), so an `^`-anchored pattern silently never
// matches the ones that carry a variant.
const HAND_WRITTEN_CSS_CLASSES =
  /(^|:)(arc-border|aui-(md|md-table|prose-fence|shiki)|brand|chat|codicon(-modifier-spin)?|composer-bars|connect(-card|-title)?|desktop-input-chrome|dither|katex-host|particle(-field|__glyph|__sway)?|progress-slide|quest-glow|shimmer|sticky-human-clamp|thinking-preview|thread-jump-button|tool-group-scroll(--faded)?)$/

// ponytail: quarantined debt, not exemptions — these resolve to nothing today.
// Listing them keeps the rule at `error` so a NEW typo fails the build now,
// instead of drowning in a wall of pre-existing warnings nobody reads.
//
// The `animate-*`/`fade-*`/`zoom-*`/`slide-*` group is shadcn's overlay
// enter/exit animation vocabulary, which lives in the `tw-animate-css` package —
// not a dependency of this app OR of apps/desktop, and not hand-defined in
// either stylesheet. Every dialog, sheet, popover, tooltip and dropdown in the
// app is therefore un-animated. Fix = `npm i -D tw-animate-css` + one
// `@import 'tw-animate-css'` in styles.css, then drop the group from here.
//
// The rest are orphaned hooks whose CSS never came across in the desktop port.
// Fix = delete the class from the JSX, or write the rule it is asking for.
const KNOWN_DEAD_CLASSES =
  /(^|:)(animate-(in|out)|fade-(in|out)-0|zoom-(in|out)-95|slide-in-from-(top|right|bottom|left)(-1|-2)?|slide-out-to-(top|right|bottom|left)|aui-button-icon|checkpoint-(container|divider|icon|restore-text)|coding-status-bar|composer-(fallback-surface|human-ai-pair-container|human-message-container)|font-code|good|human-(execution-message-top|message-with-todos-wrapper)|muted|ui-prompt-input(__container|-editor__input))$/

export default [
  ...shared,
  {
    // One rule, not the plugin's `recommended` set. Tailwind class names are
    // just strings: `cn()` is clsx + twMerge, and twMerge forwards anything it
    // does not recognise, so an invented utility compiles, ships and silently
    // does nothing — `align-left` (there is no such utility; `align-*` is
    // vertical-align) sat in the title trigger looking like it left-aligned the
    // text. Nothing in tsc, vite or the rest of eslint can see it. This rule
    // resolves every class against the real stylesheet, so a typo is an error.
    //
    // The plugin's stylistic rules (class order, line wrapping) are deliberately
    // left off: they rewrite every className in the app and none of them can
    // catch a bug.
    files: ['**/*.{ts,tsx}'],
    ignores: ['**/*.test.{ts,tsx}'],
    plugins: { 'better-tailwindcss': betterTailwind },
    rules: { 'better-tailwindcss/no-unknown-classes': 'error' },
    // Tailwind v4 has no config file — the utilities are whatever this CSS
    // entry point and its `@utility` blocks define.
    settings: {
      'better-tailwindcss': {
        detectComponentClasses: true,
        entryPoint: 'src/styles.css',
        ignore: [HAND_WRITTEN_CSS_CLASSES, KNOWN_DEAD_CLASSES]
      }
    }
  },
  {
    // Universal is a Tauri webview (desktop + Android + iOS), so it uses browser
    // globals throughout. The shared config only supplies globals.node, so that
    // terminal-only workspaces (ui-tui) don't silently get DOM types — same
    // re-addition apps/desktop makes for the Electron renderer.
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node
      }
    }
  },
  {
    // The perf bench is a plain script served straight to the browser, not part
    // of the app's module graph — it has no TS build step and legitimately uses
    // script-scope globals.
    ignores: ['bench/**']
  }
]
