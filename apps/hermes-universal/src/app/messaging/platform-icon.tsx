import {
  SiApple,
  SiBilibili,
  SiDiscord,
  SiGmail,
  SiHomeassistant,
  SiMatrix,
  SiMattermost,
  SiQq,
  SiSignal,
  SiTelegram,
  SiWechat,
  SiWhatsapp
} from '@icons-pack/react-simple-icons'
import type { ComponentType, SVGProps } from 'react'
import { memo } from 'react'

import { Globe, Link as LinkIcon, MessageSquareText } from '@/lib/icons'
import { cn } from '@/lib/utils'

// We render simpleicons.org brand glyphs for platforms whose owners publish a
// usable mark (telegram, discord, matrix, ...). A few brands — Slack, Dingtalk,
// Feishu, WeCom — have been removed from Simple Icons at the brand owner's
// request, so we fall back to a colored letter monogram for those.
//
// `iconColor` is the brand's hex from simpleicons.org so we can paint each
// glyph in its native color on top of a soft tint. The fallback monogram uses
// the same hex to keep visual consistency.
type IconKind = 'brand' | 'generic'

// ---------------------------------------------------------------------------
// Photon brand icon — three diagonal rounded bars (the Photon logo mark).
// Rendered at ~14 px inside the PlatformAvatar so the bars are kept thick
// enough to stay legible. At small sizes they blend into a distinctive
// silhouette; the wide triangular spacing preserves the logo's identity.
//
// Hand-rolled on purpose. Simple Icons DOES ship an `SiPhoton`, but it is
// Photon Engine (the Unity networking company, brand hex #004480) — a
// completely unrelated product. Using it would put another company's mark on
// the iMessage channel. Ported from apps/desktop.
// ---------------------------------------------------------------------------
function PhotonIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg fill="currentColor" viewBox="0 0 24 24" {...props}>
      <rect height="10" rx="1.25" transform="rotate(15 14 7.5)" width="2.5" x="12.75" y="2.5" />
      <rect height="10" rx="1.25" transform="rotate(15 8 13)" width="2.5" x="6.75" y="8" />
      <rect height="10" rx="1.25" transform="rotate(15 16 18)" width="2.5" x="14.75" y="13" />
    </svg>
  )
}

interface PlatformIconSpec {
  Icon?: ComponentType<SVGProps<SVGSVGElement>>
  color: string
  kind: IconKind
  monogram?: string
}

const PLATFORM_ICONS: Record<string, PlatformIconSpec> = {
  telegram: { Icon: SiTelegram, color: '#26A5E4', kind: 'brand' },
  discord: { Icon: SiDiscord, color: '#5865F2', kind: 'brand' },
  // Slack removed from Simple Icons by Salesforce request — letter monogram.
  slack: { color: '#4A154B', kind: 'brand', monogram: 'S' },
  mattermost: { Icon: SiMattermost, color: '#0058CC', kind: 'brand' },
  matrix: { Icon: SiMatrix, color: '#000000', kind: 'brand' },
  signal: { Icon: SiSignal, color: '#3A76F0', kind: 'brand' },
  whatsapp: { Icon: SiWhatsapp, color: '#25D366', kind: 'brand' },
  bluebubbles: { Icon: SiApple, color: '#0BD318', kind: 'brand' },
  photon: { Icon: PhotonIcon, color: '#6366F1', kind: 'brand' },
  // Buzz (Block's Nostr-based community platform). Simple Icons ships no Buzz
  // and no Nostr mark, and drawing something plausible would put an INVENTED
  // logo on a real brand — so this takes the monogram path the file already
  // documents for Slack. The violet is Nostr's conventional accent, chosen to
  // sit apart from the other entries, not claimed as a brand hex.
  buzz: { color: '#7C3AED', kind: 'brand', monogram: 'B' },
  homeassistant: { Icon: SiHomeassistant, color: '#18BCF2', kind: 'brand' },
  email: { Icon: SiGmail, color: '#EA4335', kind: 'brand' },
  sms: { Icon: MessageSquareText, color: '#F43F5E', kind: 'generic' },
  webhook: { Icon: LinkIcon, color: '#71717A', kind: 'generic' },
  api_server: { Icon: Globe, color: '#64748B', kind: 'generic' },
  weixin: { Icon: SiWechat, color: '#07C160', kind: 'brand' },
  qqbot: { Icon: SiQq, color: '#EB1923', kind: 'brand' },
  yuanbao: { Icon: SiBilibili, color: '#FB7299', kind: 'brand' }
}

interface PlatformAvatarProps {
  platformId: string
  platformName: string
  className?: string
}

/** Memoized (desktop parity): every prop is a string, and the avatar is list
 *  rendered — once per messaging platform in the sidebar group headers and the
 *  platform table — so it holds cleanly whenever the list re-renders around it. */
export const PlatformAvatar = memo(function PlatformAvatar({
  className,
  platformId,
  platformName
}: PlatformAvatarProps) {
  const spec = PLATFORM_ICONS[platformId]

  const baseClass = cn(
    'inline-grid size-6 shrink-0 place-items-center rounded-md text-[length:var(--conversation-caption-font-size)] font-medium',
    className
  )

  if (!spec) {
    return (
      <span aria-hidden="true" className={cn(baseClass, 'bg-(--ui-bg-tertiary) text-(--ui-text-tertiary)')}>
        {platformName.charAt(0).toUpperCase()}
      </span>
    )
  }

  const { Icon, color } = spec

  return (
    <span
      aria-hidden="true"
      className={baseClass}
      style={{
        // 16% tint of the brand color so the glyph reads against any surface
        // without the avatar dominating the row.
        backgroundColor: `color-mix(in srgb, ${color} 16%, transparent)`,
        color
      }}
    >
      {Icon ? <Icon className="size-3.5" /> : spec.monogram || platformName.charAt(0).toUpperCase()}
    </span>
  )
})

interface PlatformGlyphProps {
  platformId: string
  platformName: string
  /** Grey the glyph out (e.g. platform not connected). */
  muted?: boolean
  className?: string
}

/** A bare platform glyph (no avatar chip) painted in its brand color, or greyed
 *  when `muted` — for compact status rows that show several at once. */
export function PlatformGlyph({ className, muted = false, platformId, platformName }: PlatformGlyphProps) {
  const spec = PLATFORM_ICONS[platformId]
  const cls = cn('inline-flex size-4 shrink-0 items-center justify-center', className)

  if (!spec) {
    return (
      <span aria-hidden="true" className={cn(cls, 'text-[0.6rem] font-semibold text-(--ui-text-tertiary)')}>
        {platformName.charAt(0).toUpperCase()}
      </span>
    )
  }

  return (
    <span aria-hidden="true" className={cls} style={{ color: muted ? 'var(--ui-text-tertiary)' : spec.color }}>
      {spec.Icon ? (
        <spec.Icon className="size-3.5" />
      ) : (
        <span className="text-[0.6rem] font-semibold">{spec.monogram || platformName.charAt(0).toUpperCase()}</span>
      )}
    </span>
  )
}
