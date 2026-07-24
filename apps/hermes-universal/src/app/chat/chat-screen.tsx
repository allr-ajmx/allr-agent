import { ApprovalBar } from '@/app/chat/approval-bar'
import { ChatComposer } from '@/app/chat/chat-composer'
import { ChatDropOverlay } from '@/app/chat/chat-drop-overlay'
import { ChatHeader } from '@/app/chat/chat-header'
import { ClarifyBar } from '@/app/chat/clarify-bar'
import { ChatRuntimeProvider } from '@/app/chat/runtime'
import { ScrollToBottomButton } from '@/app/chat/scroll-to-bottom-button'
import { SecretBar } from '@/app/chat/secret-bar'
import { useSessionView } from '@/app/chat/session-view'
import { SudoBar } from '@/app/chat/sudo-bar'
import { useFileDrop } from '@/app/chat/use-file-drop'
import { Thread } from '@/components/assistant-ui/thread/thread'
import { IS_MOBILE } from '@/lib/platform'
import { useStore } from '@/store/atom'
import { $approval, $clarify, $secret, $statusLine, $sudo } from '@/store/chat'

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
  const clarify = useStore($clarify)
  const sudo = useStore($sudo)
  const secret = useStore($secret)
  const { dragActive } = useFileDrop()

  // Inline bars + status line are the PRIMARY chat's UI (they read the global
  // prompt atoms); a tile surfaces its prompts via PromptOverlays instead.
  const barsPresent = isPrimary && ((busy && statusLine) || approval || clarify || sudo || secret)

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
            {clarify && <ClarifyBar request={clarify} />}
            {sudo && <SudoBar request={sudo} />}
            {secret && <SecretBar request={secret} />}
          </div>
        )}
        <ChatComposer />
      </ChatRuntimeProvider>

      {/* OS file drag-and-drop affordance — covers the whole chat area (Tauri
          delivers drops window-globally; the drop is handled by useFileDrop). */}
      <ChatDropOverlay active={dragActive} />
    </div>
  )
}
