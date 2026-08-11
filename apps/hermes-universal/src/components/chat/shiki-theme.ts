/**
 * Shiki's THEME CONSTANTS, split out from `shiki-highlighter.tsx`.
 *
 * They live alone because `diff-lines.tsx` and the preview pane both need them
 * and neither should have to import the highlighter component to get them —
 * that import is what kept dragging the engine back into the entry chunk
 * (MJXHRM-380). Values only: this module must never import `shiki` or
 * `react-shiki`, or it stops being cheap to reach.
 */

// `github-dark-dimmed` is GitHub's lower-contrast dark palette — the vivid
// `github-dark-default` tokens read harsh at our small code size. Shared by the
// inline diff renderer too (see diff-lines.tsx) so code + diffs match.
export const SHIKI_THEME = { dark: 'github-dark-dimmed', light: 'github-light-default' } as const

// `github-light-default` colors comments `#6e7781` — borderline unreadable at
// our 11px code size. Remap light-mode comments to GitHub's darker muted gray.
export const SHIKI_COLOR_REPLACEMENTS: Record<string, Record<string, string>> = {
  'github-light-default': { '#6e7781': '#57606a' }
}
