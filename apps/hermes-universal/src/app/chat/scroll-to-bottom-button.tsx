import { useRef } from 'react'

import { useSessionView } from '@/app/chat/session-view'
import { Codicon } from '@/components/ui/codicon'
import { useI18n } from '@/i18n'
import { triggerHaptic } from '@/lib/haptics'
import { cn } from '@/lib/utils'
import { useStore } from '@/store/atom'
import { sessionApprovalRequest } from '@/store/prompts'
import { requestScrollToBottom, sessionThreadJumpVisible } from '@/store/thread-scroll'

/**
 * Floating "jump to bottom" control. Sits centered just above the composer,
 * clearing the out-of-flow status stack via the same measured-height CSS vars
 * the thread's bottom clearance uses (`--composer-measured-height` +
 * `--status-stack-measured-height`), so it never overlaps the status cards.
 * Visible only while the user has scrolled meaningfully away from the bottom;
 * clicking re-arms sticky-bottom and pins the viewport.
 *
 * When the turn is BLOCKED on an approval, this same control morphs into an
 * "Approval needed" pill — the only response surface is the inline Run/Reject
 * bar, which is the bottom-most content, so scroll-to-bottom lands the user
 * right on it. One control, no collision, no second scroll path.
 *
 * Enter/exit motion lives in styles.css under `.thread-jump-button` — a
 * directional scale (contract in from 1.1, contract out to 0.9) keyed off
 * `data-state`. `idle` (never-shown) stays silent so it can't flash on mount;
 * `in`/`out` only swap once it has actually appeared.
 */
export function ScrollToBottomButton() {
  const { t } = useI18n()
  // Both reads are THIS session's (MJXHRM-381). One button renders per mounted
  // ChatScreen, i.e. per tile; on the global atoms every tile's button appeared
  // because ONE thread was scrolled up, every one of them said "Approval needed"
  // because the ACTIVE session had a pending approval, and clicking any of them
  // pinned every mounted transcript. `sessionApprovalRequest` is the same
  // per-session prompt store ChatScreen's own ApprovalBar already reads.
  const sessionKey = useStore(useSessionView().$runtimeId) ?? ''
  const visible = useStore(sessionThreadJumpVisible(sessionKey))
  const request = useStore(sessionApprovalRequest(sessionKey))
  // Scrolled away while an approval is pending → the inline Run/Reject bar is
  // below the fold. Relabel so the user knows the session needs them, not just
  // that there's more to read.
  const approval = visible && Boolean(request)
  const hasShownRef = useRef(false)

  if (visible) {
    hasShownRef.current = true
  }

  const state = visible ? 'in' : hasShownRef.current ? 'out' : 'idle'
  const label = approval ? t.assistant.approval.jumpToApproval : t.assistant.thread.scrollToBottom

  return (
    <button
      aria-hidden={!visible}
      aria-label={label}
      className={cn(
        // eslint-disable-next-line better-tailwindcss/no-restricted-classes -- centring, not an edge — pairs with a physical -translate-x-1/2, and start-1/2 would resolve to right:50% while the transform still pulled left (.thread-jump-button's own keyframes translateX(-50%))
        'thread-jump-button absolute left-1/2 z-20 grid place-items-center backdrop-blur-[0.75rem] [-webkit-backdrop-filter:blur(0.75rem)]',
        approval
          ? 'h-8 grid-flow-col gap-1.5 rounded-full border border-primary/40 bg-(--composer-fill) px-3 text-primary hover:bg-primary/10'
          : 'size-8 rounded-full border border-border/65 bg-(--composer-fill) text-muted-foreground hover:text-foreground',
        !visible && 'pointer-events-none'
      )}
      data-state={state}
      onClick={() => {
        void triggerHaptic('selection')
        requestScrollToBottom(sessionKey)
      }}
      style={{
        bottom: 'calc(var(--composer-measured-height) + var(--status-stack-measured-height) + 0.625rem)'
      }}
      tabIndex={visible ? 0 : -1}
      type="button"
    >
      <Codicon name="arrow-down" size={approval ? '0.875rem' : '1rem'} />
      {approval && <span className="text-xs font-medium">{label}</span>}
    </button>
  )
}
