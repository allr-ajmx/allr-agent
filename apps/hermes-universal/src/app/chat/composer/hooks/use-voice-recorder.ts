import { useEffect, useRef, useState } from 'react'

import { useI18n } from '@/i18n'
import { $connection } from '@/store/connection'
import { notify, notifyError } from '@/store/notifications'
import { voiceEngine } from '@/voice/engine'
import { VoiceBusyError, voiceErrorMessage } from '@/voice/errors'
import type { VoiceEvent, VoiceLease, VoiceTarget, VoiceVad } from '@/voice/types'

import type { VoiceActivityState, VoiceStatus } from '../types'

interface VoiceRecorderOptions {
  maxRecordingSeconds: number
  onTranscribeAudio?: (audio: Blob) => Promise<string>
  focusInput: () => void
  onTranscript: (text: string) => void
}

// Push-to-talk dictation on the shared voice engine (MJX-96). Press to open the
// mic and record; press again (or hit the cap) to force the turn — Rust
// transcribes and emits `transcript`, which we insert into the draft. Unlike the
// conversation loop there is no auto-turn: VAD auto-end is disabled (a huge
// silence window + a zero speech threshold that keeps every frame "voiced"), so
// only an explicit `forceTurn` ends the take.
function dictationVad(capSeconds: number): VoiceVad {
  return {
    speechLevel: 0, // every frame counts as speech → records immediately, never auto-ends
    onsetMs: 0,
    minTurnMs: 0,
    prerollMs: 0,
    silenceMs: 3_600_000,
    idleSilenceMs: 3_600_000,
    maxTurnMs: capSeconds * 1_000
  }
}

function currentTarget(): VoiceTarget | null {
  const conn = $connection.get()

  if (!conn) {
    return null
  }

  const headers: Record<string, string> = {}

  if (conn.token) {
    headers['X-Hermes-Session-Token'] = conn.token
  }

  return { baseUrl: conn.baseUrl, headers }
}

export function useVoiceRecorder({
  maxRecordingSeconds,
  onTranscribeAudio,
  focusInput,
  onTranscript
}: VoiceRecorderOptions) {
  const { t } = useI18n()
  const voiceCopy = t.notifications.voice
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus>('idle')
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const [level, setLevel] = useState(0)

  const leaseRef = useRef<VoiceLease | null>(null)
  const startedAtRef = useRef(0)
  const intervalRef = useRef<number | null>(null)
  const timeoutRef = useRef<number | null>(null)
  // Live refs so the (stable) event handler reads current callbacks.
  const cbRef = useRef({ focusInput, onTranscript, voiceCopy })
  cbRef.current = { focusInput, onTranscript, voiceCopy }

  const clearTimers = () => {
    if (intervalRef.current) {
      window.clearInterval(intervalRef.current)
      intervalRef.current = null
    }

    if (timeoutRef.current) {
      window.clearTimeout(timeoutRef.current)
      timeoutRef.current = null
    }
  }

  const teardown = () => {
    clearTimers()
    const lease = leaseRef.current
    leaseRef.current = null

    if (lease) {
      void lease.close()
    }

    setLevel(0)
    setVoiceStatus('idle')
  }

  useEffect(() => () => teardown(), [])

  const onEvent = (event: VoiceEvent) => {
    const { focusInput, onTranscript, voiceCopy } = cbRef.current

    switch (event.type) {
      case 'level':
        setLevel(event.level)

        break

      case 'state':
        if (event.state === 'finalizing') {
          setVoiceStatus('transcribing')
        }

        break
      case 'transcript': {
        const transcript = event.text.trim()

        if (transcript) {
          onTranscript(transcript)
        }

        teardown()
        focusInput()

        break
      }

      case 'turnEmpty':
        notify({ kind: 'warning', title: voiceCopy.noSpeechDetected, message: voiceCopy.tryRecordingAgain })
        teardown()
        focusInput()

        break

      case 'error':
        notifyError(new Error(event.message || event.code), voiceErrorMessage(event.code, voiceCopy))
        teardown()

        break
    }
  }

  const start = async () => {
    if (!onTranscribeAudio) {
      notify({ kind: 'warning', title: voiceCopy.unavailable, message: voiceCopy.transcriptionUnavailable })

      return
    }

    const target = currentTarget()

    if (!target) {
      notifyError(new Error('not connected'), voiceCopy.recordingFailed)

      return
    }

    const cap = Math.max(1, Math.min(Math.trunc(maxRecordingSeconds), 600))

    try {
      const lease = await voiceEngine.open('dictation', { target, vad: dictationVad(cap) })
      leaseRef.current = lease
      lease.on(onEvent)
      await lease.arm('normal')

      startedAtRef.current = Date.now()
      setElapsedSeconds(0)
      setVoiceStatus('recording')
      intervalRef.current = window.setInterval(() => setElapsedSeconds((Date.now() - startedAtRef.current) / 1000), 250)
      timeoutRef.current = window.setTimeout(() => void stop(), cap * 1_000)
    } catch (error) {
      leaseRef.current = null
      setVoiceStatus('idle')

      if (error instanceof VoiceBusyError) {
        notify({ kind: 'warning', title: voiceCopy.unavailable, message: voiceCopy.microphoneInUse })
      } else {
        notifyError(error, voiceErrorMessage(error instanceof Error ? error.message : '', voiceCopy))
      }
    }
  }

  // Release: end the take. `forceTurn` finalizes → the transcript event tears down.
  const stop = async () => {
    clearTimers()
    const lease = leaseRef.current

    if (!lease) {
      setVoiceStatus('idle')

      return
    }

    await lease.forceTurn().catch(() => undefined)
  }

  const dictate = () => {
    if (voiceStatus === 'recording') {
      void stop()
    } else if (voiceStatus === 'idle') {
      void start()
    }
  }

  const voiceActivityState: VoiceActivityState = {
    elapsedSeconds,
    level,
    status: voiceStatus
  }

  return { dictate, voiceActivityState, voiceStatus }
}
