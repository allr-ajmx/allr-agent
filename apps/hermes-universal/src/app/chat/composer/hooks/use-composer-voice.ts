import { useStore } from '@nanostores/react'
import { useCallback, useEffect } from 'react'

import { useSessionView } from '@/app/chat/session-view'
import { useI18n } from '@/i18n'
import { triggerHaptic } from '@/lib/haptics'
import { resetBrowseState } from '@/store/composer-input-history'
import { notifyError } from '@/store/notifications'
import { $voiceConversation } from '@/store/voice-conversation'
import { $autoSpeakReplies, setAutoSpeakReplies } from '@/store/voice-prefs'
import type { ConversationBinding } from '@/voice/conversation-controller'

import type { ComposerTarget } from '../focus'
import { onComposerVoiceToggleRequest } from '../focus'
import type { ChatBarProps } from '../types'

import { useAutoSpeakReplies } from './use-auto-speak-replies'
import { useVoiceConversation } from './use-voice-conversation'
import { useVoiceRecorder } from './use-voice-recorder'

interface UseComposerVoiceArgs {
  busy: boolean
  clearDraft: () => void
  disabled: boolean
  focusInput: () => void
  insertText: (text: string) => void
  maxRecordingSeconds: number
  onSubmit: ChatBarProps['onSubmit']
  onTranscribeAudio: ChatBarProps['onTranscribeAudio']
  sessionId: string | null | undefined
  /** This composer's focus-bus key — voice toggles targeting another
   *  composer (or the active one, when not us) are ignored. */
  target: ComposerTarget
}

/**
 * The composer's voice engine: push-to-talk dictation (transcript → draft), the
 * full voice-conversation loop, and auto-speak of replies. The conversation loop
 * itself lives in the module-level `voiceConversation` controller (MJX-96); this
 * hook binds it to THIS composer's session view and exposes the render surface.
 */
export function useComposerVoice({
  clearDraft,
  disabled,
  focusInput,
  insertText,
  maxRecordingSeconds,
  onSubmit,
  onTranscribeAudio,
  sessionId,
  target
}: UseComposerVoiceArgs) {
  const { t } = useI18n()
  const view = useSessionView()
  const conversationState = useStore($voiceConversation)
  const voiceConversationActive = conversationState.active && conversationState.target === target

  const { dictate, voiceActivityState, voiceStatus } = useVoiceRecorder({
    focusInput,
    maxRecordingSeconds,
    onTranscript: insertText,
    onTranscribeAudio
  })

  // Built lazily at start(): submit reads `busy` FRESH from the view (not a
  // render-time snapshot), so a turn submitted after `busy` changes is gated
  // correctly without the controller holding a stale closure.
  const getBinding = useCallback((): ConversationBinding => {
    return {
      view,
      target,
      transcriptionAvailable: Boolean(onTranscribeAudio),
      copy: t.notifications.voice,
      submit: async (text: string) => {
        if (view.$busy.get()) {
          return
        }

        triggerHaptic('submit')
        resetBrowseState(sessionId)
        clearDraft()
        await onSubmit(text)
      }
    }
  }, [clearDraft, onSubmit, onTranscribeAudio, sessionId, t.notifications.voice, target, view])

  const conversation = useVoiceConversation({ target, getBinding })

  // The `composer.voice` hotkey (Ctrl+B) toggles the conversation. Starting with
  // STT unconfigured lets the conversation surface its own "configure speech-to-
  // text" notice rather than silently no-opping.
  const toggleVoiceConversation = useCallback(() => {
    if (disabled) {
      return
    }

    if (voiceConversationActive) {
      conversation.end()
    } else {
      conversation.start()
    }
  }, [conversation, disabled, voiceConversationActive])

  useEffect(
    () => onComposerVoiceToggleRequest(toggled => toggled === target && toggleVoiceConversation()),
    [target, toggleVoiceConversation]
  )

  const startConversation = useCallback(() => conversation.start(), [conversation])
  const endConversation = useCallback(() => conversation.end(), [conversation])

  const handleToggleAutoSpeak = useCallback(() => {
    void setAutoSpeakReplies(!$autoSpeakReplies.get()).catch(error =>
      notifyError(error, t.settings.config.autosaveFailed)
    )
  }, [t])

  useAutoSpeakReplies({
    conversationActive: voiceConversationActive,
    failureLabel: t.assistant.thread.readAloudFailed,
    view,
    sessionId
  })

  return {
    conversation,
    dictate,
    endConversation,
    handleToggleAutoSpeak,
    startConversation,
    voiceActivityState,
    voiceConversationActive,
    voiceStatus
  }
}
