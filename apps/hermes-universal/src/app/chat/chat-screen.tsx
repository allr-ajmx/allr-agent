import { ApprovalBar } from '@/app/chat/approval-bar'
import { ChatComposer } from '@/app/chat/chat-composer'
import { ChatDropOverlay } from '@/app/chat/chat-drop-overlay'
import { ChatHeader } from '@/app/chat/chat-header'
import { ChatRuntimeProvider } from '@/app/chat/runtime'
import { ScrollToBottomButton } from '@/app/chat/scroll-to-bottom-button'
import { SecretBar } from '@/app/chat/secret-bar'
import { useSessionView } from '@/app/chat/session-view'
import { SudoBar } from '@/app/chat/sudo-bar'
import { useFileDrop } from '@/app/chat/use-file-drop'
import { Thread } from '@/components/assistant-ui/thread/thread'
import { COMPOSER_HEART_CONFIG, HeartField } from '@/components/chat/vibe-hearts'
import { IS_MOBILE } from '@/lib/platform'
import { useStore } from '@/store/atom'
import { $approval, $secret, $statusLine, $sudo } from '@/store/chat'
import { $petActive } from '@/store/pet'

export function ChatScreen() {
  // The SessionView is the data surface. It defaults to PRIMARY_SESSION_VIEW
  // (whose atoms ARE the global chat atoms), so the primary chat is unchanged; a
  // session TILE mounts this same ChatScreen under its own view.
  const view = useSessionView()
  const isPrimary = view.kind === 'primary'

  const busy = useStore(view.$busy)
  const statusLine = useStore($statusLine)
  // Blocking-prompt bars are the PRIMARY chat's inline UI; a tile surfaces its
  // prompts via PromptOverlays (per-session), so these read the global atoms and
  // only render for the primary.
  const approval = useStore($approval)
  const sudo = useStore($sudo)
  const secret = useStore($secret)
  const { dragActive } = useFileDrop()
  // A pet out owns the hearts; the composer lane only catches them when none is.
  const petActive = useStore($petActive)

  // Inline bars + status line are the PRIMARY chat's UI (they read the global
  // prompt atoms); a tile surfaces its prompts via PromptOverlays instead.
  const barsPresent = isPrimary && ((busy && statusLine) || approval || sudo || secret)

  return (
    <div className="chat">
      {/* The chat title lives INSIDE the chat area (desktop parity — see
          chat-header.tsx / desktop's in-pane ChatHeader), so it tracks the chat
          pane when the left sidebar opens and is absent on non-chat views. On
          mobile the layout is fixed and the title sits in the top bar instead
          (MobileTopBar → ChatTitle), so the header row stands down. */}
      {!IS_MOBILE && <ChatHeader />}

      {/* The runtime hosts the streaming thread AND the composer, so the
          composer's ComposerPrimitive.Input / trigger popover have runtime
          context. */}
      <ChatRuntimeProvider>
        <Thread />
        <ScrollToBottomButton />
        {barsPresent && (
          <div className="composer-bars">
            {busy && statusLine && <div className="pl-0.5 text-[0.8125rem] text-muted-foreground">{statusLine}</div>}
            {approval && <ApprovalBar request={approval} />}
            {/* Clarify has no bar here: like desktop, the question renders inline in
                the transcript (components/assistant-ui/clarify-tool.tsx) so the
                choice buttons sit with the tool row that asked. */}
            {sudo && <SudoBar request={sudo} />}
            {secret && <SecretBar request={secret} />}
          </div>
        )}
        <ChatComposer />
      </ChatRuntimeProvider>

      {/* Vibe hearts rise from the composer only when no pet is out (when one is,
          they puff off the pet instead — see FloatingPet's PetHeartField). The
          lane spans the thread, stopping above the composer + status stack.
          Note: every mounted ChatScreen shares one emitter, so a burst plays in
          each open tile — desktop behaves the same way. */}
      {!petActive && (
        <HeartField
          className="absolute inset-x-0 z-30"
          config={COMPOSER_HEART_CONFIG}
          style={{
            top: 0,
            bottom: 'calc(var(--composer-measured-height) + var(--status-stack-measured-height) + 0.25rem)'
          }}
        />
      )}

      {/* OS file drag-and-drop affordance — covers the whole chat area (Tauri
          delivers drops window-globally; the drop is handled by useFileDrop). */}
      <ChatDropOverlay active={dragActive} />
    </div>
  )
}
