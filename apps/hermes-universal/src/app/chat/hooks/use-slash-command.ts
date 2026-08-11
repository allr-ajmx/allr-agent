import { useCallback } from 'react'

import { useSessionView } from '@/app/chat/session-view'
import { PET_SETTINGS_ROUTE, STARMAP_ROUTE } from '@/app/routes'
import type {
  BrowserManageResponse,
  SessionCompressResponse,
  SessionTitleResponse,
  SlashExecResponse
} from '@/app/types'
import { getProfiles } from '@/hermes'
import { useI18n } from '@/i18n'
import { parseCommandDispatch, parseSlashCommand, sessionTitle } from '@/lib/chat-runtime'
import {
  type CommandsCatalogLike,
  type DesktopActionId,
  type DesktopPickerId,
  desktopSlashUnavailableMessage,
  isDesktopSlashCommand,
  resolveDesktopCommand
} from '@/lib/desktop-slash-commands'
import { FOCUS_USAGE, formatFocusStatus, formatFocusToggleMessage, resolveFocusArg } from '@/lib/focus-view'
import { isMissingRpcMethod } from '@/lib/gateway-rpc'
import { navigateTo } from '@/lib/route-nav'
import { toChatMessages } from '@/lib/session-history'
import { isSessionIdCandidate, renderCommandsCatalog, slashStatusText } from '@/lib/slash-utils'
import { setSessionYolo } from '@/lib/yolo-session'
import { appendSessionSystemMessage, ensureSession, sendPrompt } from '@/store/chat'
import { setSessionCompacting } from '@/store/compaction'
import { setComposerDraft } from '@/store/composer'
import { $connection } from '@/store/connection'
import { $focusView, pushFocusView } from '@/store/focus-view'
import { requestGateway } from '@/store/gateway'
import { handoffSession } from '@/store/handoff'
import { setModelPickerOpen } from '@/store/model'
import { startNewSession } from '@/store/new-session'
import { dismissNotification, notify, notifyError } from '@/store/notifications'
import { setPetScale } from '@/store/pet-gallery'
import { openPetGenerate } from '@/store/pet-generate'
import { $activeGatewayProfile, normalizeProfileKey, selectProfile } from '@/store/profile'
import {
  $activeStoredSessionId,
  $sessions,
  $yoloActive,
  branchCurrentSession,
  openSession,
  refreshSessions,
  setSessionPickerOpen,
  setSessions
} from '@/store/session'
import { withSessionNotFoundResume } from '@/store/session-recovery'
import { $activeSessionKey, $sessionStates, updateSession } from '@/store/session-state-types'
import { openAppRoute } from '@/store/windows'
import { useSkinCommand } from '@/themes'
import type { UsageStats } from '@/types/hermes'

/**
 * `session.compress` is an LLM call over the whole conversation — minutes on a
 * large session. The default WS timeout would abandon it long before the
 * gateway answers, which is the whole reason it is not an exec command.
 */
const SESSION_COMPRESS_TIMEOUT_MS = 120_000

/** In-flight compress claims, by runtime session id. Module-level so a remount
 *  mid-compression can't fire a second summarize call for the same session. */
const compressInFlight = new Set<string>()

const EMPTY_USAGE: UsageStats = { calls: 0, input: 0, output: 0, total: 0 }

/** Everything a slash handler needs about the invocation it's serving. */
interface SlashActionCtx {
  arg: string
  command: string
  name: string
  recordInput: boolean
}

/**
 * The `/slash` command dispatcher — ported from desktop's
 * app/session/hooks/use-prompt-actions/slash.ts.
 *
 * The TARGET is the session of the surface this hook is mounted in, read through
 * `useSessionView()` — the same context the composer around it, its prompt bars
 * and its transcript already read from. It used to be the ACTIVE session
 * unconditionally, which was true while universal had one thread and false from
 * the moment tiles landed: a tile's composer runs this hook under the tile's
 * view, so `/compress` typed into a tile summarized the MAIN pane's session and
 * replaced the main pane's transcript with the result. Every other session-bound
 * command (`/title`, `/yolo`, `/handoff`, `/browser`, `slash.exec`,
 * `command.dispatch`) was misrouted the same way, and their output printed into
 * the main pane too (MJXHRM-357).
 *
 * `store/session-tile-delegate.ts` still exposes `executeSlash` for this, from
 * before the local dispatcher was ported; it has had no caller since. Routing
 * through it is not the fix — it submits the raw command as PROMPT TEXT, so
 * `/model`, `/new` and the other client-side verbs would reach the agent as
 * words instead of running.
 */
export function useSlashCommand() {
  const { t } = useI18n()
  const copy = t.desktop
  const handleSkinCommand = useSkinCommand()
  const view = useSessionView()

  return useCallback(
    async (rawCommand: string, options?: { recordInput?: boolean }) => {
      /** The session KEY this command acts on — the surface's own, never the
       *  foreground one. Read per call, not captured: `ensureSession()` rekeys a
       *  draft onto its runtime id mid-command. */
      const targetKey = (): string => view.$runtimeId.get() || $activeSessionKey.get()

      /** Its WIRE id, or null for a draft that has never been created. */
      const targetSessionId = (): null | string => $sessionStates.get()[targetKey()]?.runtimeSessionId ?? null

      const appendTargetSystemMessage = (text: string) => appendSessionSystemMessage(targetKey(), text)

      const ensureSessionId = async (): Promise<string | null> => {
        const existing = targetSessionId()

        if (existing) {
          return existing
        }

        // Only the primary surface can conjure a session: a tile is a view of one
        // that already exists, and `ensureSession` creates against the ACTIVE key.
        if (view.kind !== 'primary') {
          return null
        }

        try {
          return (await ensureSession()).id
        } catch {
          return null
        }
      }

      // Resolve the target session plus a writer for inline slash output, or
      // notify + return null when none can be created. Folds the ensure / bail /
      // build-renderSlashOutput boilerplate every exec-style handler repeats.
      const withSlashOutput = async (
        ctx: SlashActionCtx
      ): Promise<{ render: (text: string) => void; sessionId: string } | null> => {
        const sessionId = await ensureSessionId()

        if (!sessionId) {
          notify({ kind: 'error', title: copy.sessionUnavailable, message: copy.createSessionFailed })

          return null
        }

        const render = (text: string) =>
          appendTargetSystemMessage(ctx.recordInput ? slashStatusText(ctx.command, text) : text)

        return { render, sessionId }
      }

      // `exec` commands (and unknown skill / quick commands the backend owns)
      // run on the gateway and render their text output inline. This is the only
      // path that talks to slash.exec / command.dispatch.
      async function runExec(ctx: SlashActionCtx): Promise<void> {
        const { arg, command, name } = ctx
        const resolved = await withSlashOutput(ctx)

        if (!resolved) {
          return
        }

        const { render: renderSlashOutput, sessionId } = resolved

        if (!isDesktopSlashCommand(name)) {
          renderSlashOutput(desktopSlashUnavailableMessage(name) || `/${name} is not available in this app.`)

          return
        }

        const handleDispatch = async (
          dispatch: NonNullable<ReturnType<typeof parseCommandDispatch>>
        ): Promise<void> => {
          if (dispatch.type === 'exec' || dispatch.type === 'plugin') {
            renderSlashOutput(dispatch.output ?? '(no output)')

            return
          }

          if (dispatch.type === 'alias') {
            await runSlash(`/${dispatch.target}${arg ? ` ${arg}` : ''}`, false)

            return
          }

          // send / prefill carry an optional `notice` (e.g. "⊙ Goal set …")
          // that the backend wants shown as a system line before the message
          // is acted on. Mirrors the TUI's createSlashHandler — without it a
          // `/goal <text>` looked like it did nothing.
          if ((dispatch.type === 'send' || dispatch.type === 'prefill') && dispatch.notice?.trim()) {
            renderSlashOutput(dispatch.notice.trim())
          }

          const message = ('message' in dispatch ? dispatch.message : '')?.trim() ?? ''

          // /undo returns a prefill directive: drop the backed-up message into
          // the composer for editing instead of submitting it immediately.
          if (dispatch.type === 'prefill') {
            if (message) {
              setComposerDraft(message)
            }

            return
          }

          if (!message) {
            renderSlashOutput(
              `/${name}: ${dispatch.type === 'skill' ? 'skill payload missing message' : 'empty message'}`
            )

            return
          }

          if (dispatch.type === 'skill') {
            renderSlashOutput(`⚡ loading skill: ${dispatch.name}`)
          }

          if ($sessionStates.get()[targetKey()]?.busy) {
            renderSlashOutput('session busy — /interrupt the current turn before sending this command')

            return
          }

          await sendPrompt(message)
        }

        try {
          const result = await requestGateway<unknown>('slash.exec', {
            session_id: sessionId,
            command: command.replace(/^\/+/, '')
          })

          const dispatch = parseCommandDispatch(result)

          if (dispatch) {
            await handleDispatch(dispatch)

            return
          }

          const output = result && typeof result === 'object' ? (result as SlashExecResponse) : null
          const body = output?.output || `/${name}: no output`
          renderSlashOutput(output?.warning ? `warning: ${output.warning}\n${body}` : body)

          return
        } catch {
          // Fall back to command.dispatch for skill/send/alias directives.
        }

        try {
          const dispatch = parseCommandDispatch(
            await requestGateway<unknown>('command.dispatch', { session_id: sessionId, name, arg })
          )

          if (!dispatch) {
            renderSlashOutput('error: invalid response: command.dispatch')

            return
          }

          await handleDispatch(dispatch)
        } catch (err) {
          renderSlashOutput(`error: ${err instanceof Error ? err.message : String(err)}`)
        }
      }

      // One handler per `action` command. Adding a command is a registry row in
      // desktop-slash-commands.ts plus an entry here — never a new branch in a
      // dispatch ladder.
      const actionHandlers: Record<DesktopActionId, (ctx: SlashActionCtx) => Promise<void>> = {
        // The same act as the sidebar's New session row and ⌘N, through the
        // one helper all three share (store/new-session.ts).
        new: async () => {
          startNewSession()
        },
        branch: async () => {
          await branchCurrentSession()
        },
        // /compress (alias /compact) runs the gateway's dedicated
        // `session.compress` RPC — the TUI's own path. It must NOT go through
        // runExec: summarizing a large session outlives the slash worker's pipe
        // timeout (45s) and the WS default, and the resulting slash.exec error
        // cascades into command.dispatch's misleading "not a quick/plugin/skill
        // command: compress".
        //
        // The RPC hands back the POST-compress history (the same shape
        // session.resume returns), so the transcript is replaced from it —
        // otherwise the bubbles that were just summarized away stay on screen
        // forever. Scoped to the submitting session KEY, so a late result after
        // a chat switch refreshes its own slice instead of the foreground one.
        compress: async ctx => {
          const resolved = await withSlashOutput(ctx)

          if (!resolved) {
            return
          }

          const { render: renderSlashOutput, sessionId } = resolved
          // MUTABLE: a stale-runtime recovery below rekeys the slice onto the
          // recovered runtime id, and everything after the await — the
          // transcript replacement, the usage fold, and the `finally` that
          // releases the compacting flag — has to address the session where it
          // now lives (MJXHRM-308).
          let key = targetKey()
          const focusTopic = ctx.arg.trim()
          const noticeId = `session-compress:${sessionId}`

          // Coalesce concurrent requests for one session, so a double-Enter
          // can't fire two summarize calls against the same conversation.
          if (compressInFlight.has(sessionId)) {
            return
          }

          compressInFlight.add(sessionId)
          // The composer gates on this too: a correction typed while the
          // context is being summarized has no live model request to redirect,
          // so it queues instead of being dropped.
          setSessionCompacting(key, true)
          notify({
            durationMs: 0,
            id: noticeId,
            kind: 'info',
            message: focusTopic ? copy.compress.workingOn(focusTopic) : copy.compress.working
          })

          try {
            // A compress after sleep/wake used to surface a raw "session not
            // found": the runtime id is dead while the STORED session is fine.
            // One shared resolver rebinds it and retries once (MJXHRM-219).
            // `alsoTimeout` stays off — compress is an LLM call over the whole
            // conversation, and re-firing a slow one would double the work.
            //
            // The stored id comes from the SUBMITTING slice, not from
            // `$activeStoredSessionId`: they differ for anything resumed (the
            // sidebar selection is not the slice's own durable id), and this
            // value is what the recovery resumes FROM — the same latent bug
            // PR #102 fixed for `ensureSession()`.
            const {
              recovered,
              result,
              sessionId: recoveredId
            } = await withSessionNotFoundResume(
              sessionId,
              $sessionStates.get()[key]?.storedSessionId ?? $activeStoredSessionId.get(),
              live =>
                requestGateway<SessionCompressResponse>(
                  'session.compress',
                  { session_id: live, ...(focusTopic && { focus_topic: focusTopic }) },
                  SESSION_COMPRESS_TIMEOUT_MS
                )
            )

            // The slice moved. Writing to the key we started on would resurrect
            // an EMPTY ghost slice under a dead key (`updateSession` creates on
            // demand) and land the summarized history there, leaving the real
            // session showing the very bubbles the compaction just removed.
            if (recovered) {
              key = recoveredId
            }

            if (Array.isArray(result?.messages)) {
              const messages = toChatMessages(result.messages)
              updateSession(key, state => ({ ...state, messages }))
            }

            const usage = { ...result?.usage, ...result?.info?.usage }

            if (Object.keys(usage).length > 0) {
              updateSession(key, state => ({ ...state, usage: { ...EMPTY_USAGE, ...state.usage, ...usage } }))
            }

            if (result?.info?.title !== undefined) {
              const title = result.info.title || null
              setSessions(prev => prev.map(s => (s.id === sessionId ? { ...s, title } : s)))
            }

            const lines = [result?.summary?.headline, result?.summary?.token_line, result?.summary?.note].filter(
              (line): line is string => Boolean(line)
            )

            if (result?.summary?.headline) {
              const aborted = result.status === 'aborted' || result.summary.aborted === true

              // A successful compression earns a durable system line; an abort
              // stays transient, because appending an error to the transcript
              // reads as a state change that did not happen.
              if (!aborted) {
                renderSlashOutput(lines.join('\n'))
              }

              notify({
                durationMs: 5_000,
                id: noticeId,
                kind: aborted ? 'error' : 'success',
                message: lines.join('\n')
              })

              return
            }

            const hostOutput = result?.host_ack?.output?.trim()
            const removed = result?.removed ?? 0

            const message =
              hostOutput || (removed > 0 ? copy.compress.removed(removed) : copy.compress.nothingToCompress)

            renderSlashOutput(message)
            notify({ durationMs: 5_000, id: noticeId, kind: 'success', message })
          } catch (err) {
            dismissNotification(noticeId)

            // App and gateway update independently: an older gateway that has
            // not shipped session.compress must not turn a once-working command
            // into "method not found". It cannot offer the longer timeout, but
            // the slash-worker path still summarizes.
            if (isMissingRpcMethod(err)) {
              await runExec(ctx)

              return
            }

            renderSlashOutput(`error: ${err instanceof Error ? err.message : String(err)}`)
          } finally {
            compressInFlight.delete(sessionId)
            setSessionCompacting(key, false)
          }
        },
        // /yolo is a per-session approval bypass, same scope as the TUI's
        // Shift+Tab. With no session yet we arm it locally; the session-create
        // path applies it on the first message.
        yolo: async () => {
          const sid = targetSessionId()
          const next = !$yoloActive.get()

          if (!sid) {
            $yoloActive.set(next)
            notify({ kind: 'success', message: next ? copy.yoloArmed : copy.yoloOff })

            return
          }

          try {
            const active = await setSessionYolo(requestGateway, sid, next)
            appendTargetSystemMessage(copy.yoloSystem(active))
          } catch {
            notify({ kind: 'error', title: copy.yoloTitle, message: copy.yoloToggleFailed })
          }
        },
        // /handoff hands this session to a messaging platform. The platform is
        // completed inline in the slash popover (backend _handoff_completions),
        // so there is no overlay: `/handoff <platform>` runs the handoff RPC
        // chain directly. cli_only on the backend, so it must never reach
        // slash.exec.
        handoff: async ({ arg, command, recordInput }) => {
          const platform = arg.trim()

          if (!platform) {
            notify({ kind: 'success', message: copy.handoff.pickPlatform })

            return
          }

          const sid = targetSessionId()

          if (!sid) {
            notify({ kind: 'error', title: copy.sessionUnavailable, message: copy.createSessionFailed })

            return
          }

          const result = await handoffSession(platform, { sessionId: sid })

          if (!result.ok && result.error) {
            appendTargetSystemMessage(recordInput ? slashStatusText(command, result.error) : result.error)
          }
        },
        // /focus is the reduced-output display mode. It runs LOCALLY (the
        // transcript hides tool rows and offers them back per run) and then
        // records the shared `display.focus_view` flag so the mode travels to
        // the CLI. It must never reach slash.exec: the gateway's own /focus
        // answers by pinning tool progress off, which stops the tool events
        // this client renders from — and needs — arriving at all.
        focus: async ctx => {
          // No session yet: toast it rather than spinning up a backend session
          // just to print a line about how this app renders. Same call `/skin`
          // makes, for the same reason.
          const renderSlashOutput = targetSessionId()
            ? ((await withSlashOutput(ctx))?.render ?? ((message: string) => notify({ kind: 'success', message })))
            : (message: string) => notify({ kind: 'success', message })

          const { action, target } = resolveFocusArg(ctx.arg, $focusView.get())

          if (action === 'usage') {
            renderSlashOutput(FOCUS_USAGE)

            return
          }

          if (action === 'status' || target === null) {
            renderSlashOutput(formatFocusStatus($focusView.get()))

            return
          }

          if (target === $focusView.get()) {
            // Idempotent explicit set — report without writing config.
            renderSlashOutput(formatFocusToggleMessage(target))

            return
          }

          try {
            const { displayOnly, enabled } = await pushFocusView(requestGateway, target)

            const note = displayOnly
              ? ''
              : '\nThis gateway also stopped sending tool activity for this session, so new turns will have nothing to reveal.'

            renderSlashOutput(`${formatFocusToggleMessage(enabled)}${note}`)
          } catch (err) {
            // The local half already applied — say so, and say what didn't.
            renderSlashOutput(
              `${formatFocusToggleMessage($focusView.get())} (this app only — the gateway did not record it: ${
                err instanceof Error ? err.message : String(err)
              })`
            )
          }
        },
        // /profile switches which profile the app operates as. Desktop points
        // only the NEXT new chat at it (its profile is per-session); universal
        // re-scopes its REST calls instead (store/profile selectProfile), which
        // lands on the same "new chats use this profile" outcome.
        profile: async ({ arg }) => {
          const target = arg.trim()
          const current = normalizeProfileKey($activeGatewayProfile.get())

          if (!target) {
            notify({ kind: 'success', message: copy.profileStatus(current) })

            return
          }

          try {
            const { profiles } = await getProfiles()
            const match = profiles.find(profile => profile.name === target)

            if (!match) {
              notify({
                kind: 'error',
                title: copy.unknownProfile,
                message: copy.noProfileNamed(target, profiles.map(profile => profile.name).join(', '))
              })

              return
            }

            selectProfile(match.name)
            notify({ kind: 'success', message: copy.newChatsProfile(match.name) })
          } catch (err) {
            notifyError(err, copy.setProfileFailed)
          }
        },
        skin: async ({ arg, command, recordInput }) => {
          const message = handleSkinCommand(arg)

          // No session to print into yet — surface it as a toast instead of
          // spinning up a backend session just to change the theme.
          if (!targetSessionId()) {
            notify({ kind: 'success', message })

            return
          }

          appendTargetSystemMessage(recordInput ? slashStatusText(command, message) : message)
        },
        // /title <name> renames via the gateway's session.title RPC — the same
        // path the TUI uses, NOT REST renameSession (which 404s on runtime ids).
        // Bare /title shows the current title, which the worker owns, so
        // delegate to exec.
        title: async ctx => {
          if (!ctx.arg) {
            await runExec(ctx)

            return
          }

          const resolved = await withSlashOutput(ctx)

          if (!resolved) {
            return
          }

          const { render: renderSlashOutput, sessionId } = resolved
          const { arg } = ctx

          try {
            const result = await requestGateway<SessionTitleResponse>('session.title', {
              session_id: sessionId,
              title: arg
            })

            const finalTitle = (result?.title || arg).trim()
            const queued = result?.pending === true

            setSessions(prev => prev.map(s => (s.id === sessionId ? { ...s, title: finalTitle || null } : s)))
            await refreshSessions().catch(() => undefined)
            renderSlashOutput(
              finalTitle
                ? `Session title set: ${finalTitle}${queued ? ' (queued while session initializes)' : ''}`
                : 'Session title cleared.'
            )
          } catch (err) {
            renderSlashOutput(`error: ${err instanceof Error ? err.message : String(err)}`)
          }
        },
        help: async ctx => {
          const resolved = await withSlashOutput(ctx)

          if (!resolved) {
            return
          }

          const { render: renderSlashOutput, sessionId } = resolved

          try {
            const catalog = await requestGateway<CommandsCatalogLike>('commands.catalog', { session_id: sessionId })

            renderSlashOutput(renderCommandsCatalog(catalog, copy))
          } catch (err) {
            renderSlashOutput(`error: ${err instanceof Error ? err.message : String(err)}`)
          }
        },
        // /journey (aliases /learning, /memory-graph) opens the starmap overlay —
        // this app's visual counterpart of the TUI journey timeline — instead of
        // printing a text rendering into the transcript. Args are ignored,
        // matching the TUI overlay behavior.
        journey: async () => {
          navigateTo(STARMAP_ROUTE)
        },
        // /hatch opens the pet generator (generate→pick→hatch→adopt). A typed
        // description seeds the prompt so `/hatch a cyber fox` lands on the
        // composer step prefilled.
        hatch: async ({ arg }) => {
          openPetGenerate(arg.trim())
        },
        pet: async ctx => {
          const [sub = '', rawValue = ''] = ctx.arg.trim().split(/\s+/)
          const lower = sub.toLowerCase()

          if (lower === 'list' || lower === 'gallery' || lower === 'browse' || lower === 'all') {
            openAppRoute(PET_SETTINGS_ROUTE)

            return
          }

          // `/pet scale <n>` resizes the pet locally (instant) and persists via
          // the store — no round-trip to the slash worker.
          if (lower === 'scale') {
            const value = Number(rawValue)

            if (!rawValue || Number.isNaN(value)) {
              const resolved = await withSlashOutput(ctx)
              resolved?.render('usage: /pet scale <factor>  (e.g. /pet scale 0.5)')

              return
            }

            setPetScale(value)

            return
          }

          await runExec(ctx)
        },
        // /browser connect|disconnect|status manages the live CDP connection on
        // the gateway host, mirroring the TUI's browser.manage RPC. It mutates
        // BROWSER_CDP_URL (and may launch Chrome) in the gateway process — only
        // meaningful when that process runs on this machine, so it's gated to
        // local connections. A remote gateway would act on the wrong host.
        browser: async ctx => {
          const resolved = await withSlashOutput(ctx)

          if (!resolved) {
            return
          }

          const { render: renderSlashOutput, sessionId } = resolved

          // /browser drives a Chromium on the GATEWAY host, so it is unavailable
          // for every mode whose gateway is not this machine. `cloud` was missing
          // from this check before ssh existed — a pre-existing gap, fixed here.
          const gatewayMode = $connection.get()?.mode

          if (gatewayMode === 'remote' || gatewayMode === 'cloud' || gatewayMode === 'ssh') {
            renderSlashOutput(
              '/browser manages a Chromium-family browser on the gateway host — only available when connected to a local gateway.'
            )

            return
          }

          const [rawAction = 'status', ...rest] = ctx.arg.trim().split(/\s+/).filter(Boolean)
          const cmdAction = rawAction.toLowerCase()

          if (!['connect', 'disconnect', 'status'].includes(cmdAction)) {
            renderSlashOutput(
              'usage: /browser [connect|disconnect|status] [url] · persistent: set browser.cdp_url in config.yaml'
            )

            return
          }

          const url = cmdAction === 'connect' ? rest.join(' ').trim() || 'http://127.0.0.1:9222' : undefined

          if (url) {
            renderSlashOutput(`checking Chromium-family browser remote debugging at ${url}...`)
          }

          try {
            const result = await requestGateway<BrowserManageResponse>('browser.manage', {
              action: cmdAction,
              session_id: sessionId,
              ...(url && { url })
            })

            // Without a streamed session subscription, the gateway bundles its
            // progress lines into `messages` — flush them inline.
            result?.messages?.forEach(message => renderSlashOutput(message))

            if (cmdAction === 'status') {
              renderSlashOutput(
                result?.connected
                  ? `browser connected: ${result.url || '(url unavailable)'}`
                  : 'browser not connected (try /browser connect <url> or set browser.cdp_url in config.yaml)'
              )

              return
            }

            if (cmdAction === 'disconnect') {
              renderSlashOutput('browser disconnected')

              return
            }

            if (result?.connected) {
              renderSlashOutput('Browser connected to live Chromium-family browser via CDP')
              renderSlashOutput(`Endpoint: ${result.url || '(url unavailable)'}`)
              renderSlashOutput('next browser tool call will use this CDP endpoint')
            }
          } catch (err) {
            renderSlashOutput(`error: ${err instanceof Error ? err.message : String(err)}`)
          }
        }
      }

      // Picker commands open an overlay; a typed arg is resolved by that picker
      // so the command never dead-ends or falls through to the backend.
      const openPicker = async (pickerId: DesktopPickerId, ctx: SlashActionCtx): Promise<void> => {
        if (pickerId === 'model') {
          if (!ctx.arg.trim()) {
            setModelPickerOpen(true)

            return
          }

          // Power users can still type `/model <name>` — run it on the backend.
          await runExec(ctx)

          return
        }

        // session picker — /resume, /sessions, /switch
        const query = ctx.arg.trim()

        if (!query) {
          setSessionPickerOpen(true)

          return
        }

        const sessions = $sessions.get()
        const lower = query.toLowerCase()

        const match =
          sessions.find(session => session.id === query) ||
          sessions.find(session => sessionTitle(session).toLowerCase().includes(lower)) ||
          sessions.find(session => (session.preview ?? '').toLowerCase().includes(lower))

        if (!match) {
          if (isSessionIdCandidate(query)) {
            await openSession(query)

            return
          }

          notify({ kind: 'error', message: copy.resumeFailed })

          return
        }

        await openSession(match.id)
      }

      // The whole dispatcher: resolve the command's local surface, then act on
      // its kind. No per-command ladder — behavior lives in the registry.
      async function runSlash(commandText: string, recordInput = true): Promise<void> {
        const command = commandText.trim()
        const { name, arg } = parseSlashCommand(command)

        if (!name) {
          // The composer draft was already cleared on submit, and slash input
          // never lands in the Up-arrow history ring (it derives from sent user
          // messages) — so without this restore, any payload after a degenerate
          // slash (`/ text`, `/` + newline) is lost forever. Hand it back.
          if (command.replace(/^\/+/, '').trim()) {
            setComposerDraft(command)
          }

          appendTargetSystemMessage(copy.emptySlashCommand)

          return
        }

        const ctx: SlashActionCtx = { arg, command, name, recordInput }
        const surface = resolveDesktopCommand(`/${name}`)?.surface

        switch (surface?.kind) {
          case 'unavailable': {
            const resolved = await withSlashOutput(ctx)
            resolved?.render(desktopSlashUnavailableMessage(name) || `/${name} is not available in this app.`)

            return
          }

          case 'picker':
            return openPicker(surface.picker, ctx)

          case 'action':
            return actionHandlers[surface.action](ctx)

          default:
            // exec spec, or an unknown skill / quick command the backend owns.
            return runExec(ctx)
        }
      }

      await runSlash(rawCommand, options?.recordInput ?? true)
    },
    [copy, handleSkinCommand, view]
  )
}
