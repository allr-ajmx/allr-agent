import { useCallback, useEffect } from 'react'

import {
  pickAttachment,
  pickFolderAttachment,
  pickRemoteAttachment,
  pickRemoteFolderAttachment,
  stageAttachmentFromBlob,
  type StagedAttachment,
  stagedToComposerAttachment
} from '@/app/chat/attachments'
import { ChatBar } from '@/app/chat/composer'
import { useComposerScope } from '@/app/chat/composer/scope'
import { useSlashCommand } from '@/app/chat/hooks/use-slash-command'
import { useSessionView } from '@/app/chat/session-view'
import { setPrimarySlashRunner } from '@/app/chat/slash-runner'
import { submitPromptToSurface } from '@/app/chat/surface-submit'
import { ModelMenuPanel } from '@/app/shell/model-menu-panel'
import { transcribeAudio } from '@/hermes'
import { translateNow } from '@/i18n'
import { SLASH_COMMAND_RE } from '@/lib/chat-runtime'
import { canReadClipboardImage, readClipboardImage } from '@/lib/clipboard'
import { gatewayOwnsLocalFs } from '@/lib/desktop-fs'
import { triggerHaptic } from '@/lib/haptics'
import { useStore } from '@/store/atom'
import { interruptSession, redirectPrompt } from '@/store/chat'
import { type ComposerAttachment } from '@/store/composer'
import { $connection } from '@/store/connection'
import { $gatewayState, getGatewayClient, requestGateway } from '@/store/gateway'
import { refreshCurrentModel, selectModel } from '@/store/model'
import { notify, notifyError } from '@/store/notifications'
import { $activeSessionKey } from '@/store/session-state-types'
import { sessionTileDelegate } from '@/store/session-states'

// Read a recorded audio blob into a base64 data URL for the gateway audio.* RPC.
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

// The fully-wired chat composer (the ported desktop ChatBar plus universal's
// submit/cancel/attachment/transcribe plumbing), extracted from ChatScreen so it
// can be reused on its own — e.g. the mobile shell mounts just this composer.
//
// Like ChatScreen it reads from the SessionView / ComposerScope contexts, which
// default to the PRIMARY session (whose atoms ARE the global chat atoms), so
// rendered bare it drives the primary chat. It MUST be mounted inside a
// <ChatRuntimeProvider> so ComposerPrimitive.Input / the trigger popover have
// runtime context.
export function ChatComposer() {
  const view = useSessionView()
  const scope = useComposerScope()
  const isPrimary = view.kind === 'primary'

  const busy = useStore(view.$busy)
  const sessionId = useStore(view.$runtimeId)
  const cwd = useStore(view.$cwd)
  const currentModel = useStore(view.$model)
  const currentProvider = useStore(view.$provider)
  const gatewayState = useStore($gatewayState)
  // Subscribed, not read once: the attach menu's local/remote shape depends on
  // the gateway's mode, and a soft switch changes it under a mounted composer.
  const connection = useStore($connection)
  const executeSlashCommand = useSlashCommand()

  // Seed the composer's model/provider from the profile default once the gateway
  // is up (only fills an empty selection). Primary only — a tile shows its own
  // session's model and must not overwrite the global default.
  useEffect(() => {
    if (isPrimary && gatewayState === 'open') {
      void refreshCurrentModel()
    }
  }, [isPrimary, gatewayState])

  // Lend the dispatcher to the one caller that has text to run and no React
  // context to run it from: Quick Entry's bridge (app/chat/slash-runner.ts).
  // Primary only — the dispatcher acts on the view it was built under, and a
  // tile's would run a captured `/compress` against the tile.
  useEffect(() => {
    if (!isPrimary) {
      return
    }

    setPrimarySlashRunner(executeSlashCommand)

    return () => setPrimarySlashRunner(null)
  }, [executeSlashCommand, isPrimary])

  // Route the fully-composed prompt to universal's gateway path. The ported
  // ChatBar owns draft/queue/history internally, so the parent only sends: slash
  // commands are dispatched locally (client actions, overlay pickers, or the
  // gateway's slash.exec — `/skin` included) and never reach the agent as prompt
  // text; staged attachment refs are spliced ahead of the text. Returns true once
  // the send is issued.
  const onSubmit = useCallback(
    async (text: string, options?: { attachments?: ComposerAttachment[] }): Promise<boolean> => {
      // Attachments mean this is a real prompt that merely starts with a slash —
      // desktop's composer applies the same guard before routing to the dispatcher.
      if (!options?.attachments?.length && SLASH_COMMAND_RE.test(text.trim())) {
        void triggerHaptic('success')
        await executeSlashCommand(text)

        return true
      }

      const refs = (options?.attachments ?? []).map(a => a.refText).filter((r): r is string => Boolean(r))
      const full = [...refs, text].filter(Boolean).join(' ')

      if (!full.trim()) {
        return false
      }

      // Route by surface: the main composer submits the primary chat; a tile's
      // composer submits to its own session through the tile delegate. Shared
      // with the slash dispatcher's `send` directive so the two cannot disagree
      // about which session a submit belongs to (MJXHRM-419), and so a tile with
      // no live session says so instead of swallowing the text the composer has
      // already cleared.
      await submitPromptToSurface(view, full)

      return true
    },
    [executeSlashCommand, view]
  )

  // Stop and correct: cancel the live model request and rebuild the turn with
  // this text, keeping the reasoning and completed work already on screen. The
  // composer queues the words itself when this resolves false, so a runtime
  // that cannot redirect loses nothing.
  // `$runtimeId` is the session KEY (see app/chat/session-view), so a tile's
  // composer corrects the tile's own turn.
  const onSteer = useCallback(
    (text: string): Promise<boolean> => redirectPrompt(text, view.$runtimeId.get() ?? $activeSessionKey.get()),
    [view]
  )

  // Interrupt the running turn (Esc / Stop). Runs through `interruptSession`,
  // which recovers a dead runtime binding and raises a toast when the interrupt
  // genuinely fails — this used to be a bare `.catch(() => {})`, so after a
  // sleep/wake Stop silently did nothing (MJXHRM-366).
  const onCancel = useCallback(() => {
    const sid = view.$runtimeId.get()

    if (!sid) {
      return
    }

    if (scope.target === 'main') {
      void interruptSession(sid)
    } else {
      void sessionTileDelegate()?.interruptSession(sid)
    }
  }, [scope, view])

  // Memoized so the five pickers below can NAME it as a dependency. It closes
  // over nothing but the scope, which every one of them already depended on, so
  // this is the same function with the same identity churn — it is just no
  // longer an omitted dependency.
  const addStagedToScope = useCallback(
    (staged: StagedAttachment | null) => {
      if (staged) {
        scope.attachments.add(stagedToComposerAttachment(staged))
      }
    },
    [scope]
  )

  const onPickFiles = useCallback(() => void pickAttachment().then(addStagedToScope), [addStagedToScope])
  const onPickImages = useCallback(() => void pickAttachment().then(addStagedToScope), [addStagedToScope])
  const onPickFolders = useCallback(() => void pickFolderAttachment().then(addStagedToScope), [addStagedToScope])

  // IMAGE PASTE / DROP. The composer has always extracted image blobs off the
  // paste event and always called `preventDefault()` on them — but nothing ever
  // passed it a handler, so on universal a pasted screenshot was swallowed and
  // nothing appeared. Blobs have no path, which is why they stage through
  // `file.attach`'s `data_url` arm (MJXHRM-415).
  const onAttachImageBlob = useCallback(
    async (blob: Blob) => {
      const staged = await stageAttachmentFromBlob(blob)

      addStagedToScope(staged)

      return staged !== null
    },
    [addStagedToScope]
  )

  // The explicit "Paste image" action, and the fallback for a paste event that
  // arrives EMPTY — which is what a WSL2/WSLg host screenshot looks like, since
  // the Windows clipboard doesn't bridge images to the Linux clipboard the DOM
  // event reads. Withheld entirely where no image read is possible
  // (`canReadClipboardImage`), so the menu entry renders disabled instead of
  // enabled-and-always-failing: the plugin's `read_image` is a hard
  // "Unsupported on this platform" on Android and iOS.
  const onPasteClipboardImage = useCallback(
    async ({ silent = false }: { silent?: boolean } = {}) => {
      try {
        const blob = await readClipboardImage()

        if (!blob) {
          if (!silent) {
            notify({
              kind: 'warning',
              message: translateNow('desktop.noClipboardImage'),
              title: translateNow('desktop.clipboard')
            })
          }

          return false
        }

        return await onAttachImageBlob(blob)
      } catch (error) {
        if (!silent) {
          notifyError(error, translateNow('desktop.clipboardPasteFailed'))
        }

        return false
      }
    },
    [onAttachImageBlob]
  )

  // A LOCAL folder pick has no bytes to stage: all it can produce is a raw
  // `@folder:<path>` the GATEWAY then resolves on ITS own disk. That is only the
  // folder the user pointed at when this window's filesystem IS the gateway's —
  // `gatewayOwnsLocalFs`, which excludes ssh/remote/cloud and every phone. Off
  // that, `/home/me/work` very often exists on both machines, so the pick used
  // to succeed loudly and attach an unrelated directory (the same trap
  // MJXHRM-32 closed in `selectDesktopPaths`). Withhold the handler and the
  // menu offers Remote directly instead of a choice with a wrong answer in it.
  //
  // Local FILES stay available everywhere: those upload BYTES through
  // `file.attach`, so which machine the path came from stops mattering the
  // moment they are staged.
  const localFolderPick = gatewayOwnsLocalFs(connection) ? onPickFolders : undefined

  // Remote picks open the backend-fs browser at the session's cwd.
  const onPickRemoteFiles = useCallback(
    () => void pickRemoteAttachment(cwd || undefined).then(addStagedToScope),
    [addStagedToScope, cwd]
  )

  const onPickRemoteFolders = useCallback(
    () => void pickRemoteFolderAttachment(cwd || undefined).then(addStagedToScope),
    [addStagedToScope, cwd]
  )

  const onRemoveAttachment = useCallback((id: string) => scope.attachments.remove(id), [scope])

  const onTranscribeAudio = useCallback(async (audio: Blob): Promise<string> => {
    const dataUrl = await blobToDataUrl(audio)
    const res = await transcribeAudio(dataUrl, audio.type || undefined)

    return res.transcript ?? ''
  }, [])

  return (
    <ChatBar
      busy={busy}
      cwd={cwd}
      disabled={gatewayState !== 'open'}
      focusKey={sessionId}
      gateway={getGatewayClient()}
      onAttachImageBlob={onAttachImageBlob}
      onCancel={onCancel}
      onPasteClipboardImage={canReadClipboardImage() ? onPasteClipboardImage : undefined}
      onPickFiles={onPickFiles}
      onPickFolders={localFolderPick}
      onPickImages={onPickImages}
      onPickRemoteFiles={onPickRemoteFiles}
      onPickRemoteFolders={onPickRemoteFolders}
      onRemoveAttachment={onRemoveAttachment}
      onSteer={onSteer}
      onSubmit={onSubmit}
      onTranscribeAudio={onTranscribeAudio}
      queueSessionKey={sessionId}
      sessionId={sessionId}
      state={{
        model: {
          model: currentModel,
          provider: currentProvider,
          // Model switching targets the primary chat's session; a tile's
          // per-session model menu is wired in Phase 7 (tile actions).
          canSwitch: isPrimary && gatewayState === 'open',
          modelMenuContent: isPrimary ? (
            <ModelMenuPanel
              gateway={getGatewayClient() ?? undefined}
              onSelectModel={selectModel}
              requestGateway={requestGateway}
            />
          ) : null
        },
        tools: { enabled: true, label: 'Add context' },
        voice: { enabled: true, active: false }
      }}
    />
  )
}
