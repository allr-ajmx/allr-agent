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
import { IS_MOBILE } from '@/lib/platform'
import { useStore } from '@/store/atom'
import { sessionApprovalRequest, sessionSecretRequest, sessionSudoRequest } from '@/store/prompts'

export function ChatScreen() {
  // The SessionView is the data surface — the session on screen by default, a
  // tile's own session when one mounts this under its view. Everything below
  // reads from it, so N sessions render from one component tree.
  const view = useSessionView()
  const sessionKey = useStore(view.$runtimeId) ?? ''

  const busy = useStore(view.$busy)
  const statusLine = useStore(view.$statusLine)
  // Blocking prompts are per SESSION, so each chat surface renders its own
  // inline bars. These used to read the global prompt atoms and were therefore
  // gated to the primary chat, leaving a tile to surface its prompts through a
  // separate overlay path — two UIs for one thing, and neither could show a
  // second session's prompt while you were looking at the first.
  const approval = useStore(sessionApprovalRequest(sessionKey))
  const sudo = useStore(sessionSudoRequest(sessionKey))
  const secret = useStore(sessionSecretRequest(sessionKey))
  const { dragActive } = useFileDrop()

  const barsPresent = (busy && statusLine) || approval || sudo || secret

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
            {approval && <ApprovalBar request={approval} sessionKey={sessionKey} />}
            {/* Clarify has no bar here: like desktop, the question renders inline in
                the transcript (components/assistant-ui/clarify-tool.tsx) so the
                choice buttons sit with the tool row that asked. */}
            {sudo && <SudoBar request={sudo} sessionKey={sessionKey} />}
            {secret && <SecretBar request={secret} sessionKey={sessionKey} />}
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
