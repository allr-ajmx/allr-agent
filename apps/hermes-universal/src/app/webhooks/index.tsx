import type * as React from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { PageLoader } from '@/components/page-loader'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Codicon } from '@/components/ui/codicon'
import { CopyButton } from '@/components/ui/copy-button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import {
  createWebhook,
  deleteWebhook,
  enableWebhooks,
  getMessagingPlatforms,
  getWebhooks,
  setWebhookEnabled,
  type WebhookRoute,
  type WebhooksResponse
} from '@/hermes'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import { useStore } from '@/store/atom'
import { notify, notifyError } from '@/store/notifications'
import { $gatewayRestarting, runGatewayRestart } from '@/store/system-status'

import { useRefreshHotkey } from '../hooks/use-refresh-hotkey'
import type { OverlayVariant } from '../overlays/overlay-view'
import {
  Panel,
  PanelAddButton,
  PanelBlock,
  PanelBody,
  PanelDetail,
  PanelEmpty,
  PanelHeader,
  PanelList,
  PanelListRow,
  PanelMeta,
  PanelPill,
  PanelSectionLabel
} from '../overlays/panel'

import {
  DELIVER_LOG,
  normalizeWebhookName,
  readableCreateError,
  splitWebhookList,
  webhookCreateError
} from './create-model'
import {
  $pendingWebhookSecrets,
  acknowledgeWebhookSecret,
  markWebhookSecretCopied,
  nextPendingWebhookSecret,
  pendingWebhookSecretFor,
  rememberWebhookSecret
} from './pending-secret'

// The Webhooks surface: inbound HTTP event subscriptions served by the webhook
// gateway platform. Ported from apps/desktop/src/app/webhooks/index.tsx onto
// universal's Panel primitives (the cron overlay is the structural sibling).
//
// Two things here deliberately do NOT match desktop, both because desktop's
// version quietly loses or overstates something:
//
//  1. The one-time secret lives in a module atom (./pending-secret), not in this
//     component's state, and only an explicit acknowledgement drops it. Desktop
//     clears it in `closeCreate()`, so Esc / a click outside / any unmount
//     destroys a value the backend will never show again.
//  2. `WebhooksResponse.enabled` is CONFIG state — `platforms.webhook.enabled`
//     in config.yaml. It flips true the instant `POST /api/webhooks/enable`
//     writes the file, long before (and whether or not) a receiver ever binds
//     the port. The live answer already exists in this backend and nothing read
//     it: `GET /api/messaging/platforms` reports the `webhook` platform's
//     runtime `state`, including the literal `pending_restart`. This page reads
//     it, so the banner says what is actually true.

const WEBHOOK_PLATFORM_ID = 'webhook'

// Delivery targets the backend understands for a webhook route (mirrors
// desktop's list; the backend has no endpoint that enumerates them).
const DELIVER_OPTIONS: readonly string[] = ['log', 'telegram', 'discord', 'slack', 'email', 'github_comment']

type WebhooksTab = 'inbound' | 'outbound'

interface WebhooksViewProps extends React.ComponentProps<'section'> {
  onClose: () => void
  /** `fullscreen` when hosted as a phone / native screen, which draws its own chrome. */
  variant?: OverlayVariant
}

export function WebhooksView({ onClose, variant }: WebhooksViewProps) {
  const { t } = useI18n()
  const w = t.webhooks
  const secrets = useStore($pendingWebhookSecrets)
  const restarting = useStore($gatewayRestarting)

  const [tab, setTab] = useState<WebhooksTab>('inbound')
  const [data, setData] = useState<null | WebhooksResponse>(null)
  // Runtime state of the `webhook` platform, or null when this gateway has no
  // /api/messaging/platforms (older build) — in which case we say so rather than
  // inventing a status.
  const [receiver, setReceiver] = useState<null | { error: null | string; state: null | string }>(null)
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [selectedName, setSelectedName] = useState<null | string>(null)
  const [enabling, setEnabling] = useState(false)
  const [enableNote, setEnableNote] = useState<null | { text: string; tone: 'bad' | 'warn' }>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<null | string>(null)
  const [deleting, setDeleting] = useState(false)

  // Which pending secret the modal is showing. Seeded from the atom so a
  // re-mount (overlay reopened, route bounced, error path re-rendered) puts an
  // un-acknowledged secret straight back on screen.
  const [secretFor, setSecretFor] = useState<null | string>(() => nextPendingWebhookSecret()?.name ?? null)
  const secret = secretFor ? pendingWebhookSecretFor(secretFor, secrets) : null

  const refresh = useCallback(async () => {
    // Two independent reads: the subscription list is the page, the platform
    // state is the honesty check. A gateway without the second still gets a
    // working page.
    const [webhooks, platforms] = await Promise.allSettled([getWebhooks(), getMessagingPlatforms()])

    if (webhooks.status === 'fulfilled') {
      setData(webhooks.value)
    } else {
      notifyError(webhooks.reason, w.loadFailed)
    }

    if (platforms.status === 'fulfilled') {
      const row = platforms.value.platforms.find(platform => platform.id === WEBHOOK_PLATFORM_ID)

      setReceiver(row ? { error: row.error_message ?? null, state: row.state ?? null } : null)
    } else {
      setReceiver(null)
    }

    setLoading(false)
  }, [w.loadFailed])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useRefreshHotkey(() => void refresh())

  const subscriptions = useMemo(() => data?.subscriptions ?? [], [data])
  const configEnabled = data?.enabled ?? false
  const receiverState = receiver?.state ?? null
  const receiverLive = receiverState === 'connected'

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()

    if (!needle) {
      return subscriptions
    }

    return subscriptions.filter(sub =>
      [sub.name, sub.description, sub.deliver, ...sub.events, ...sub.skills]
        .filter(Boolean)
        .some(value => value.toLowerCase().includes(needle))
    )
  }, [query, subscriptions])

  const selected = useMemo(
    () => visible.find(sub => sub.name === selectedName) ?? visible[0] ?? null,
    [visible, selectedName]
  )

  const handleEnable = useCallback(async () => {
    setEnabling(true)
    setEnableNote(null)

    try {
      const result = await enableWebhooks()

      // `restart_started` means a `hermes gateway restart` process was SPAWNED.
      // It does not mean the restart finished, and nothing in this response can
      // say the receiver bound its port — so neither does the copy.
      if (result.restart_started) {
        setEnableNote({ text: w.enabledRestartStarted, tone: 'warn' })
        notify({ kind: 'info', message: w.enabledRestartStarted })
      } else {
        const detail = result.restart_error ? `: ${result.restart_error}` : '.'

        setEnableNote({ text: w.restartNotStarted(detail), tone: 'bad' })
        notify({ kind: 'error', message: w.restartNotStarted(detail) })
      }

      await refresh()
    } catch (err) {
      notifyError(err, w.enableFailed)
    } finally {
      setEnabling(false)
    }
  }, [refresh, w])

  const handleCreate = useCallback(
    async (payload: Parameters<typeof createWebhook>[0]) => {
      const created = await createWebhook(payload)

      // FIRST, before any await, toast or navigation: the secret has no second
      // source and every line below this one can throw.
      rememberWebhookSecret(created)
      setSecretFor(created.name)
      setCreateOpen(false)
      setSelectedName(created.name)
      notify({ kind: 'success', message: w.created(created.name) })
      await refresh()
    },
    [refresh, w]
  )

  const handleToggle = useCallback(
    async (sub: WebhookRoute) => {
      const next = !sub.enabled

      // Optimistic paint; the refresh below lets backend truth win.
      setData(current =>
        current
          ? {
              ...current,
              subscriptions: current.subscriptions.map(row => (row.name === sub.name ? { ...row, enabled: next } : row))
            }
          : current
      )

      try {
        await setWebhookEnabled(sub.name, next)
        notify({ kind: 'success', message: next ? w.enabledRow(sub.name) : w.disabledRow(sub.name) })
      } catch (err) {
        notifyError(err, w.toggleFailed(sub.name))
      } finally {
        await refresh()
      }
    },
    [refresh, w]
  )

  const handleDelete = useCallback(async () => {
    if (!pendingDelete) {
      return
    }

    setDeleting(true)

    try {
      await deleteWebhook(pendingDelete)
      notify({ kind: 'success', title: w.deleted, message: pendingDelete })
      setPendingDelete(null)
      await refresh()
    } catch (err) {
      notifyError(err, w.deleteFailed(pendingDelete))
    } finally {
      setDeleting(false)
    }
  }, [pendingDelete, refresh, w])

  const banner = (
    <ReceiverBanner
      configEnabled={configEnabled}
      enableNote={enableNote}
      enabling={enabling}
      error={receiver?.error ?? null}
      known={receiver !== null}
      onEnable={() => void handleEnable()}
      onRecheck={() => void refresh()}
      onRestart={() => void runGatewayRestart()}
      restarting={restarting}
      state={receiverState}
    />
  )

  const tabs = (
    <SegmentedControl
      onChange={setTab}
      options={[
        { id: 'inbound', label: w.tabInbound },
        { id: 'outbound', label: w.tabOutbound }
      ]}
      value={tab}
    />
  )

  return (
    <Panel closeLabel={t.common.close} onClose={onClose} variant={variant}>
      {loading ? (
        <PageLoader label={w.loading} />
      ) : (
        <>
          <PanelHeader
            actions={tabs}
            subtitle={
              tab === 'outbound' ? (
                w.outboundSubtitle
              ) : (
                // The base URL plus, only when the gateway actually says so, a
                // live badge. Silence is not a claim: the banner below explains
                // every state that is not `connected`.
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate">{data?.base_url ?? ''}</span>
                  {receiverLive ? <PanelPill tone="good">{t.messaging.states.connected}</PanelPill> : null}
                </span>
              )
            }
            title={w.title}
          />

          {tab === 'outbound' ? (
            // Deliberate placeholder. Outbound webhooks are a separate feature
            // (agent/outbound_webhooks.py) driven entirely by `hooks.outbound:`
            // in config.yaml, with NO REST CRUD to talk to. MJXHRM-231 owns the
            // decision about giving them one; building it here would be
            // inventing a backend.
            <PanelEmpty description={w.outboundBody} icon="radio-tower" title={w.outboundTitle} />
          ) : (
            <>
              {banner}
              {subscriptions.length === 0 ? (
                <PanelEmpty
                  action={
                    <Button disabled={!configEnabled} onClick={() => setCreateOpen(true)} size="sm">
                      {w.newSubscription}
                    </Button>
                  }
                  description={configEnabled ? w.emptyDesc : w.emptyDescDisabled}
                  icon="globe"
                  title={w.emptyTitle}
                />
              ) : (
                <PanelBody>
                  <PanelList
                    onSearchChange={setQuery}
                    searchLabel={w.search}
                    searchPlaceholder={w.search}
                    searchValue={query}
                  >
                    {visible.map(sub => (
                      <PanelListRow
                        active={selected?.name === sub.name}
                        dotClassName={sub.enabled ? 'bg-emerald-500' : 'bg-muted-foreground/50'}
                        key={sub.name}
                        menuItems={[
                          {
                            icon: sub.enabled ? 'circle-slash' : 'check',
                            label: sub.enabled ? w.disableRow : w.enableRow,
                            onSelect: () => void handleToggle(sub)
                          },
                          ...(pendingWebhookSecretFor(sub.name, secrets)
                            ? [
                                {
                                  icon: 'key',
                                  label: w.showSecret,
                                  onSelect: () => setSecretFor(sub.name)
                                }
                              ]
                            : []),
                          {
                            icon: 'trash',
                            label: t.common.delete,
                            onSelect: () => setPendingDelete(sub.name),
                            tone: 'danger' as const
                          }
                        ]}
                        menuLabel={w.rowActions}
                        meta={pendingWebhookSecretFor(sub.name, secrets) ? w.secretUnsaved : undefined}
                        onSelect={() => setSelectedName(sub.name)}
                        rowKey={sub.name}
                        title={sub.name}
                      />
                    ))}
                    {visible.length === 0 && (
                      <p className="px-2 py-4 text-center text-xs text-muted-foreground">{w.noMatches}</p>
                    )}
                    <PanelAddButton
                      label={w.newSubscription}
                      onClick={() => {
                        if (configEnabled) {
                          setCreateOpen(true)
                        } else {
                          notify({ kind: 'error', message: w.enableFirst })
                        }
                      }}
                    />
                  </PanelList>

                  {selected ? (
                    <WebhookDetail
                      hasPendingSecret={Boolean(pendingWebhookSecretFor(selected.name, secrets))}
                      sub={selected}
                    />
                  ) : (
                    <PanelEmpty description={w.noMatches} icon="search" />
                  )}
                </PanelBody>
              )}
            </>
          )}
        </>
      )}

      <CreateWebhookDialog onClose={() => setCreateOpen(false)} onCreate={handleCreate} open={createOpen} />

      <SecretDialog
        onAcknowledge={() => {
          if (secret) {
            acknowledgeWebhookSecret(secret.name)
          }

          setSecretFor(null)
        }}
        onLater={() => setSecretFor(null)}
        secret={secret}
      />

      <Dialog onOpenChange={open => !open && !deleting && setPendingDelete(null)} open={pendingDelete !== null}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{w.deleteTitle}</DialogTitle>
            <DialogDescription>
              {pendingDelete ? (
                <>
                  {w.deleteDescPrefix}
                  <span className="font-medium text-foreground">{pendingDelete}</span>
                  {w.deleteDescSuffix}
                </>
              ) : null}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button disabled={deleting} onClick={() => setPendingDelete(null)} variant="outline">
              {t.common.cancel}
            </Button>
            <Button disabled={deleting} onClick={() => void handleDelete()} variant="destructive">
              {deleting ? w.deleting : t.common.delete}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Panel>
  )
}

// ── Receiver status ─────────────────────────────────────────────────────────

/**
 * What the page is allowed to claim about the receiver.
 *
 * `configEnabled` answers "is it switched on in config.yaml". `state` answers
 * "did the RUNNING gateway start it" — the backend derives `pending_restart`
 * for exactly the gap between the two. Keeping them separate is the difference
 * between a banner that reports success and one that is true.
 */
function ReceiverBanner({
  configEnabled,
  enableNote,
  enabling,
  error,
  known,
  onEnable,
  onRecheck,
  onRestart,
  restarting,
  state
}: {
  configEnabled: boolean
  enableNote: null | { text: string; tone: 'bad' | 'warn' }
  enabling: boolean
  error: null | string
  /** False when this gateway has no /api/messaging/platforms to ask. */
  known: boolean
  onEnable: () => void
  onRecheck: () => void
  onRestart: () => void
  restarting: boolean
  state: null | string
}) {
  const { t } = useI18n()
  const w = t.webhooks

  if (configEnabled && known && state === 'connected') {
    return null
  }

  const off = !configEnabled || state === 'disabled'

  const body = off
    ? w.disabledBody
    : known
      ? state === 'pending_restart'
        ? w.pendingRestartBody
        : w.receiverNotLive(t.messaging.states[state ?? ''] || (state ?? '').replaceAll('_', ' ') || w.unknownState)
      : w.receiverUnknown

  return (
    <div
      className={cn(
        'mb-3 shrink-0 rounded-md px-3 py-2.5 text-xs leading-relaxed',
        off || enableNote?.tone === 'bad'
          ? 'bg-destructive/10 text-destructive'
          : 'bg-amber-500/10 text-amber-700 dark:text-amber-300'
      )}
      role="status"
    >
      <p className="font-medium">{off ? w.disabledTitle : w.receiverNotLiveTitle}</p>
      <p className="mt-0.5 text-foreground/75">{body}</p>
      {error ? <p className="mt-0.5 break-words text-foreground/60">{error}</p> : null}
      {enableNote ? <p className="mt-0.5 text-foreground/75">{enableNote.text}</p> : null}

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {off ? (
          <Button disabled={enabling} onClick={onEnable} size="sm">
            <Codicon name="globe" size="0.875rem" />
            {enabling ? w.enabling : w.enable}
          </Button>
        ) : (
          <Button disabled={restarting} onClick={onRestart} size="sm" variant="secondary">
            <Codicon name="debug-restart" size="0.875rem" />
            {restarting ? w.restarting : w.restartGateway}
          </Button>
        )}
        <Button onClick={onRecheck} size="sm" variant="ghost">
          {t.common.refresh}
        </Button>
      </div>
    </div>
  )
}

// ── Detail ──────────────────────────────────────────────────────────────────

function WebhookDetail({ hasPendingSecret, sub }: { hasPendingSecret: boolean; sub: WebhookRoute }) {
  const { t } = useI18n()
  const w = t.webhooks

  return (
    <PanelDetail>
      <header className="space-y-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h3 className="text-[0.95rem] font-semibold tracking-tight text-foreground">{sub.name}</h3>
          <PanelPill tone={sub.enabled ? 'good' : 'muted'}>{sub.enabled ? t.common.on : t.common.off}</PanelPill>
          {sub.deliver_only && <PanelPill tone="warn">{w.deliverOnly}</PanelPill>}
          {hasPendingSecret && <PanelPill tone="warn">{w.secretUnsaved}</PanelPill>}
        </div>

        <PanelMeta
          rows={[
            { label: w.fieldDeliver, value: w.deliverOptions[sub.deliver] ?? sub.deliver },
            {
              label: w.fieldEvents,
              value:
                sub.events.length === 0 ? (
                  w.allEvents
                ) : (
                  <span className="flex flex-wrap gap-1">
                    {sub.events.map(event => (
                      <PanelPill key={event}>{event}</PanelPill>
                    ))}
                  </span>
                )
            },
            ...(sub.skills.length > 0
              ? [
                  {
                    label: w.fieldSkills,
                    value: (
                      <span className="flex flex-wrap gap-1">
                        {sub.skills.map(skill => (
                          <PanelPill key={skill}>{skill}</PanelPill>
                        ))}
                      </span>
                    )
                  }
                ]
              : []),
            // Both of these come back on every summary and desktop's types never
            // declared them, so its page could not show either.
            ...(sub.created_at ? [{ label: w.fieldCreated, value: formatTimestamp(sub.created_at) }] : []),
            ...(sub.script ? [{ label: w.fieldScript, value: <span className="font-mono">{sub.script}</span> }] : []),
            { label: w.fieldSecret, value: sub.secret_set ? w.secretSet : w.secretMissing }
          ]}
        />

        <CopyValueRow label={w.webhookUrl} value={sub.url} />
      </header>

      {sub.description ? (
        <div className="space-y-1.5">
          <PanelSectionLabel>{w.fieldDescription}</PanelSectionLabel>
          <p className="text-xs leading-relaxed text-foreground/80">{sub.description}</p>
        </div>
      ) : null}

      {sub.prompt ? (
        <div className="space-y-1.5">
          <PanelSectionLabel>{w.fieldPrompt}</PanelSectionLabel>
          <PanelBlock>{sub.prompt}</PanelBlock>
        </div>
      ) : null}
    </PanelDetail>
  )
}

function formatTimestamp(iso: string): string {
  const date = new Date(iso)

  return Number.isNaN(date.valueOf()) ? iso : date.toLocaleString()
}

/**
 * A copyable value.
 *
 * NOT truncated, and `select-all`: this renders secrets, and a secret you can
 * only see half of is a secret you cannot transcribe when the clipboard refuses
 * — which on WebKitGTK it can (see lib/clipboard.ts). `CopyButton` surfaces that
 * refusal as an error state rather than a silent no-op, and `onCopyError`
 * escalates it to a toast so it can't be missed.
 */
function CopyValueRow({ label, onCopied, value }: { label: string; onCopied?: () => void; value: string }) {
  const { t } = useI18n()

  return (
    <div className="flex items-start gap-1 rounded bg-foreground/5 px-2.5 py-1.5 text-[0.7rem]">
      <span className="min-w-0 flex-1 select-all break-all font-mono text-foreground/80">{value}</span>
      <CopyButton
        appearance="icon"
        buttonSize="icon-sm"
        label={label}
        onCopied={onCopied}
        onCopyError={error => notifyError(error, t.common.copyFailed)}
        text={value}
      />
    </div>
  )
}

// ── The one-time secret ─────────────────────────────────────────────────────

/**
 * The secret reveal.
 *
 * Every dismissal path Radix offers is blocked while this is up — Esc, a click
 * outside, the close ✕ — so the two buttons are the only exits and both are
 * deliberate. Blocking Esc also stops it falling through to the OverlayView's
 * window-level Escape handler, which would otherwise close the whole page under
 * the dialog (Radix preventDefaults the event it dismisses on, and that guard
 * reads `defaultPrevented`).
 *
 * "Later" is a real exit, not a trap: the value stays in the atom, the row keeps
 * its "secret not saved" marker, and re-opening the page puts this dialog back.
 */
function SecretDialog({
  onAcknowledge,
  onLater,
  secret
}: {
  onAcknowledge: () => void
  onLater: () => void
  secret: null | { copied: boolean; name: string; secret: string; url: string }
}) {
  const { t } = useI18n()
  const w = t.webhooks

  return (
    <Dialog open={secret !== null}>
      <DialogContent
        className="max-w-lg"
        onEscapeKeyDown={event => event.preventDefault()}
        onInteractOutside={event => event.preventDefault()}
        onPointerDownOutside={event => event.preventDefault()}
        showCloseButton={false}
      >
        <DialogHeader>
          <DialogTitle>{w.createdTitle(secret?.name ?? '')}</DialogTitle>
          <DialogDescription>{w.secretOnceWarning}</DialogDescription>
        </DialogHeader>

        {secret ? (
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <PanelSectionLabel>{w.webhookUrl}</PanelSectionLabel>
              <CopyValueRow label={t.common.copy} value={secret.url} />
            </div>
            <div className="grid gap-1.5">
              <PanelSectionLabel>{w.secretOnce}</PanelSectionLabel>
              <CopyValueRow
                label={t.common.copy}
                onCopied={() => markWebhookSecretCopied(secret.name)}
                value={secret.secret}
              />
              <p className="text-[0.66rem] leading-4 text-muted-foreground">
                {secret.copied ? w.secretCopiedHint : w.secretNotCopiedHint}
              </p>
            </div>
            <p className="text-[0.66rem] leading-4 text-muted-foreground">{w.secretRecovery}</p>
          </div>
        ) : null}

        <DialogFooter>
          <Button onClick={onLater} size="sm" variant="outline">
            {w.secretLater}
          </Button>
          <Button onClick={onAcknowledge} size="sm">
            {w.secretSaved}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Create ──────────────────────────────────────────────────────────────────

function CreateWebhookDialog({
  onClose,
  onCreate,
  open
}: {
  onClose: () => void
  onCreate: (payload: Parameters<typeof createWebhook>[0]) => Promise<void>
  open: boolean
}) {
  const { t } = useI18n()
  const w = t.webhooks

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [prompt, setPrompt] = useState('')
  const [events, setEvents] = useState('')
  const [skills, setSkills] = useState('')
  const [deliver, setDeliver] = useState(DELIVER_LOG)
  const [deliverChatId, setDeliverChatId] = useState('')
  const [deliverOnly, setDeliverOnly] = useState(false)
  const [ownSecret, setOwnSecret] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<null | string>(null)

  useEffect(() => {
    if (open) {
      setName('')
      setDescription('')
      setPrompt('')
      setEvents('')
      setSkills('')
      setDeliver(DELIVER_LOG)
      setDeliverChatId('')
      setDeliverOnly(false)
      setOwnSecret('')
      setError(null)
    }
  }, [open])

  const normalized = normalizeWebhookName(name)
  const showNormalized = normalized !== '' && normalized !== name.trim()

  async function submit() {
    const invalid = webhookCreateError({ deliver, deliverOnly, name }, w)

    if (invalid) {
      setError(invalid)

      return
    }

    setBusy(true)
    setError(null)

    try {
      await onCreate({
        deliver,
        deliver_only: deliverOnly,
        ...(deliverChatId.trim() ? { deliver_chat_id: deliverChatId.trim() } : {}),
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(splitWebhookList(events).length ? { events: splitWebhookList(events) } : {}),
        name: normalized,
        ...(prompt.trim() ? { prompt: prompt.trim() } : {}),
        ...(ownSecret.trim() ? { secret: ownSecret.trim() } : {}),
        ...(splitWebhookList(skills).length ? { skills: splitWebhookList(skills) } : {})
      })
    } catch (err) {
      // Stay open with the form intact — a failed create must not look like a
      // succeeded one, and re-typing the whole form is not a recovery.
      setError(readableCreateError(err))
      notifyError(err, w.createFailed)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog onOpenChange={next => !next && !busy && onClose()} open={open}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{w.newSubscription}</DialogTitle>
          <DialogDescription>{w.createHint}</DialogDescription>
        </DialogHeader>

        <form
          className="grid gap-3"
          onSubmit={event => {
            event.preventDefault()
            void submit()
          }}
        >
          <div className="grid items-start gap-3 sm:grid-cols-2">
            <Field htmlFor="webhook-name" label={w.fieldName}>
              <Input
                autoFocus
                id="webhook-name"
                onChange={event => setName(event.target.value)}
                placeholder={w.fieldNamePlaceholder}
                value={name}
              />
              {showNormalized ? <FieldHint>{w.nameNormalized(normalized)}</FieldHint> : null}
            </Field>
            <Field htmlFor="webhook-description" label={w.fieldDescription}>
              <Input
                id="webhook-description"
                onChange={event => setDescription(event.target.value)}
                placeholder={w.fieldDescriptionPlaceholder}
                value={description}
              />
            </Field>
          </div>

          <Field htmlFor="webhook-prompt" label={w.fieldPrompt}>
            <Textarea
              className="min-h-20"
              id="webhook-prompt"
              onChange={event => setPrompt(event.target.value)}
              placeholder={w.fieldPromptPlaceholder}
              value={prompt}
            />
          </Field>

          <div className="grid items-start gap-3 sm:grid-cols-2">
            <Field htmlFor="webhook-events" label={w.fieldEvents}>
              <Input
                id="webhook-events"
                onChange={event => setEvents(event.target.value)}
                placeholder={w.fieldEventsPlaceholder}
                value={events}
              />
            </Field>
            <Field htmlFor="webhook-skills" label={w.fieldSkills}>
              <Input
                id="webhook-skills"
                onChange={event => setSkills(event.target.value)}
                placeholder={w.fieldSkillsPlaceholder}
                value={skills}
              />
            </Field>
          </div>

          <div className="grid items-start gap-3 sm:grid-cols-2">
            <Field htmlFor="webhook-deliver" label={w.fieldDeliver}>
              <Select
                onValueChange={next => {
                  setDeliver(next)

                  if (next === DELIVER_LOG) {
                    setDeliverOnly(false)
                    setDeliverChatId('')
                  }
                }}
                value={deliver}
              >
                <SelectTrigger className="h-9 rounded-md" id="webhook-deliver">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DELIVER_OPTIONS.map(option => (
                    <SelectItem key={option} value={option}>
                      {w.deliverOptions[option] ?? option}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            {/* `deliver_chat_id` is in the backend's create model and in
                desktop's payload type, but desktop's form never set it — so a
                telegram/discord delivery had no chat to land in. */}
            <Field htmlFor="webhook-deliver-chat" label={w.fieldDeliverChatId}>
              <Input
                disabled={deliver === DELIVER_LOG}
                id="webhook-deliver-chat"
                onChange={event => setDeliverChatId(event.target.value)}
                placeholder={deliver === DELIVER_LOG ? w.fieldDeliverChatDisabled : w.fieldDeliverChatPlaceholder}
                value={deliverChatId}
              />
            </Field>
          </div>

          <label className="flex items-start gap-2 text-xs" htmlFor="webhook-deliver-only">
            <Checkbox
              checked={deliverOnly}
              disabled={deliver === DELIVER_LOG}
              id="webhook-deliver-only"
              onCheckedChange={next => setDeliverOnly(next === true)}
            />
            <span>
              <span className="font-medium text-foreground">{w.fieldDeliverOnly}</span>
              <FieldHint>{deliver === DELIVER_LOG ? w.deliverOnlyNeedsTarget : w.fieldDeliverOnlyHint}</FieldHint>
            </span>
          </label>

          {/* The backend accepts a caller-supplied secret and desktop never
              offered it, which is what makes its one-time reveal load-bearing.
              Supplying your own removes the reveal from the critical path. */}
          <Field htmlFor="webhook-secret" label={w.fieldSecret}>
            <Input
              id="webhook-secret"
              onChange={event => setOwnSecret(event.target.value)}
              placeholder={w.fieldSecretPlaceholder}
              value={ownSecret}
            />
            <FieldHint>{w.fieldSecretHint}</FieldHint>
          </Field>

          {error ? <p className="text-xs text-destructive">{error}</p> : null}

          <DialogFooter>
            <Button disabled={busy} onClick={onClose} size="sm" type="button" variant="outline">
              {t.common.cancel}
            </Button>
            <Button disabled={busy} size="sm" type="submit">
              {busy ? w.creating : w.create}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function Field({ children, htmlFor, label }: { children: React.ReactNode; htmlFor: string; label: string }) {
  return (
    <div className="grid gap-1.5">
      <label className="flex items-baseline gap-2 text-xs font-medium text-foreground" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
    </div>
  )
}

function FieldHint({ children }: { children: React.ReactNode }) {
  return <p className="text-[0.66rem] leading-4 text-muted-foreground">{children}</p>
}
