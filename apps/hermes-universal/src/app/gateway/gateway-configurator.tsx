import { useEffect, useMemo, useRef, useState } from 'react'

import { GatewayDiagnostics } from '@/app/gateway/gateway-diagnostics'
import { sshErrorMessage, sshStepLabel } from '@/app/gateway/ssh-copy'
import { EMPTY_SSH_FORM, SshPanel, type SshFormState, sshTargetFromForm } from '@/app/gateway/ssh-panel'
import { ListRow, Pill } from '@/app/settings/primitives'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tip } from '@/components/ui/tooltip'
import { type Translations, useI18n } from '@/i18n'
import { type AuthProvider, fetchAuthProviders } from '@/lib/auth'
import { openExternalLink } from '@/lib/external-link'
import { AlertCircle, Check, Cloud, Globe, HelpCircle, Loader2, LogIn, Monitor, RefreshCw, Terminal } from '@/lib/icons'
import { LOCAL_MODE_SUPPORTED } from '@/lib/platform'
import { saveSecrets, saveSshSecrets } from '@/lib/secure-store'
import { selectableCardClass } from '@/lib/selectable-card'
import { cn } from '@/lib/utils'
import { useStore } from '@/store/atom'
import {
  $cloudAgents,
  $cloudConnectingId,
  $cloudDiscover,
  $cloudOrg,
  $cloudOrgs,
  $portalSignedIn,
  changeCloudOrg,
  type CloudAgent,
  cloudSignIn,
  cloudSignOut,
  connectCloudAgent,
  discoverCloud,
  refreshCloud,
  selectCloudOrg
} from '@/store/cloud'
import {
  $connection,
  $connectionPhase,
  connect,
  connectLocal,
  connectSsh,
  lastUrl,
  loadSavedLogin,
  normalizeBaseUrl,
  probeStatus,
  signOut
} from '@/store/connection'
import { type Connection, type GatewayMode } from '@/store/gateway-config'
import { loadGatewayTarget, saveGatewayTarget } from '@/store/gateway-restore'
import { $gatewayMode, setGatewayMode } from '@/store/gateway-switch'
import { notify, notifyError } from '@/store/notifications'
import {
  answerSshPrompt,
  newAttemptId,
  onSshHostKey,
  onSshProgress,
  onSshPrompt,
  type SshHostKeyEvent,
  type SshPromptEvent,
  testSshBackend,
  trustSshHostKey
} from '@/store/ssh-backend'

// Shared gateway configurator — the single mode-grid + per-mode connect surface
// used by BOTH Settings → Gateway (`variant="settings"`) and the first-run connect
// screen (`variant="onboarding"`), mirroring desktop, which reuses one
// GatewaySettings component for its Settings page and its boot-recovery overlay.
//
// Ported from apps/desktop/src/app/settings/gateway-settings.tsx to full structure/
// token/copy parity, wired to universal's nanostores (the desktop
// `window.hermesDesktop.*` IPC bridge does not exist here). Desktop's key UX split
// is preserved: picking a mode card is a *pending selection* (no disconnect — see
// the bounce fix), and connecting is an explicit action. Reconnecting from Settings
// never bounces to the picker because the root gate keeps Settings mounted while
// $hasConnected is latched (see MobileController).
//
// FIXME(gateway): per-profile connection scope chips — universal profiles set the
//   ACTIVE profile globally; there is no per-profile remote-override persistence.
// FIXME(gateway): Diagnostics / "Open logs" (revealLogs) — no universal equivalent.

// ── ModeCard (verbatim desktop chrome: selectable prominent card) ────────────
function ModeCard({
  active,
  description,
  hint,
  icon: Icon,
  onSelect,
  title
}: {
  active: boolean
  description: string
  hint?: string
  icon: typeof Monitor
  onSelect: () => void
  title: string
}) {
  return (
    <button
      className={cn(
        'flex h-full min-h-0 w-full flex-col p-3 text-left disabled:cursor-not-allowed disabled:opacity-50',
        selectableCardClass({ active, prominent: true })
      )}
      onClick={onSelect}
      type="button"
    >
      <div className="flex items-center gap-1.5">
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 text-[length:var(--conversation-text-font-size)] font-medium">{title}</span>
        {hint ? (
          <Tip label={hint}>
            <span
              className="grid size-3.5 shrink-0 cursor-help place-items-center text-(--ui-text-tertiary) hover:text-(--ui-text-secondary)"
              onClick={event => event.stopPropagation()}
            >
              <HelpCircle className="size-3.5" />
            </span>
          </Tip>
        ) : null}
        {active ? <Check className="ml-auto size-3.5 shrink-0 text-primary" /> : null}
      </div>
      <p className="mt-1.5 flex-1 text-[length:var(--conversation-caption-font-size)] leading-(--conversation-caption-line-height) text-(--ui-text-tertiary)">
        {description}
      </p>
    </button>
  )
}

type ProbeStatus = 'idle' | 'probing' | 'done' | 'error'

const CLOUD_STATUS_DOT: Record<string, string> = {
  active: 'bg-green-500',
  degraded: 'bg-yellow-500',
  down: 'bg-red-500',
  unknown: 'bg-muted-foreground'
}

const normalizeCloudUrl = (url: string) => url.trim().replace(/\/+$/, '').toLowerCase()

export function GatewayConfigurator({ variant = 'settings' }: { variant?: 'onboarding' | 'settings' }) {
  const { t } = useI18n()
  const g = t.settings.gateway

  const connection = useStore($connection)
  const phase = useStore($connectionPhase)

  // Desktop parity: the selected mode is *pending* local state (seeded from the
  // persisted mode), not a live switch. Nothing disconnects on card select; the
  // persisted $gatewayMode only commits when the user actually connects/saves.
  const [pendingMode, setPendingMode] = useState<GatewayMode>(() => $gatewayMode.get())

  const isSettings = variant === 'settings'

  // Remote-mode form state (local — universal has no saved per-scope config).
  const [remoteUrl, setRemoteUrl] = useState(() => lastUrl())
  const [remoteToken, setRemoteToken] = useState('')
  // SSH form + the live-connect surfaces (progress, prompts, host-key trust).
  // Seeded from the saved target so reopening Settings shows what you connected
  // with, not a blank form.
  const [sshForm, setSshForm] = useState<SshFormState>(() => {
    const saved = loadGatewayTarget()?.ssh

    return saved
      ? {
          ...EMPTY_SSH_FORM,
          host: saved.host ?? '',
          user: saved.user ?? '',
          port: saved.port ? String(saved.port) : '',
          keyPath: saved.keyPath ?? '',
          remoteHermesPath: saved.remoteHermesPath ?? ''
        }
      : EMPTY_SSH_FORM
  })
  const [sshProgress, setSshProgress] = useState<null | string>(null)
  const [sshPrompt, setSshPrompt] = useState<null | SshPromptEvent>(null)
  const [sshHostKey, setSshHostKey] = useState<null | SshHostKeyEvent>(null)
  const sshAttemptRef = useRef<null | string>(null)

  const [busy, setBusy] = useState(false)
  const [testing, setTesting] = useState(false)
  const [lastTest, setLastTest] = useState<null | string>(null)

  // Auth-mode probe: as the user types a remote URL we ask the gateway's public
  // /api/status whether it gates (OAuth/password) or takes a session token, so we
  // show the right control. Mirrors desktop's debounced probe.
  const [probeState, setProbeState] = useState<ProbeStatus>('idle')
  const [authRequired, setAuthRequired] = useState(false)
  const [providers, setProviders] = useState<AuthProvider[]>([])
  const probeSeq = useRef(0)

  // Masked preview of a saved session token (from the keyring), so a connected /
  // idle token gateway shows the token box with an "Existing token …saved" hint
  // instead of an empty field. Null when no token is stored.
  const [savedTokenPreview, setSavedTokenPreview] = useState<null | string>(null)
  useEffect(() => {
    let live = true
    void loadSavedLogin().then(saved => {
      if (!live) {
        return
      }

      const tok = saved?.token?.trim()
      setSavedTokenPreview(tok ? `••••${tok.slice(-4)}` : null)
    })

    return () => {
      live = false
    }
  }, [])

  const trimmedUrl = remoteUrl.trim()

  useEffect(() => {
    if (pendingMode !== 'remote' || !trimmedUrl || !/^https?:\/\//i.test(trimmedUrl)) {
      setProbeState('idle')
      setAuthRequired(false)
      setProviders([])

      return
    }

    const seq = ++probeSeq.current
    setProbeState('probing')

    const timer = setTimeout(() => {
      void (async () => {
        try {
          const base = normalizeBaseUrl(trimmedUrl)
          const status = await probeStatus(base)

          if (seq !== probeSeq.current) {
            return
          }

          const gated = Boolean(status.auth_required)
          setAuthRequired(gated)
          setProviders(gated ? await fetchAuthProviders(base).catch(() => []) : [])

          if (seq !== probeSeq.current) {
            return
          }

          setProbeState('done')
        } catch {
          if (seq !== probeSeq.current) {
            return
          }

          setAuthRequired(false)
          setProviders([])
          setProbeState('error')
        }
      })()
    }, 500)

    return () => clearTimeout(timer)
  }, [pendingMode, trimmedUrl])

  // On selecting cloud mode, read the portal session + auto-discover.
  useEffect(() => {
    if (pendingMode === 'cloud') {
      void refreshCloud()
    }
  }, [pendingMode])

  // Provider label + password detection (drives the sign-in copy).
  const providerLabel = useMemo(() => {
    if (providers.length === 1) {
      return providers[0].display_name || providers[0].name
    }

    if (providers.length > 1) {
      return providers.map(p => p.display_name || p.name).join(' / ')
    }

    return null
  }, [providers])

  const isPasswordProvider = useMemo(
    () => providers.length > 0 && providers.every(p => p.supports_password),
    [providers]
  )

  const authResolved = probeState === 'done'
  const remoteReady = connection?.mode === 'remote' && phase === 'ready'
  const oauthConnected = remoteReady && connection?.authMode === 'oauth'

  // Which auth control the remote panel shows. Desktop parity: derive it from a
  // live probe while the user edits a URL, ELSE from the live connection, ELSE from
  // a saved token — so an already-connected gateway shows its auth state (Sign out /
  // token box) without re-probing. The old `probeState === 'done'` gate hid the auth
  // controls entirely once connected.
  const authView: 'oauth' | 'token' | null = authResolved
    ? authRequired
      ? 'oauth'
      : 'token'
    : remoteReady
      ? connection?.authMode === 'oauth' || connection?.authMode === 'ticket'
        ? 'oauth'
        : 'token'
      : savedTokenPreview
        ? 'token'
        : null

  // Commit the pending mode, then dial. Reconnecting in place never bounces to the
  // connect picker — the root gate keeps Settings mounted across the reconnect
  // because $hasConnected stays latched. Re-throws for the caller's failure toast.
  const runConnect = (fn: () => Promise<void>): Promise<void> => {
    setGatewayMode(pendingMode)

    return fn()
  }

  const doConnectRemote = async () => {
    if (!trimmedUrl) {
      notify({ kind: 'warning', title: g.incompleteTitle, message: g.enterUrlFirst })

      return
    }

    setBusy(true)
    setLastTest(null)

    try {
      await runConnect(() =>
        connect({ url: trimmedUrl, token: authRequired ? undefined : remoteToken.trim() || undefined })
      )
      setRemoteToken('')

      if (isSettings) {
        notify({ kind: 'success', title: g.restartingTitle, message: g.restartingMessage })
      }
    } catch (err) {
      notifyError(err, g.applyFailed)
    } finally {
      setBusy(false)
    }
  }

  const doConnectLocal = async () => {
    setBusy(true)

    try {
      await runConnect(() => connectLocal())

      if (isSettings) {
        notify({ kind: 'success', title: g.restartingTitle, message: g.restartingMessage })
      }
    } catch (err) {
      notifyError(err, g.applyFailed)
    } finally {
      setBusy(false)
    }
  }

  const connectAgent = (agent: CloudAgent): Promise<void> => runConnect(() => connectCloudAgent(agent))

  const trimmedSshHost = sshForm.host.trim()

  /**
   * Run an SSH operation with its event plumbing attached.
   *
   * Subscribing BEFORE invoking is the contract the Rust side documents: an
   * early step — or worse, a passphrase prompt — emitted before the listener
   * exists is simply lost, and the connect then stalls with nothing on screen.
   */
  const runSsh = async <T,>(operation: (attemptId: string) => Promise<T>): Promise<T> => {
    const attemptId = newAttemptId()
    sshAttemptRef.current = attemptId
    setSshProgress(null)
    setSshPrompt(null)
    setSshHostKey(null)

    const unlisten = await Promise.all([
      onSshProgress(attemptId, progress => setSshProgress(sshStepLabel(progress.step, g))),
      onSshPrompt(attemptId, setSshPrompt),
      onSshHostKey(attemptId, setSshHostKey)
    ])

    try {
      return await operation(attemptId)
    } finally {
      unlisten.forEach(off => off())
      sshAttemptRef.current = null
      setSshProgress(null)
      setSshPrompt(null)
      setSshHostKey(null)
    }
  }

  // Persist the credentials the user typed, so the boot restore — which cannot
  // prompt — has them next launch.
  const persistSshSecrets = () =>
    saveSshSecrets({
      privateKeyPem: sshForm.privateKeyPem.trim() || undefined,
      passphrase: sshForm.passphrase || undefined
    })

  const doConnectSsh = async () => {
    if (!trimmedSshHost) {
      notify({ kind: 'warning', title: g.incompleteTitle, message: g.sshIncompleteHost })

      return
    }

    setBusy(true)

    try {
      await persistSshSecrets()
      setGatewayMode('ssh')
      await runSsh(attemptId =>
        connectSsh(sshTargetFromForm(sshForm), { attemptId, interactive: true })
      )
      notify({ kind: 'success', title: g.savedTitle, message: g.savedMessage })
    } catch (err) {
      notifyError(sshErrorMessage(err, g), g.saveFailed)
    } finally {
      setBusy(false)
    }
  }

  const testSsh = async () => {
    if (!trimmedSshHost) {
      notify({ kind: 'warning', title: g.incompleteTitle, message: g.sshIncompleteHost })

      return
    }

    setTesting(true)
    setLastTest(null)

    try {
      await persistSshSecrets()
      const result = await runSsh(attemptId =>
        testSshBackend(attemptId, { ...sshTargetFromForm(sshForm), interactive: true })
      )
      setLastTest(g.sshReachable(result.hostLabel, result.platform ?? 'unknown'))
    } catch (err) {
      setLastTest(sshErrorMessage(err, g))
    } finally {
      setTesting(false)
    }
  }

  // "Save for next restart" (settings, desktop `save(false)`): persist the mode +
  // target WITHOUT connecting, so the next launch auto-connects to it. Secrets (a
  // typed token) go to the keyring; the target itself is non-secret.
  const doSaveForRestart = async () => {
    if (pendingMode === 'remote' && !trimmedUrl) {
      notify({ kind: 'warning', title: g.incompleteTitle, message: g.enterUrlFirst })

      return
    }

    if (pendingMode === 'ssh' && !trimmedSshHost) {
      notify({ kind: 'warning', title: g.incompleteTitle, message: g.sshIncompleteHost })

      return
    }

    setBusy(true)

    try {
      setGatewayMode(pendingMode)

      if (pendingMode === 'local') {
        saveGatewayTarget({ mode: 'local', profile: null })
      } else if (pendingMode === 'remote') {
        saveGatewayTarget({ mode: 'remote', url: trimmedUrl })
        const token = remoteToken.trim()

        if (token) {
          await saveSecrets({ token })
        }
      } else if (pendingMode === 'ssh') {
        saveGatewayTarget({ mode: 'ssh', profile: null, ssh: sshTargetFromForm(sshForm) })
        await persistSshSecrets()
      }

      notify({ kind: 'success', title: g.savedTitle, message: g.savedMessage })
    } catch (err) {
      notifyError(err, g.saveFailed)
    } finally {
      setBusy(false)
    }
  }

  const doSignOut = async () => {
    setBusy(true)

    try {
      await signOut()
      notify({ kind: 'success', title: g.signedOutTitle, message: g.signedOutMessage })
    } catch (err) {
      notifyError(err, g.signOutFailed)
    } finally {
      setBusy(false)
    }
  }

  const testRemote = async () => {
    if (!trimmedUrl) {
      notify({ kind: 'warning', title: g.incompleteTitle, message: g.enterUrlFirst })

      return
    }

    setTesting(true)
    setLastTest(null)

    try {
      const status = await probeStatus(trimmedUrl)
      const version = typeof status.version === 'string' ? status.version : undefined
      const message = g.connectedTo(normalizeBaseUrl(trimmedUrl), version)
      setLastTest(message)
      notify({ kind: 'success', title: g.reachableTitle, message })
    } catch (err) {
      notifyError(err, g.testFailed)
    } finally {
      setTesting(false)
    }
  }

  return (
    <>
      {variant === 'settings' ? (
        <div className="mb-5">
          <div className="flex items-center gap-2 text-[length:var(--conversation-text-font-size)] font-medium">
            <Globe className="size-4 text-muted-foreground" />
            {g.title}
          </div>
          <p className="mt-2 max-w-2xl text-[length:var(--conversation-caption-font-size)] leading-(--conversation-caption-line-height) text-(--ui-text-tertiary)">
            {g.intro}
          </p>
        </div>
      ) : null}

      {/* Connection mode */}
      <div className="mb-5 grid gap-2">
        <div className="text-[length:var(--conversation-caption-font-size)] font-medium text-(--ui-text-secondary)">
          {g.modeTitle}
        </div>
        {/* Tailwind cannot see a computed class name, so the column count is
            picked from literals: four cards on desktop, three when Local is
            hidden (mobile cannot spawn a backend, but it CAN dial SSH). */}
        <div
          className={cn(
            'grid auto-rows-fr grid-cols-1 gap-2',
            LOCAL_MODE_SUPPORTED ? 'min-[42rem]:grid-cols-4' : 'min-[42rem]:grid-cols-3'
          )}
        >
          {LOCAL_MODE_SUPPORTED ? (
            <ModeCard
              active={pendingMode === 'local'}
              description={g.localDesc}
              icon={Monitor}
              onSelect={() => setPendingMode('local')}
              title={g.localTitle}
            />
          ) : null}
          <ModeCard
            active={pendingMode === 'cloud'}
            description={g.cloudDesc}
            icon={Cloud}
            onSelect={() => setPendingMode('cloud')}
            title={g.cloudTitle}
          />
          <ModeCard
            active={pendingMode === 'remote'}
            description={g.remoteDesc}
            hint={g.remoteAuthHint}
            icon={Globe}
            onSelect={() => setPendingMode('remote')}
            title={g.remoteTitle}
          />
          <ModeCard
            active={pendingMode === 'ssh'}
            description={g.sshDesc}
            hint={g.sshTrustHint}
            icon={Terminal}
            onSelect={() => setPendingMode('ssh')}
            title={g.sshTitle}
          />
        </div>
      </div>

      {/* Hermes Cloud panel */}
      {pendingMode === 'cloud' ? <CloudPanel connectAgent={connectAgent} connection={connection} g={g} /> : null}

      {/* SSH panel */}
      {pendingMode === 'ssh' ? (
        <SshPanel
          form={sshForm}
          g={g}
          hostKey={sshHostKey}
          onAnswerPrompt={answer => {
            const attemptId = sshAttemptRef.current

            if (attemptId && sshPrompt) {
              void answerSshPrompt(attemptId, sshPrompt.promptId, answer).catch(() => {})
              setSshPrompt(null)
            }
          }}
          onTrustHostKey={accept => {
            const attemptId = sshAttemptRef.current

            if (attemptId) {
              void trustSshHostKey(attemptId, accept).catch(() => {})
              setSshHostKey(null)
            }
          }}
          progress={sshProgress}
          prompt={sshPrompt}
          setForm={setSshForm}
        />
      ) : null}

      {/* Remote panel */}
      {pendingMode === 'remote' ? (
        <div className="mt-5 grid gap-1">
          <ListRow
            action={
              <Input
                className="font-normal"
                onChange={event => setRemoteUrl(event.target.value)}
                placeholder="https://gateway.example.com/hermes"
                value={remoteUrl}
              />
            }
            description={g.remoteUrlDesc}
            title={g.remoteUrlTitle}
          />

          {probeState === 'probing' ? (
            <div className="flex items-center gap-2 py-3 text-[length:var(--conversation-caption-font-size)] text-(--ui-text-tertiary)">
              <Loader2 className="size-4 animate-spin" />
              {g.probing}
            </div>
          ) : null}

          {probeState === 'error' ? (
            <div className="flex items-start gap-2 py-3 text-[length:var(--conversation-caption-font-size)] text-(--ui-text-tertiary)">
              <AlertCircle className="mt-0.5 size-4 shrink-0" />
              {g.probeError}
            </div>
          ) : null}

          {/* OAuth / password gateways: sign-in button + connection status. */}
          {authView === 'oauth' ? (
            <ListRow
              action={
                oauthConnected ? (
                  <div className="flex items-center gap-2">
                    <Pill tone="primary">
                      <Check className="size-3" /> {g.signedIn}
                    </Pill>
                    <Button disabled={busy} onClick={() => void doSignOut()} variant="outline">
                      {busy ? <Loader2 className="animate-spin" /> : null}
                      {g.signOut}
                    </Button>
                  </div>
                ) : (
                  <Button disabled={busy || !trimmedUrl} onClick={() => void doConnectRemote()}>
                    {busy ? <Loader2 className="animate-spin" /> : <LogIn />}
                    {isPasswordProvider || !providerLabel ? g.signIn : g.signInWith(providerLabel)}
                  </Button>
                )
              }
              description={
                oauthConnected
                  ? isPasswordProvider
                    ? g.authSignedInPassword
                    : g.authSignedInOauth
                  : isPasswordProvider
                    ? g.authNeedsPassword
                    : g.authNeedsOauth(providerLabel ?? '')
              }
              title={g.authTitle}
            />
          ) : null}

          {/* Session-token gateways: token entry box. A saved token surfaces as a
              masked "Existing token …" placeholder; leaving it blank keeps it. */}
          {authView === 'token' ? (
            <ListRow
              action={
                <Input
                  autoComplete="off"
                  className="font-mono font-normal"
                  onChange={event => setRemoteToken(event.target.value)}
                  placeholder={savedTokenPreview ? g.existingToken(savedTokenPreview) : g.pasteSessionToken}
                  type="password"
                  value={remoteToken}
                />
              }
              description={g.tokenDesc}
              title={g.tokenTitle}
            />
          ) : null}
        </div>
      ) : null}

      {lastTest ? <div className="mt-4 text-xs text-primary">{lastTest}</div> : null}

      {/* Action bar (local + remote). Cloud connects via the agent picker above. */}
      {pendingMode !== 'cloud' ? (
        <div className="mt-6 flex flex-wrap items-center justify-end gap-4">
          {pendingMode === 'remote' ? (
            <Button
              className="mr-auto"
              disabled={testing || !trimmedUrl}
              onClick={() => void testRemote()}
              size="sm"
              variant="text"
            >
              {testing ? <Loader2 className="animate-spin" /> : null}
              {g.testRemote}
            </Button>
          ) : null}
          {pendingMode === 'ssh' ? (
            <Button
              className="mr-auto"
              disabled={testing || !trimmedSshHost}
              onClick={() => void testSsh()}
              size="sm"
              variant="text"
            >
              {testing ? <Loader2 className="animate-spin" /> : null}
              {g.sshTestConnection}
            </Button>
          ) : null}
          {/* "Save for next restart" — settings only (desktop hides it in the
              embedded/onboarding variant). Persists without connecting. */}
          {variant === 'settings' ? (
            <Button
              disabled={
                busy ||
                (pendingMode === 'remote' && !trimmedUrl) ||
                (pendingMode === 'ssh' && !trimmedSshHost)
              }
              onClick={() => void doSaveForRestart()}
              size="sm"
              variant="outline"
            >
              {g.saveForRestart}
            </Button>
          ) : null}
          <Button
            disabled={
              busy || (pendingMode === 'remote' && !trimmedUrl) || (pendingMode === 'ssh' && !trimmedSshHost)
            }
            onClick={() => {
              if (pendingMode === 'local') {
                void doConnectLocal()
              } else if (pendingMode === 'ssh') {
                void doConnectSsh()
              } else {
                void doConnectRemote()
              }
            }}
            size="sm"
          >
            {busy ? <Loader2 className="animate-spin" /> : null}
            {g.saveAndReconnect}
          </Button>
        </div>
      ) : null}

      {/* Diagnostics — settings-only, and only meaningful against a live gateway
          (getStatus/getLogs hit the backend). Desktop shows it non-embedded too. */}
      {isSettings && phase === 'ready' ? <GatewayDiagnostics /> : null}
    </>
  )
}

// ── Hermes Cloud panel: portal sign-in → org picker → discovered-agent list ──
function CloudPanel({
  connectAgent,
  connection,
  g
}: {
  connectAgent: (agent: CloudAgent) => Promise<void>
  connection: Connection | null
  g: Translations['settings']['gateway']
}) {
  const signedIn = useStore($portalSignedIn)
  const agents = useStore($cloudAgents)
  const orgs = useStore($cloudOrgs)
  const org = useStore($cloudOrg)
  const discover = useStore($cloudDiscover)
  const connectingId = useStore($cloudConnectingId)
  const [signing, setSigning] = useState(false)

  const connectedCloudUrl =
    connection?.mode === 'cloud' && connection.baseUrl ? normalizeCloudUrl(connection.baseUrl) : ''

  const isConnectedAgent = (agent: CloudAgent) =>
    Boolean(connectedCloudUrl && agent.dashboardUrl && normalizeCloudUrl(agent.dashboardUrl) === connectedCloudUrl)

  const doCloudSignOut = async () => {
    setSigning(true)

    try {
      await cloudSignOut()
      notify({ kind: 'success', title: g.cloudSignedOutTitle, message: g.cloudSignedOutMessage })
    } finally {
      setSigning(false)
    }
  }

  const doCloudSignIn = async () => {
    setSigning(true)

    try {
      await cloudSignIn()
    } finally {
      setSigning(false)
    }
  }

  return (
    <div className="mt-5 grid gap-1">
      <ListRow
        action={
          signedIn ? (
            <div className="flex items-center gap-2">
              <Pill tone="primary">
                <Check className="size-3" /> {g.cloudSignedIn}
              </Pill>
              <Button disabled={signing} onClick={() => void doCloudSignOut()} variant="outline">
                {signing ? <Loader2 className="animate-spin" /> : null}
                {g.signOut}
              </Button>
            </div>
          ) : (
            <Button disabled={signing} onClick={() => void doCloudSignIn()}>
              {signing ? <Loader2 className="animate-spin" /> : <LogIn />}
              {g.cloudSignIn}
            </Button>
          )
        }
        description={signedIn ? g.cloudSignedInDesc : g.cloudNeedsSignIn}
        title={g.cloudSignInTitle}
      />

      {signedIn ? (
        orgs.length > 0 && !org ? (
          // Multi-org account with no org chosen yet: show the picker.
          <div className="mt-3">
            <div className="mb-2 text-[length:var(--conversation-caption-font-size)] font-medium text-(--ui-text-secondary)">
              {g.cloudOrgPickerTitle}
            </div>
            <div className="grid gap-1">
              {orgs.map(orgEntry => (
                <ListRow
                  action={
                    <Button onClick={() => void selectCloudOrg(orgEntry)} size="sm">
                      {g.cloudOrgSelect}
                    </Button>
                  }
                  description={g.cloudOrgRole(orgEntry.role)}
                  key={orgEntry.id}
                  title={orgEntry.name}
                />
              ))}
            </div>
          </div>
        ) : (
          <div className="mt-3">
            <div className="mb-2 flex items-center justify-between">
              <div className="text-[length:var(--conversation-caption-font-size)] font-medium text-(--ui-text-secondary)">
                {g.cloudAgentsTitle}
              </div>
              <div className="flex items-center gap-2">
                {org ? (
                  <Button onClick={() => void changeCloudOrg()} size="sm" variant="text">
                    {g.cloudOrgChange}
                  </Button>
                ) : null}
                <Button
                  disabled={discover === 'loading'}
                  onClick={() => void discoverCloud(org?.id)}
                  size="sm"
                  variant="text"
                >
                  {discover === 'loading' ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                  {g.cloudRefresh}
                </Button>
              </div>
            </div>

            {discover === 'loading' ? (
              <div className="flex items-center gap-2 py-3 text-[length:var(--conversation-caption-font-size)] text-(--ui-text-tertiary)">
                <Loader2 className="size-4 animate-spin" />
                {g.cloudLoadingAgents}
              </div>
            ) : agents.length === 0 ? (
              <div className="flex items-start gap-2 py-3 text-[length:var(--conversation-caption-font-size)] text-(--ui-text-tertiary)">
                <AlertCircle className="mt-0.5 size-4 shrink-0" />
                <span>
                  {g.cloudNoAgents.before}
                  <button
                    className="text-primary underline-offset-4 hover:underline"
                    onClick={() => void openExternalLink('https://portal.nousresearch.com/agents')}
                    type="button"
                  >
                    {g.cloudNoAgents.linkText}
                  </button>
                  {g.cloudNoAgents.after}
                </span>
              </div>
            ) : (
              <div className="grid gap-1">
                {agents.map(agent => {
                  const connected = isConnectedAgent(agent)

                  return (
                    <div
                      className={cn('rounded-md px-2', connected && 'bg-primary/5 ring-1 ring-primary/25')}
                      key={agent.id}
                    >
                      <ListRow
                        action={
                          connected ? (
                            <Pill tone="primary">
                              <Check className="mr-1 inline size-3" />
                              {g.cloudConnectedPill}
                            </Pill>
                          ) : (
                            <Button
                              disabled={!agent.dashboardUrl || connectingId !== null}
                              onClick={() => void connectAgent(agent)}
                              size="sm"
                            >
                              {connectingId === agent.id ? <Loader2 className="animate-spin" /> : null}
                              {agent.dashboardUrl
                                ? connectingId === agent.id
                                  ? g.cloudConnecting
                                  : g.cloudConnect
                                : g.cloudAgentProvisioning}
                            </Button>
                          )
                        }
                        description={
                          <span className="flex items-center gap-1.5">
                            <span
                              className={cn(
                                'size-2 shrink-0 rounded-full',
                                CLOUD_STATUS_DOT[agent.dashboardGatewayState] ?? CLOUD_STATUS_DOT.unknown
                              )}
                            />
                            {g.cloudStatusLabel(agent.dashboardGatewayState)}
                          </span>
                        }
                        title={agent.name || agent.id}
                      />
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )
      ) : null}
    </div>
  )
}
