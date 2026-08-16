import { useStore } from '@nanostores/react'
import { useCallback, useEffect, useRef } from 'react'

import { useSessionView } from '@/app/chat/session-view'
import { routeWakeDetection } from '@/app/chat/wake-routing'
import { useI18n } from '@/i18n'
import { triggerHaptic } from '@/lib/haptics'
import { interruptSession } from '@/store/chat'
import { resetBrowseState } from '@/store/composer-input-history'
import { notifyError } from '@/store/notifications'
import { $voiceConversation } from '@/store/voice-conversation'
import { $autoSpeakReplies, seedVoicePrefs, setAutoSpeakReplies } from '@/store/voice-prefs'
import { clearWakeIndicator, syncWakeIndicatorWithVoice } from '@/store/wake-indicator'
import { armWakeWord, setWakeConversationStarter } from '@/store/wake-word'
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
      },
      // Barge-in during GENERATION (MJXHRM-228). The same verb the Stop button
      // sends, addressed to the session this conversation is bound to rather
      // than the foreground one — a tile's voice loop must stop its own turn,
      // not the main pane's. `$runtimeId` is the slice key, which is what
      // `interruptSession` addresses.
      interrupt: async () => {
        const key = view.$runtimeId.get()

        if (key) {
          await interruptSession(key)
        }
      }
    }
  }, [clearDraft, onSubmit, onTranscribeAudio, sessionId, t.notifications.voice, target, view])

  const conversation = useVoiceConversation({ target, getBinding })
  // Live handle on `start` for the wake-word starter below (the render-time ref
  // write pattern `use-auto-speak-replies` uses).
  const startRef = useRef(conversation.start)
  startRef.current = conversation.start

  // The `composer.voice` hotkey (⌥B) toggles the conversation. Starting with
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

  // Hands-free wake word, main composer only — a tile's composer must not arm a
  // second detector or claim the "hey Hermes" turn.
  //
  // Arming is a RECONCILE (`wake.status` then start only when the config already
  // says enabled), so mounting a chat never turns a microphone on by itself; only
  // the ear button writes that preference.
  useEffect(() => {
    if (target !== 'main' || disabled) {
      return
    }

    void armWakeWord()
    // `voice.auto_tts` and `voice.thinking_sound` are backend config, and this is
    // the one effect that runs once for the main composer — so it is where the
    // preference atoms get their real values. Without it `$autoSpeakReplies` sat
    // at its `false` default forever (MJXHRM-389).
    void seedVoicePrefs()
    // Register a starter that reads the LIVE `start` through a ref rather than
    // the one this effect closed over. The binding is rebuilt whenever the
    // session view or submit handler changes, and a detection minutes later must
    // open a conversation against the current chat, not the mounted one.
    //
    // ROUTE FIRST, then open the conversation. `routeWakeDetection` may switch
    // profile and create a fresh chat; the binding built by `startRef.current()`
    // reads `PRIMARY_SESSION_VIEW`, whose atoms are the ACTIVE session's, so it
    // picks up the chat the routing just landed on rather than the one that was
    // there when the phrase was spoken.
    setWakeConversationStarter(detection => {
      routeWakeDetection(detection)
      startRef.current()
    })

    return () => setWakeConversationStarter(null)
  }, [disabled, target])

  // The wake indicator follows the conversation the wake phrase opened, and only
  // that one — a conversation the user started by hand shows the composer's own
  // pill and needs no light. `syncWakeIndicatorWithVoice` answers whether this
  // surface owns the indicator; the unmount below is what stops a chat closing
  // mid-conversation from leaving the light on with nothing behind it.
  const ownsWakeIndicator = useRef(false)

  useEffect(() => {
    if (target !== 'main') {
      return
    }

    if (syncWakeIndicatorWithVoice(voiceConversationActive, conversation.status)) {
      ownsWakeIndicator.current = voiceConversationActive
    }
  }, [conversation.status, target, voiceConversationActive])

  useEffect(
    () => () => {
      if (ownsWakeIndicator.current) {
        clearWakeIndicator()
      }
    },
    []
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
