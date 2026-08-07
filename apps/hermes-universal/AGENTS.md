# Universal Engineering Guide

How to build Hermes Universal (Tauri, desktop + Android/iOS from one React app)
well. Read it with the repository `AGENTS.md` — the root rules still apply — and
with `apps/desktop/AGENTS.md`, whose seams and state rules universal shares.

When a rule here and the code disagree, trust the code and fix whichever is
wrong.

## `position: fixed` is not above the soft keyboard

On the mobile webviews Tauri embeds, the on-screen keyboard does **not**
reliably shrink the layout viewport — it is drawn over it. `bottom: 0` therefore
means "the bottom of the screen, behind the keyboard", not "the bottom of what
the user can see".

`hooks/use-keyboard-inset.ts` measures the real geometry off the Visual Viewport
API and publishes it to `:root`:

| var / attribute            | meaning                                       |
| -------------------------- | --------------------------------------------- |
| `--keyboard-inset`         | px the keyboard occludes at the bottom         |
| `--visual-viewport-height` | height of the actually-visible region          |
| `--visual-viewport-top`    | its offset from the top of the layout viewport |
| `data-keyboard-open`       | on `<html>` while the keyboard is up (`keyboard-open:` variant) |

The mobile shells lift their **in-flow** content with
`margin-bottom: var(--keyboard-inset)`, so anything rendered inside a shell is
handled for free. Two kinds of element are not:

1. **Anything `position: fixed`.** It is positioned against the layout viewport
   and the shell's margin never reaches it. Anchor it with
   `bottom: var(--keyboard-inset, 0px)`, or size it from
   `--visual-viewport-height` / `--visual-viewport-top` when it must fill the
   visible region.
2. **Anything in a portal** — every Radix overlay (`Sheet`, `Dialog`,
   `Popover`, `DropdownMenu`) mounts on `<body>`, outside the lifted subtree,
   even when the JSX sits inside a shell.

`SheetContent side="bottom"` already does this; a bottom sheet needs nothing
extra. A new fixed or portalled surface that can hold a focused field does — and
the bug is invisible on desktop, where these vars are absent and resolve to 0.

Pair the lift with a ceiling: a surface lifted by the keyboard can otherwise run
off the top of the screen with no way to scroll back to it. `max-height:
calc(var(--visual-viewport-height, 100vh) - <gutter>)` plus `overflow-y: auto`.

Same shape, different inset: `lib/safe-area.ts` republishes
`--safe-area-inset-*` because the webviews resolve `env()` a few frames late.
Read the vars, never `env()` directly. Note that a chrome bar which already
lifts by `--keyboard-inset` should not also pad by the bottom safe-area inset —
the home indicator is behind the keyboard, and counting both leaves a dead band.
