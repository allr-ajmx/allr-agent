import { Codicon } from './codicon'

interface ColorSwatchesProps {
  swatches: readonly string[]
  value: null | string
  onChange: (color: null | string) => void
  clearLabel: string
  clearIcon?: string
  swatchLabel?: (color: string) => string
}

// Shared swatch grid + clear row used by the profile rail, so color picking looks
// and behaves identically everywhere. Ported verbatim from desktop.
export function ColorSwatches({
  swatches,
  value,
  onChange,
  clearLabel,
  clearIcon = 'circle-slash',
  swatchLabel
}: ColorSwatchesProps) {
  return (
    <div>
      <div className="grid grid-cols-6 gap-1.5">
        {swatches.map(swatch => (
          <button
            aria-label={swatchLabel?.(swatch) ?? swatch}
            // The grow-on-hover is a MOUSE affordance. A finger has no hover to
            // trigger it, and where this grid sits in the top drawer the panel
            // CLIPS (`overflow: hidden` on `[data-top-drawer]`), so a sticky
            // hover on the edge column only pushes a swatch under the frame.
            // Scoped with `fine:` rather than undone with `coarse:` — the two
            // queries are exclusive, so there is no source-order fight, and
            // jsdom (which matches neither) sees the touch behaviour. See the
            // coarse/fine block at the top of `styles.css`.
            className="size-5 rounded-full transition-transform fine:hover:scale-110"
            key={swatch}
            onClick={() => onChange(swatch)}
            style={{
              backgroundColor: swatch,
              boxShadow: swatch === value ? '0 0 0 2px var(--ui-bg-elevated), 0 0 0 3.5px currentColor' : undefined,
              color: swatch
            }}
            type="button"
          />
        ))}
      </div>
      <button
        className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-md py-1 text-xs text-(--ui-text-tertiary) transition hover:bg-(--ui-control-hover-background) hover:text-foreground"
        onClick={() => onChange(null)}
        type="button"
      >
        <Codicon name={clearIcon} size="0.75rem" />
        {clearLabel}
      </button>
    </div>
  )
}
