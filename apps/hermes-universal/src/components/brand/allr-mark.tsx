/**
 * The Allr logo mark — six petals on a lamplight disc.
 *
 * Derived from `logo_base.svg`, the Inkscape master, NOT from the brand repo's
 * `icon.svg`. The latter looks like the obvious source (it is the hand-authored
 * "crisp at 16–32px, no filters" favicon variant) but its three groups sit on
 * three different centres — outer disc at 32,32, inner disc at 36,36, rosette
 * offset again — so the honey ring renders as a crescent instead of a ring.
 *
 * The master's geometry is buried under nested Inkscape transforms: a layer
 * `translate(-107.68542,-80.168747)`, a `translate(4.9724772,4.9939355)` on the
 * petal group, and a `matrix(1.0654841,0,0,1.0654841,-3.9623329,-2.1604232)` on
 * the outer disc. Resolved, both discs land exactly on the viewBox centre
 * (33.593, 33.593) with r=30.50364 and r=28.62891, and the petal coordinates
 * below are the master's shifted by (-102.712943, -75.174811). Verified by
 * rendering: full-mark ink box is centred to within 0.4%.
 *
 * The master's Gaussian blur on the outer disc is dropped. It reads as a soft
 * glow at hero size but as mud below ~48px, and it would cost a filter pass on
 * every paint — the flat annulus is what the favicon variant was reaching for.
 *
 * Fills are deliberately literal, not theme tokens: a logo does not recolour
 * with the skin. This is the one surface that looks identical in light and dark.
 */

interface AllrMarkProps {
  /** Rendered edge length in px. The art is square. */
  size?: number
  className?: string
}

export function AllrMark({ className, size = 24 }: AllrMarkProps) {
  return (
    <svg
      aria-hidden
      className={className}
      fill="none"
      height={size}
      viewBox="0 0 67.186 67.186"
      width={size}
      xmlns="http://www.w3.org/2000/svg"
    >
      <circle cx="33.593" cy="33.593" fill="#E49E35" r="30.50364" />
      <circle cx="33.593" cy="33.593" fill="#FBF1E2" r="28.62891" />
      <path
        d="m 11.7998 19.0941 c 3.89132 -5.66186 10.648 -10.096 15.2567 -11.0993 1.52085 -0.25236 3.80718 -0.49722 3.68969 1.11549 -0.48624 5.52377 -0.97247 11.5374 -1.45871 12.871 -1.82182 4.82532 -4.18703 4.68356 -6.4355 4.29034 -4.87441 -1.10857 -7.48031 -2.44398 -10.1252 -3.7755 -1.77053 -1.01728 -1.5627 -2.39616 -0.92696 -3.40207 z"
        fill="#74926B"
      />
      <path
        d="m 35.2529 7.47008 c 6.84898 0.53905 14.0674 4.1734 17.2406 7.66304 0.97898 1.19092 2.3342 3.04851 0.8788 3.75311 -5.02684 2.34079 -10.4779 4.92654 -11.876 5.17223 -5.08976 0.83491 -6.14959 -1.28429 -6.93329 -3.42814 C 33.0858 15.8547 32.9394 12.9302 32.7701 9.97389 c -0.004 -2.04197 1.29379 -2.55142 2.4828 -2.50381 z"
        fill="#F7C14C"
      />
      <path
        d="m 57.046 21.969 c 2.95766 6.20091 3.41943 14.2694 1.98391 18.7623 -0.54188 1.44328 -1.47299 3.54573 -2.81089 2.63762 -4.54061 -3.18298 -9.50549 -6.6109 -10.4173 -7.69878 -3.26795 -3.99041 -1.96257 -5.96785 -0.4978 -7.71848 3.39725 -3.66708 5.85671 -5.25614 8.33228 -6.88092 1.7664 -1.02445 2.85649 -0.15526 3.40976 0.89826 z"
        fill="#E6981A"
      />
      <path
        d="m 55.3862 48.0919 c -3.89132 5.66186 -10.648 10.096 -15.2567 11.0993 -1.52086 0.25236 -3.80719 0.49722 -3.68969 -1.11549 0.48624 -5.52377 0.97246 -11.5374 1.4587 -12.871 1.82183 -4.82533 4.18703 -4.68356 6.43551 -4.29034 4.87441 1.10856 7.4803 2.44398 10.1252 3.7755 1.7704 1.01752 1.5627 2.39616 0.92697 3.40207 z"
        fill="#F8DC8D"
      />
      <path
        d="m 31.9331 59.7159 c -6.84897 -0.53905 -14.0674 -4.1734 -17.2406 -7.66304 -0.97897 -1.19092 -2.33419 -3.04851 -0.8788 -3.75311 5.02685 -2.34079 10.478 -4.92654 11.876 -5.17223 5.08976 -0.83491 6.14959 1.2843 6.93329 3.42814 1.47716 4.77565 1.6236 7.70013 1.79292 10.6564 0.004 2.04197 -1.29379 2.55142 -2.4828 2.50381 z"
        fill="#34905E"
      />
      <path
        d="m 10.14 45.217 c -2.95766 -6.20091 -3.41943 -14.2694 -1.9839 -18.7623 0.54188 -1.44328 1.47299 -3.54573 2.81088 -2.63762 4.54061 3.18299 9.5055 6.61091 10.4173 7.69878 3.26794 3.9904 1.96256 5.96785 0.49779 7.71847 -3.39725 3.66708 -5.85671 5.25615 -8.33228 6.88093 -1.76639 1.02445 -2.85649 0.15526 -3.40976 -0.89826 z"
        fill="#9BB289"
      />
    </svg>
  )
}
