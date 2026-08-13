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
  /(^|:)(arc-border|aui-(md|md-table|prose-fence|shiki)|brand|chat|codicon(-modifier-spin)?|composer-bars|connect(-card|-title)?|desktop-input-chrome|dither|katex-host|particle(-field|__glyph|__sway)?|progress-slide|quest-glow|reaction-pop|ref|scrollbar-overlay|shimmer|sticky-human-clamp|thinking-preview|thread-jump-button|tool-group-scroll(--faded)?|tool-ticker(__reel|__row)?|wake-indicator(-light|-surface)?)$/

// ponytail: quarantined debt, not exemptions — these resolve to nothing today.
// Listing them keeps the rule at `error` so a NEW typo fails the build now,
// instead of drowning in a wall of pre-existing warnings nobody reads.
//
// These are orphaned hooks whose CSS never came across in the desktop port.
// Fix = delete the class from the JSX, or write the rule it is asking for.
//
// `(^|:)` not `^`: the rule reports a class with its variant chain attached
// (`data-[state=open]:animate-in`), so an `^`-anchored pattern silently never
// matches the ones that carry a variant.
const KNOWN_DEAD_CLASSES =
  /(^|:)(aui-button-icon|checkpoint-(container|divider|icon|restore-text)|coding-status-bar|composer-(fallback-surface|human-ai-pair-container|human-message-container)|font-code|good|human-(execution-message-top|message-with-todos-wrapper)|muted|ui-prompt-input(__container|-editor__input))$/

// MJXHRM-429 converted ~350 physical direction utilities to their logical
// equivalents so the app lays out right-to-left under `dir=rtl`. Nothing
// otherwise stops one growing back: `pl-2` is not a typo, `no-unknown-classes`
// resolves it happily, and it looks correct to anyone reading in English.
//
// Reported at `error`, never `warn`. A warning here runs and cannot fail, which
// is indistinguishable from the rule not being installed at all.
//
// Physical is still RIGHT in a few places, and each of those carries its own
// `eslint-disable-next-line` with the reason: a `left-1/2` paired with a
// physical `-translate-x-1/2` (that pair is centring, and already
// direction-agnostic), the popover arrow's rotated-square borders, and chrome
// floating over surfaces pinned left-to-right (code, diffs, logs, the
// terminal). Each is a judgement about one component, so it is written down
// there rather than blanket-ignored here.
//
// `(^|.*:)` not `^`: the rule reports a class with its whole variant chain
// attached, so `^pl-` would silently miss `group-hover:pl-2`. The greedy prefix
// is also what puts the FULL class name in `$0` for the message.
// The fourth column is the BOUNDARY after the physical head, and it is
// load-bearing: a bare `rounded-l(.*)` also matches `rounded-lg`, and
// `border-r(.*)` also matches `border-ring` — 59 false positives across the app
// the first time this table was written without it.
const PHYSICAL_DIRECTION_CLASSES = [
  ['ml-', 'ms-', '(.*)', 'margin', 'ms-/me-'],
  ['mr-', 'me-', '(.*)', 'margin', 'ms-/me-'],
  ['pl-', 'ps-', '(.*)', 'padding', 'ps-/pe-'],
  ['pr-', 'pe-', '(.*)', 'padding', 'ps-/pe-'],
  ['left-', 'start-', '(.*)', 'inset', 'start-/end-'],
  ['right-', 'end-', '(.*)', 'inset', 'start-/end-'],
  ['scroll-ml-', 'scroll-ms-', '(.*)', 'scroll margin', 'scroll-ms-/scroll-me-'],
  ['scroll-mr-', 'scroll-me-', '(.*)', 'scroll margin', 'scroll-ms-/scroll-me-'],
  ['scroll-pl-', 'scroll-ps-', '(.*)', 'scroll padding', 'scroll-ps-/scroll-pe-'],
  ['scroll-pr-', 'scroll-pe-', '(.*)', 'scroll padding', 'scroll-ps-/scroll-pe-'],
  ['border-l', 'border-s', '($|-.*)', 'border', 'border-s/border-e'],
  ['border-r', 'border-e', '($|-.*)', 'border', 'border-s/border-e'],
  ['rounded-l', 'rounded-s', '($|-.*)', 'radius', 'rounded-s/rounded-e'],
  ['rounded-r', 'rounded-e', '($|-.*)', 'radius', 'rounded-s/rounded-e'],
  ['text-left', 'text-start', '($)', 'alignment', 'text-start/text-end'],
  ['text-right', 'text-end', '($)', 'alignment', 'text-start/text-end'],
  ['float-left', 'float-start', '($)', 'float', 'float-start/float-end'],
  ['float-right', 'float-end', '($)', 'float', 'float-start/float-end']
].map(([physical, logical, boundary, noun, hint]) => ({
  fix: `$1${logical}$2`,
  message: `Physical ${noun} "$0" — use ${hint} so it mirrors under dir="rtl".`,
  pattern: `(^|.*:)${physical}${boundary}`
}))

export default [
  ...shared,
  {
    // Two rules, not the plugin's `recommended` set. Tailwind class names are
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
    rules: {
      'better-tailwindcss/no-restricted-classes': ['error', { restrict: PHYSICAL_DIRECTION_CLASSES }],
      'better-tailwindcss/no-unknown-classes': 'error'
    },
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
    // `@tauri-apps/plugin-opener`'s JS commands are ACL-scoped, and this app
    // declares NO opener scope (see `src-tauri/capabilities/default.json`, which
    // grants `opener:allow-open-url` — "without any pre-configured scope").
    // `open_url` then answers `Err(ForbiddenUrl)` for every url, on every
    // platform, because nothing is on the allow-list. The failure is silent: the
    // call rejects, callers treat that as "this platform can't open urls", and
    // nothing looks broken. It has already cost this repo twice — once for OAuth
    // sign-in and docs links, once for `ctx.os.openExternal`.
    //
    // The app's own native `open_external` / `reveal_in_file_manager` commands
    // call the plugin's RUST api, which is not scope-checked. Use those, via
    // `lib/external-link` and `lib/reveal-path`.
    files: ['**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              message:
                'ACL-scoped and always forbidden here (no opener scope is declared). Use tryOpenExternalLink/openExternalLink from @/lib/external-link, or tryRevealPathInFileManager from @/lib/reveal-path — both go through the native Rust commands.',
              name: '@tauri-apps/plugin-opener'
            }
          ]
        }
      ]
    }
  },
  {
    // The perf bench is a plain script served straight to the browser, not part
    // of the app's module graph — it has no TS build step and legitimately uses
    // script-scope globals.
    ignores: ['bench/**']
  }
]
