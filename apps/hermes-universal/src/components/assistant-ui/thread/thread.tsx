import { ThreadPrimitive } from '@assistant-ui/react'

import { Intro } from '@/components/chat/intro'

import { AssistantMessage } from './assistant-message'
import { ThreadMessageList } from './list'
import { ResponseLoadingIndicator } from './status'
import { SystemMessage } from './system-message'
import { ThreadTimeline } from './timeline'
import { UserEditComposer } from './user-edit-composer'
import { UserMessage } from './user-message'

// New-conversation empty state — desktop's <Intro>: the auto-fit "HERMES AGENT"
// wordmark + a rotating neutral tagline. Centered and pushed above the docked
// composer by its measured height, matching desktop's placement.
const EmptyPlaceholder = (
  <div className="flex min-h-0 w-full flex-col items-center justify-center pt-[var(--composer-measured-height)]">
    <Intro />
  </div>
)

// Module scope, NOT inline props: ThreadMessageList is memo'd, and a fresh
// object/element on every Thread render defeats that bail-out — so every
// $busy / $statusLine tick (i.e. constantly, mid-turn) re-rendered the entire
// visible transcript. The list subscribes to the messages itself via
// useAuiState, so stable props cost it nothing.
const MESSAGE_COMPONENTS = { AssistantMessage, SystemMessage, UserEditComposer, UserMessage }
const LOADING_INDICATOR = <ResponseLoadingIndicator />

// The chat thread. ThreadMessageList (ported from desktop) owns stick-to-bottom
// scrolling: it follows while parked at the bottom, escapes on scroll-up, pins
// the latest human message to the top of its turn while the reply streams, and
// groups each user prompt with the assistant turn(s) that follow it.
//
// The inline UserEditComposer is wired: clicking a user bubble opens it, and
// sending rewinds to that turn and re-runs it (runtime `onEdit` →
// submitEditedPrompt). GATED still: desktop's restore-checkpoint ConfirmDialog
// flow needs the branching/checkpoint runtime. ThreadTimeline is NOT gated: it
// only reads s.thread.messages and queries data-message-id, both of which the
// external-store runtime provides. The floating scroll-to-bottom button renders
// in chat-screen.tsx.
export function Thread() {
  return (
    <ThreadPrimitive.Root className="relative flex min-h-0 flex-1 flex-col bg-transparent contain-[layout_paint]">
      <ThreadMessageList
        clampToComposer
        components={MESSAGE_COMPONENTS}
        emptyPlaceholder={EmptyPlaceholder}
        loadingIndicator={LOADING_INDICATOR}
      />
      <ThreadTimeline />
    </ThreadPrimitive.Root>
  )
}
