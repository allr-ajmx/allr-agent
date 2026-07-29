import { useStore } from '@nanostores/react'
import { useCallback, useEffect } from 'react'

import type { ComposerTarget } from '@/app/chat/composer/focus'
import { $voiceConversation, type ConversationStatus } from '@/store/voice-conversation'
import { type ConversationBinding, voiceConversation } from '@/voice/conversation-controller'

export type { ConversationStatus }

// Thin hook over the module-level `voiceConversation` controller (MJX-96). The loop
// no longer lives here — it lives in the controller, driven by awaited promises and
// Rust `voice://` events, never by re-renders. This hook only mirrors the
// `$voiceConversation` render surface and delegates the UI controls, scoped to this
// composer's `target` so a session tile shows only its own pill.

interface UseVoiceConversationArgs {
  target: ComposerTarget
  /** Built lazily at start() so the controller captures live closures, not a
   * render-time snapshot — the unmemoized-closure hazard simply can't apply. */
  getBinding: () => ConversationBinding
}

export function useVoiceConversation({ target, getBinding }: UseVoiceConversationArgs) {
  const state = useStore($voiceConversation)
  const mine = state.active && state.target === target

  const start = useCallback(() => {
    void voiceConversation.start(getBinding())
  }, [getBinding])

  const end = useCallback(() => {
    void voiceConversation.end()
  }, [])

  const stopTurn = useCallback(() => {
    voiceConversation.stopTurn()
  }, [])

  const toggleMute = useCallback(() => {
    voiceConversation.toggleMute()
  }, [])

  // Space (capture phase) ends the current listening turn — genuinely DOM-bound,
  // so it stays in the hook; its body is one controller call.
  useEffect(() => {
    if (!mine) {
      return
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== 'Space' || event.repeat || event.metaKey || event.ctrlKey || event.altKey) {
        return
      }

      if ($voiceConversation.get().status !== 'listening') {
        return
      }

      event.preventDefault()
      voiceConversation.stopTurn()
    }

    window.addEventListener('keydown', onKeyDown, { capture: true })

    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [mine])

  return {
    start,
    end,
    stopTurn,
    toggleMute,
    level: mine ? state.level : 0,
    muted: mine ? state.muted : false,
    status: mine ? state.status : ('idle' as ConversationStatus)
  }
}
