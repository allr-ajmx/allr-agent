import { useCallback } from 'react'

import { NEW_CHAT_ROUTE, PET_SETTINGS_ROUTE, STARMAP_ROUTE } from '@/app/routes'
import type { BrowserManageResponse, SessionTitleResponse, SlashExecResponse } from '@/app/types'
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
import { navigateTo } from '@/lib/route-nav'
import { isSessionIdCandidate, renderCommandsCatalog, slashStatusText } from '@/lib/slash-utils'
import { setSessionYolo } from '@/lib/yolo-session'
import { $busy, $sessionId, appendSystemMessage, ensureSession, sendPrompt } from '@/store/chat'
import { setComposerDraft } from '@/store/composer'
import { $connection } from '@/store/connection'
import { requestGateway } from '@/store/gateway'
import { handoffSession } from '@/store/handoff'
import { NEW_SESSION_FLASH_EVENT } from '@/store/layout'
import { setModelPickerOpen } from '@/store/model'
import { notify, notifyError } from '@/store/notifications'
import { setPetScale } from '@/store/pet-gallery'
import { openPetGenerate } from '@/store/pet-generate'
import { $activeGatewayProfile, normalizeProfileKey, selectProfile } from '@/store/profile'
import {
  $sessions,
  $yoloActive,
  branchCurrentSession,
  newSession,
  openSession,
  refreshSessions,
  setSessionPickerOpen,
  setSessions
} from '@/store/session'
import { openAppRoute } from '@/store/windows'
import { useSkinCommand } from '@/themes'

/** Everything a slash handler needs about the invocation it's serving. */
interface SlashActionCtx {
  arg: string
  command: string
  name: string
  recordInput: boolean
}

/**
 * The `/slash` command dispatcher — ported from desktop's
 * app/session/hooks/use-prompt-actions/slash.ts. Universal keeps exactly one
 * live thread, so desktop's per-session plumbing (`activeSessionIdRef`,
 * `sessionHint`, `appendSessionTextMessage(sessionId, …)`) collapses onto the
 * chat store's active session + `appendSystemMessage`.
 */
export function useSlashCommand() {
  const { t } = useI18n()
  const copy = t.desktop
  const handleSkinCommand = useSkinCommand()

  return useCallback(
    async (rawCommand: string, options?: { recordInput?: boolean }) => {
      const ensureSessionId = async (): Promise<string | null> => {
        const existing = $sessionId.get()

        if (existing) {
          return existing
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
          appendSystemMessage(ctx.recordInput ? slashStatusText(ctx.command, text) : text)

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

          if ($busy.get()) {
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
        // Same three steps as the sidebar's New Session button / ⌘N
        // (nav-rail.tsx, use-keybinds.ts): reset the thread, land on the
        // new-chat route, flash the rail.
        new: async () => {
          newSession()
          navigateTo(NEW_CHAT_ROUTE)
          window.dispatchEvent(new CustomEvent(NEW_SESSION_FLASH_EVENT))
        },
        branch: async () => {
          await branchCurrentSession()
        },
        // /yolo is a per-session approval bypass, same scope as the TUI's
        // Shift+Tab. With no session yet we arm it locally; the session-create
        // path applies it on the first message.
        yolo: async () => {
          const sid = $sessionId.get()
          const next = !$yoloActive.get()

          if (!sid) {
            $yoloActive.set(next)
            notify({ kind: 'success', message: next ? copy.yoloArmed : copy.yoloOff })

            return
          }

          try {
            const active = await setSessionYolo(requestGateway, sid, next)
            appendSystemMessage(copy.yoloSystem(active))
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

          const sid = $sessionId.get()

          if (!sid) {
            notify({ kind: 'error', title: copy.sessionUnavailable, message: copy.createSessionFailed })

            return
          }

          const result = await handoffSession(platform, { sessionId: sid })

          if (!result.ok && result.error) {
            appendSystemMessage(recordInput ? slashStatusText(command, result.error) : result.error)
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
          if (!$sessionId.get()) {
            notify({ kind: 'success', message })

            return
          }

          appendSystemMessage(recordInput ? slashStatusText(command, message) : message)
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

          if ($connection.get()?.mode === 'remote') {
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

          appendSystemMessage(copy.emptySlashCommand)

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
    [copy, handleSkinCommand]
  )
}
