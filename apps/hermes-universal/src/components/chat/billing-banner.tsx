import { StatusRow } from '@/components/chat/status-row'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { useStoreSelector } from '@/lib/use-session-slice'
import { $billingBlock, billingCtaLabel, clearBillingBlock, runBillingRecovery } from '@/store/billing-block'

function firstLine(text: string): string {
  return (text || '').split('\n')[0]?.trim() ?? ''
}

/**
 * Persistent, in-stack billing wall for THIS session. Rendered as a shared
 * {@link StatusRow} — same chrome as its status-stack siblings, so it reads as
 * one piece with the composer card (no bordered alert-in-a-card). It never
 * disables the composer — slash commands (`/topup`, `/model`, `/login`) stay
 * usable — it only offers recovery: Nous opens Settings → Billing in-app, other
 * providers deep-link out. The sticky toast is the loud surface; this is the calm
 * reminder that outlives it.
 *
 * Ported from apps/desktop/src/components/billing-banner.tsx.
 */
export function BillingBanner({ sessionId }: { sessionId: null | string }) {
  // Narrowed to THIS session (MJXHRM-381): the banner mounts once per tile, so a
  // whole-atom read re-rendered every mounted banner whenever any session's wall
  // was raised or cleared. The selector returns the store's own object or `null`,
  // so unrelated sessions' snapshots compare equal and never re-render.
  const active = useStoreSelector($billingBlock, block =>
    block && sessionId && block.sessionId === sessionId ? block : null
  )

  const { t } = useI18n()

  // `active` is non-null only when it matched `sessionId`; the second half is
  // for the type-checker (and for `clearBillingBlock` below, which needs a key).
  if (!active || !sessionId) {
    return null
  }

  const { block } = active
  const copy = t.billingBlock
  const title = block.is_nous ? copy.titleNous : copy.titleProvider(block.provider_label)
  const message = firstLine(block.message) || copy.fallbackMessage

  return (
    <StatusRow
      leading={<Codicon aria-hidden className="text-destructive/85" name="credit-card" size="0.8rem" />}
      trailing={
        <>
          <Button
            className="text-foreground/90 hover:text-foreground"
            onClick={() => runBillingRecovery(block)}
            size="micro"
            type="button"
            variant="text"
          >
            {billingCtaLabel(block, copy)}
          </Button>
          <Tip label={copy.dismiss}>
            <Button
              aria-label={copy.dismiss}
              className="size-4 rounded-md text-muted-foreground/60 hover:text-foreground/90"
              onClick={() => clearBillingBlock(sessionId)}
              size="icon-xs"
              type="button"
              variant="ghost"
            >
              <Codicon name="close" size="0.75rem" />
            </Button>
          </Tip>
        </>
      }
      trailingVisible
    >
      <span className="min-w-0 truncate text-[0.73rem] leading-4 text-foreground/92">
        <span className="font-medium">{title}</span>
        {message && <span className="text-muted-foreground/80"> · {message}</span>}
      </span>
    </StatusRow>
  )
}
