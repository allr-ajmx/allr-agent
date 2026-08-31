/**
 * Shiki's THEME CONSTANTS.
 *
 * They live alone because a caller should not have to import a highlighter
 * component to get them — that import is what kept dragging the engine back
 * into the entry chunk (MJXHRM-380). Values only: this module must never import
 * `shiki`, or it stops being cheap to reach.
 *
 * `diff-lines.tsx` is the last reader. The chat fence (ALLR-30) and the file
 * preview's source view (ALLR-40) render their own tokens instead, painted with
 * the `--code-*` custom properties in styles.css — seeded from these same two
 * themes so the surfaces still match.
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
