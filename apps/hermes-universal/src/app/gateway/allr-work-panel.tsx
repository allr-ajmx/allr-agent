import { type ReactNode, useEffect, useRef, useState } from 'react'

import { gatewayHostOf } from '@/app/gateway/gateway-host'
import { ListRow, Pill } from '@/app/settings/primitives'
import { Button } from '@/components/ui/button'
import { isGatewaySignInBusy } from '@/gateway'
import { useTapHandlers } from '@/hooks/use-tap'
import { type Translations, useI18n } from '@/i18n'
import { type AllrWorkErrorKind, isAllrWorkCancelled, isAllrWorkError } from '@/lib/allr-work'
import { AlertCircle, Check, Info, Loader2, LogIn, RefreshCw } from '@/lib/icons'
import { IS_NATIVE_MOBILE } from '@/lib/platform'
import { cn } from '@/lib/utils'
import {
  $allrWorkError,
  $allrWorkRestoreIssue,
  $allrWorkSignInFlight,
  reconnectAllrWork,
  signInToAllrWork,
  switchAllrWorkAccount
} from '@/store/allr-work'
import { useStore } from '@/store/atom'
import { $connection, $connectionPhase } from '@/store/connection'
import { notifyError } from '@/store/notifications'

// The Allr Work card's panel (ALLR-51). One button signs in; the portal finds the workspace
// and Rust holds the credential, so there is nothing to type here — which is why, like the
// Nous Cloud panel, it owns its buttons and the configurator's action bar stays hidden.
//
// Every state is DERIVED from the stores, never kept here: signed in is the live connection,
// signing in is `$allrWorkSignInFlight`, a failure is `$allrWorkError`, a restore that gave up
// is `$allrWorkRestoreIssue`. The only local state is what this panel alone knows — which
// of its buttons is running, and that the last press found another sign-in already going.
//
// Mobile: the sign-in navigates this webview away, so the signing-in state is only a frame
// or two there, and the resume after the reload is the connecting screen's (allrResuming).
// The panel sits in flow inside hosts that already pad for the safe area and ride the
// visible-rectangle #root, and it has no fixed, portalled or focusable-text surface, so it
// needs no keyboard-inset or safe-area terms of its own (AGENTS.md).

type AllrErrorCopy = Translations['settings']['gateway']['allrError']

/**
 * Which sentence each failure reads as. A `Record` over the union minus `cancelled`, so a
 * kind added to `AllrWorkErrorKind` without copy fails to typecheck here — the card can never
 * render an empty error for it.
 */
const ERROR_COPY_KEY: Record<Exclude<AllrWorkErrorKind, 'cancelled'>, Exclude<keyof AllrErrorCopy, 'busy'>> = {
  'invalid-portal-config': 'invalidPortalConfig',
  'timed-out': 'timedOut',
  'navigation-refused': 'navigationRefused',
  'already-on-sign-in-page': 'alreadyOnSignInPage',
  'portal-refused': 'portalRefused',
  'no-workspace': 'noWorkspaceForAccount',
  'portal-outdated': 'portalOutdated',
  'state-mismatch': 'stateMismatch',
  'invalid-workspace': 'invalidWorkspace',
  'workspace-unsupported': 'workspaceUnsupported',
  unreachable: 'unreachable',
  'sign-in-failed': 'workspaceRefusedSignIn',
  'credential-not-saved': 'credentialNotSaved',
  'cookie-store-failed': 'cookieStoreFailed'
}

/** The card's sentence for a failure; `null` for a cancellation, which is never a failure. */
export function allrWorkErrorCopy(kind: AllrWorkErrorKind, copy: AllrErrorCopy): null | string {
  if (kind === 'cancelled') {
    return null
  }

  return copy[ERROR_COPY_KEY[kind]]
}

/** Failures a second attempt cannot fix: the build's own portal address is bad, or the
 *  sign-out already happened and only the browser cookies were left behind. No Try again. */
const RETRY_CANNOT_HELP: ReadonlySet<AllrWorkErrorKind> = new Set<AllrWorkErrorKind>([
  'invalid-portal-config',
  'cookie-store-failed'
])

type Action = 'retry' | 'sign-in' | 'switch'

/** A panel button: a real tap on touch (`createTap` via useTapHandlers — rule 31), full
 *  width and a finger-sized target on a coarse pointer, inline on a fine one. */
function PanelButton({
  busy,
  children,
  disabled,
  icon,
  onPress,
  variant
}: {
  busy?: boolean
  children: ReactNode
  disabled: boolean
  icon?: ReactNode
  onPress: () => void
  variant?: 'default' | 'outline'
}) {
  const tap = useTapHandlers(() => {
    // A disabled button can still see a pointerup on some engines.
    if (!disabled) {
      onPress()
    }
  })

  return (
    <Button className="w-full coarse:min-h-11 fine:w-auto" disabled={disabled} type="button" variant={variant} {...tap}>
      {busy ? <Loader2 className="animate-spin" /> : icon}
      {children}
    </Button>
  )
}

export function AllrWorkPanel({
  busy = false,
  embedded = false,
  onSignOut,
  runConnect
}: {
  /** The host's own busy flag (a sign-out it is running). */
  busy?: boolean
  embedded?: boolean
  /** The configurator's sign-out: the store's `signOut` plus its toast. */
  onSignOut: () => Promise<void>
  /** The configurator's soft switch + broadcast. Every dial goes through it. */
  runConnect: (dial: () => Promise<void>) => Promise<void>
}) {
  const { t } = useI18n()
  const g = t.settings.gateway

  const connection = useStore($connection)
  const phase = useStore($connectionPhase)
  const failure = useStore($allrWorkError)
  const restoreIssue = useStore($allrWorkRestoreIssue)
  const signingIn = useStore($allrWorkSignInFlight)

  const [action, setAction] = useState<Action | null>(null)
  const [busyNotice, setBusyNotice] = useState(false)

  const connected = connection?.mode === 'allr' && phase === 'ready'
  // The live Allr Work socket dropped and the supervisor is bringing it back: still this
  // workspace, not a signed-out card.
  const reconnecting = connection?.mode === 'allr' && (phase === 'probing' || phase === 'connecting')
  const host = connection?.mode === 'allr' ? (gatewayHostOf(connection.baseUrl) ?? connection.baseUrl) : null
  const errorText = failure ? allrWorkErrorCopy(failure.kind, g.allrError) : null
  const disabled = signingIn || action !== null || busy

  // "Already in progress" is about ONE press. Once a sign-in starts in this window, or the
  // card connects, it no longer describes anything — forget it rather than let it reappear
  // when that sign-in ends. Cleared on the START of a flight, not its end: this panel's own
  // busy press ends its flight a moment BEFORE the notice is set, and must not wipe it. And
  // on the connect EDGE, not on being connected: Switch account pressed while signed in can
  // be busy too, and that press still needs its answer.
  const previous = useRef({ connected, signingIn })

  useEffect(() => {
    const was = previous.current
    previous.current = { connected, signingIn }

    if ((signingIn && !was.signingIn) || (connected && !was.connected)) {
      setBusyNotice(false)
    }
  }, [connected, signingIn])

  const run = async (next: Action, dial: () => Promise<void>) => {
    if (disabled) {
      return
    }

    setAction(next)
    setBusyNotice(false)

    try {
      await runConnect(dial)
    } catch (err) {
      // The user closed the window: the soft switch already went back to where they were.
      if (isAllrWorkCancelled(err)) {
        return
      }

      // Another sign-in owns the surface. Not a failure — a notice.
      if (isGatewaySignInBusy(err)) {
        setBusyNotice(true)

        return
      }

      if (isAllrWorkError(err)) {
        // The store put it on the card, but the soft switch's rollback may since have
        // re-dialled a previous Allr Work workspace — and a successful Allr Work connect
        // clears the card. The user still needs to see why their switch did not happen.
        if (!$allrWorkError.get()) {
          $allrWorkError.set({ kind: err.kind, message: err.message, workspace: null })
        }

        return
      }

      // A connect failure after the sign-in (network, the workspace itself): not the card's.
      notifyError(err, g.applyFailed)
    } finally {
      setAction(null)
    }
  }

  const signIn = () => void run('sign-in', () => signInToAllrWork())
  const switchAccount = () => void run('switch', () => switchAllrWorkAccount())
  const retry = () => void run('retry', () => reconnectAllrWork())

  const signedInActions = (
    <>
      <PanelButton busy={action === 'switch'} disabled={disabled} onPress={switchAccount} variant="outline">
        {g.allrSwitchAccount}
      </PanelButton>
      <PanelButton busy={busy} disabled={disabled} onPress={() => void onSignOut()} variant="outline">
        {g.signOut}
      </PanelButton>
    </>
  )

  let status: ReactNode
  let below: ReactNode = null
  let actions: ReactNode = null
  // The error view announces through its alert; the status line must not change in the same
  // moment, or a screen reader reads both.
  let quietStatus = false

  if (signingIn) {
    status = (
      <span className="flex items-center gap-2">
        <Loader2 className="size-4 shrink-0 animate-spin" />
        {g.allrSigningIn}
      </span>
    )
    // Desktop only: mobile has no second window — the page it opened replaced this one.
    below = IS_NATIVE_MOBILE ? null : (
      <div className="mt-1 text-[length:var(--conversation-caption-font-size)] text-(--ui-text-tertiary)">
        {g.allrSigningInHint}
      </div>
    )
  } else if (connected) {
    status = (
      <span className="flex flex-wrap items-center gap-2">
        <Pill tone="primary">
          <Check className="size-3" /> {g.signedIn}
        </Pill>
        <span>{g.allrConnectedTo(host ?? '')}</span>
      </span>
    )
    actions = signedInActions
  } else if (reconnecting) {
    status = (
      <span className="flex items-center gap-2">
        <Loader2 className="size-4 shrink-0 animate-spin" />
        {g.reconnectingTo(g.allrWorkspaceTarget(host))}
      </span>
    )
    actions = signedInActions
  } else if (errorText && failure) {
    quietStatus = true
    status = g.allrIntro

    const kind = failure.kind

    const buttons = [
      RETRY_CANNOT_HELP.has(kind) ? null : (
        <PanelButton busy={action === 'sign-in'} disabled={disabled} icon={<RefreshCw />} key="retry" onPress={signIn}>
          {g.allrTryAgain}
        </PanelButton>
      ),
      // Signed out, cookies left behind: signing in again is still a fine next step.
      kind === 'cookie-store-failed' ? (
        <PanelButton busy={action === 'sign-in'} disabled={disabled} icon={<LogIn />} key="sign-in" onPress={signIn}>
          {g.allrSignIn}
        </PanelButton>
      ) : null,
      kind === 'no-workspace' ? (
        <PanelButton
          busy={action === 'switch'}
          disabled={disabled}
          key="switch"
          onPress={switchAccount}
          variant="outline"
        >
          {g.allrSwitchAccount}
        </PanelButton>
      ) : null
    ].filter(Boolean)

    // `invalid-portal-config` gets none: this build's own portal address is broken.
    actions = buttons.length > 0 ? buttons : null
  } else if (restoreIssue === 'session-ended') {
    status = g.allrSessionEnded
    actions = (
      <PanelButton busy={action === 'sign-in'} disabled={disabled} icon={<LogIn />} onPress={signIn}>
        {g.allrSignIn}
      </PanelButton>
    )
  } else if (restoreIssue === 'unreachable') {
    // Usually the network — but an Allr Work workspace also answers a credential it no longer
    // accepts with 503, so retrying alone might never work (design §5.6).
    status = g.allrUnreachable
    actions = (
      <>
        <PanelButton busy={action === 'retry'} disabled={disabled} icon={<RefreshCw />} onPress={retry}>
          {g.allrTryAgain}
        </PanelButton>
        <PanelButton busy={action === 'sign-in'} disabled={disabled} onPress={signIn} variant="outline">
          {g.allrSignInAgain}
        </PanelButton>
      </>
    )
  } else {
    status = g.allrIntro
    actions = (
      <PanelButton busy={action === 'sign-in'} disabled={disabled} icon={<LogIn />} onPress={signIn}>
        {g.allrSignIn}
      </PanelButton>
    )
  }

  return (
    <div className={cn('grid gap-1', embedded ? 'mt-3' : 'mt-5')} data-slot="allr-work-panel">
      <ListRow
        action={
          actions ? (
            // Touch first (stacked, full width); a fine pointer lays them out inline.
            <div className="flex flex-col gap-2 fine:flex-row fine:flex-wrap fine:items-center fine:justify-end">
              {actions}
            </div>
          ) : null
        }
        below={below}
        // `role="status"` is a polite live region already. It stays mounted so a change of
        // state is announced; in the error view it empties and the alert speaks instead.
        description={
          <>
            {quietStatus ? <span>{status}</span> : null}
            <span role="status">{quietStatus ? null : status}</span>
          </>
        }
        title={g.allrTitle}
      />

      {/* A failure the user must act on. `cancelled` never gets here (no copy). */}
      {errorText && !signingIn ? (
        <div className="flex items-start gap-2 py-2 text-xs text-destructive" role="alert">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          {errorText}
        </div>
      ) : null}

      {/* Neutral, not an error: another sign-in is already running and will finish on its own. */}
      <div aria-live="polite">
        {busyNotice && !signingIn ? (
          <div className="flex items-start gap-2 py-2 text-xs text-(--ui-text-tertiary)" data-slot="allr-work-busy">
            <Info className="mt-0.5 size-4 shrink-0" />
            {g.allrError.busy}
          </div>
        ) : null}
      </div>
    </div>
  )
}
