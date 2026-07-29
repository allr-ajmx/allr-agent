import { useStore } from '@nanostores/react'
import { useEffect, useRef } from 'react'

import type { SessionView } from '@/app/chat/session-view'
import { playSpeechText } from '@/lib/voice-playback'
import { notifyError } from '@/store/notifications'
import { $voicePlayback } from '@/store/voice-playback'
import { $autoSpeakReplies } from '@/store/voice-prefs'
import { lastReply, markReplySpoken } from '@/store/voice-reply-cursor'

interface UseAutoSpeakReplies {
  conversationActive: boolean
  failureLabel: string
  /** The session whose replies to read — shares the dedupe cursor with the
   * conversation loop, and reads THIS session's messages (not the global chat). */
  view: SessionView
  /** Re-arm on session switch so opening a chat never reads its existing last reply. */
  sessionId: string | null | undefined
}

/**
 * Pure-TTS auto-speak: when `voice.auto_tts` is on, read each completed assistant
 * turn aloud — no dictation, no conversation loop. Stays off while a full voice
 * conversation runs (it speaks replies itself) and never overlaps clips: a reply
 * landing mid-playback is held and spoken on the playback-idle edge. Always reads
 * the latest reply, so a backlog collapses to the newest.
 */
export function useAutoSpeakReplies({ conversationActive, failureLabel, view, sessionId }: UseAutoSpeakReplies) {
  const enabled = useStore($autoSpeakReplies)
  const latest = useRef({ conversationActive, failureLabel, view })
  latest.current = { conversationActive, failureLabel, view }

  useEffect(() => {
    if (!enabled) {
      return undefined
    }

    // Don't read whatever reply already sits at the bottom when the toggle flips
    // on (or a chat opens) — consume it so only later replies are spoken.
    markReplySpoken(latest.current.view)

    const speakLatest = () => {
      const { conversationActive, failureLabel, view } = latest.current

      if (conversationActive || $voicePlayback.get().status !== 'idle') {
        return
      }

      const reply = lastReply(view)

      if (!reply || reply.pending) {
        return
      }

      markReplySpoken(view)
      void playSpeechText(reply.text, { messageId: reply.id, source: 'read-aloud' }).catch(error =>
        notifyError(error, failureLabel)
      )
    }

    // Re-check on a reply completing (this view's messages) and on the prior clip
    // ending ($voicePlayback → idle), which frees us to read the next held reply.
    const stops = [latest.current.view.$messages.subscribe(speakLatest), $voicePlayback.listen(speakLatest)]

    return () => stops.forEach(f => f())
  }, [enabled, sessionId])
}
