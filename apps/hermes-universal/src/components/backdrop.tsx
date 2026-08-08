import { useStore } from '@nanostores/react'

import backdropArt from '@/assets/filler-bg0.webp'
import { $backdrop } from '@/store/backdrop'

/**
 * The faint statue image behind the conversation. Ported from desktop
 * `components/Backdrop.tsx`; the only change is the asset, which universal
 * imports through Vite (it has no `public/` dir) and ships as a WebP
 * re-encode of desktop's 3.9 MB JPEG — at 2.5% opacity under
 * `mix-blend-difference` the extra bytes bought nothing visible.
 */
export function Backdrop() {
  const on = useStore($backdrop)

  if (!on) {
    return null
  }

  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 z-2 opacity-[0.025] mix-blend-difference">
      <img
        alt=""
        className="h-[160dvh] w-auto min-w-dvw object-cover object-left-top [filter:invert(var(--backdrop-invert-mul,1))]"
        fetchPriority="low"
        src={backdropArt}
      />
    </div>
  )
}
