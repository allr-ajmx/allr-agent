import { useCallback, useEffect } from 'react'

import {
  pickAttachment,
  pickFolderAttachment,
  type StagedAttachment,
  stagedToComposerAttachment
} from '@/app/chat/attachments'
import { ChatBar } from '@/app/chat/composer'
import { useComposerScope } from '@/app/chat/composer/scope'
import { useSlashCommand } from '@/app/chat/hooks/use-slash-command'
import { useSessionView } from '@/app/chat/session-view'
import { ModelMenuPanel } from '@/app/shell/model-menu-panel'
import { transcribeAudio } from '@/hermes'
import { SLASH_COMMAND_RE } from '@/lib/chat-runtime'
import { triggerHaptic } from '@/lib/haptics'
import { useStore } from '@/store/atom'
import { sendPrompt } from '@/store/chat'
import { type ComposerAttachment } from '@/store/composer'
import { $gatewayState, getGatewayClient, requestGateway } from '@/store/gateway'
import { refreshCurrentModel, selectModel } from '@/store/model'
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
  const executeSlashCommand = useSlashCommand()

  // Seed the composer's model/provider from the profile default once the gateway
  // is up (only fills an empty selection). Primary only — a tile shows its own
  // session's model and must not overwrite the global default.
  useEffect(() => {
    if (isPrimary && gatewayState === 'open') {
      void refreshCurrentModel()
    }
  }, [isPrimary, gatewayState])

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

      // Route by scope: the main composer submits the primary chat; a tile's
      // composer submits to its own session through the tile delegate.
      if (scope.target === 'main') {
        await sendPrompt(full)
      } else {
        const rt = view.$runtimeId.get()

        if (rt) {
          await sessionTileDelegate()?.submitToSession(rt, full)
        }
      }

      return true
    },
    [executeSlashCommand, scope, view]
  )

  // Interrupt the running turn (Esc / Stop). Best-effort — a backend without
  // session.interrupt simply rejects and the turn keeps running.
  const onCancel = useCallback(() => {
    const sid = view.$runtimeId.get()

    if (!sid) {
      return
    }

    if (scope.target === 'main') {
      void requestGateway('session.interrupt', { session_id: sid }).catch(() => {})
    } else {
      void sessionTileDelegate()?.interruptSession(sid)
    }
  }, [scope, view])

  const addStagedToScope = (staged: StagedAttachment | null) => {
    if (staged) {
      scope.attachments.add(stagedToComposerAttachment(staged))
    }
  }

  const onPickFiles = useCallback(() => void pickAttachment().then(addStagedToScope), [scope])
  const onPickImages = useCallback(() => void pickAttachment().then(addStagedToScope), [scope])
  const onPickFolders = useCallback(() => void pickFolderAttachment().then(addStagedToScope), [scope])
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
      onCancel={onCancel}
      onPickFiles={onPickFiles}
      onPickFolders={onPickFolders}
      onPickImages={onPickImages}
      onRemoveAttachment={onRemoveAttachment}
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
