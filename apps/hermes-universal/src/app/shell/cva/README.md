# Mobile shell CVA conventions (MJXHRM-310)

CVA port of Penpot Mobile Shell 2 into Hermes Universal. Penpot is **layout /
density / state inspiration only** — icons stay the app’s existing packs.

## Canon

Follow `components/ui/button.tsx` and `control.ts`:

- `cva(...)` + `VariantProps` + `cn(...)`
- Export `*Variants` beside the component (same file or `shell/cva/*.ts`)
- Set `data-slot`, and `data-variant` / `data-state` when variants exist

## Variant axes

| Axis | Values | Used by |
|------|--------|---------|
| `state` | `default` \| `active` \| `selected` \| `disabled` | rows, triggers, chrome controls |
| `active` | `true` \| `false` | TabButton, TitlebarButton pressed |
| `slot` | `left` \| `center` \| `right` | ChromeBar / TopBar cells |
| `density` | `mobile` \| `desktop` | TitlebarButton hit size |
| `badge` | `none` \| `dot` \| `count` | TabButton |

## Icons (hard rule)

| Surface | Pack | Import |
|---------|------|--------|
| Shell chrome, nav, workspace tabs | **Codicon** | `@/components/ui/codicon` |
| Ported desktop overlays / settings | **Tabler** | `@/lib/icons` |
| In-thread tool glyphs | **ToolIcon** | `@/components/ui/tool-icon` |

Do **not** adopt Penpot placeholder glyphs, Lucide, or new icon packs. Map any
Penpot icon slot to an existing Codicon/Tabler name.

## Tokens (reuse — do not invent a parallel palette)

| Token / var | Role |
|-------------|------|
| `--ui-bg-chrome` | Chrome / tab bar fill |
| `--ui-stroke-tertiary` | Chrome hairlines |
| `--ui-accent-primary` | Active tab bar, badges |
| `--chrome-action-hover` / `--ui-control-hover-background` | Ghost control hover |
| `--ui-control-active-background` | Pressed / active chrome control |
| `--safe-area-inset-*` | Notch / home indicator (`lib/safe-area.ts`) |
| `--keyboard-inset`, `--visual-viewport-*` | Soft keyboard (`use-keyboard-inset`) |

Shared class strings live in `tokens.ts`. Hit-target helpers in `hit.ts`
(≥44px on coarse pointers; CSS already floors `[data-slot=button]`).

## Contracts (from `apps/hermes-universal/AGENTS.md`)

- Phone `#root` IS the visible rect (`--visual-viewport-top`/`-height`); in-flow
  shell content needs no keyboard lift of its own
- Fixed / portalled surfaces anchor with `bottom: var(--keyboard-inset)`
- Chrome bar owns **top** safe-area only; tab bar owns **bottom**
- Do not double-count bottom safe-area with keyboard lift
- Phone Sessions / Workspace stay **full-screen** siblings (not dimmed drawers)

## Ticket ladder

Phase 0 = this folder. Phase 1 = C1–C21 component CVA. Phase 2 = V1–V16 wiring.
Phase 3 (MJXHRM-348) = typecheck / vitest / mobile smoke — **only** then.
