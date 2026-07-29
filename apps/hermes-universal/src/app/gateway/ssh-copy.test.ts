import { describe, expect, it } from 'vitest'

import { en } from '@/i18n/en'
import type { SshErrorKind, SshStep } from '@/store/ssh-backend'

import { sshErrorMessage, sshStepLabel } from './ssh-copy'

const g = en.settings.gateway

// Every member of each union, listed by hand. The point is that adding a variant
// to the Rust side and forgetting the copy shows up here rather than as a
// mystery "the SSH connection failed" in front of a user.
const ALL_KINDS: SshErrorKind[] = [
  'unreachable',
  'auth-failed',
  'host-key-changed',
  'timeout',
  'hermes-not-found',
  'unsupported-platform',
  'update-required',
  'transient-transport-error',
  'authenticated-stale',
  'superseded',
  'cancelled',
  'unknown'
]

const ALL_STEPS: SshStep[] = [
  'connecting',
  'authenticating',
  'probing-platform',
  'locating-hermes',
  'checking-existing',
  'uploading-token',
  'spawning',
  'waiting-ready',
  'forwarding',
  'verifying'
]

describe('sshErrorMessage', () => {
  it('has copy for every failure kind', () => {
    for (const kind of ALL_KINDS) {
      const message = sshErrorMessage({ kind, message: 'raw' }, g)

      expect(message, kind).toBeTruthy()
      // Never leak the raw Rust string for a kind we claim to handle.
      expect(message, kind).not.toBe('raw')
    }
  })

  it('distinguishes the failures a user can act on', () => {
    const distinct = new Set(
      (['unreachable', 'auth-failed', 'host-key-changed', 'hermes-not-found', 'update-required'] as const).map(
        kind => sshErrorMessage({ kind, message: '' }, g)
      )
    )

    expect(distinct.size).toBe(5)
  })

  it('spells out the host-key change rather than saying "failed"', () => {
    const message = sshErrorMessage({ kind: 'host-key-changed', message: '' }, g)

    expect(message).toContain('CHANGED')
    expect(message.toLowerCase()).toContain('machine-in-the-middle')
  })

  it('does not send the user after their address when the link merely blipped', () => {
    // `transient-transport-error` means a link that WAS working dropped a
    // request; `unreachable` means we never got there. Telling someone to check
    // their host and port for the first would be actively misleading.
    expect(sshErrorMessage({ kind: 'transient-transport-error', message: '' }, g)).not.toBe(
      sshErrorMessage({ kind: 'unreachable', message: '' }, g)
    )
  })

  it('falls back to the raw message for anything that is not one of ours', () => {
    // A JS TypeError or an IPC failure is a real bug; hiding it behind generic
    // SSH copy would make it much harder to find.
    expect(sshErrorMessage(new Error('invoke() is not a function'), g)).toBe('invoke() is not a function')
    expect(sshErrorMessage('a plain string', g)).toBe('a plain string')
    expect(sshErrorMessage(undefined, g)).toBe(g.sshErrUnknown)
    expect(sshErrorMessage({ kind: 'not-a-real-kind', message: 'x' }, g)).toBe('x')
  })
})

describe('sshStepLabel', () => {
  it('has a label for every step', () => {
    for (const step of ALL_STEPS) {
      expect(sshStepLabel(step, g), step).toBeTruthy()
    }
  })

  it('gives each step its own wording', () => {
    // A progress line that reads the same for three consecutive steps is worse
    // than none — it looks stuck.
    const labels = ALL_STEPS.map(step => sshStepLabel(step, g))

    expect(new Set(labels).size).toBe(ALL_STEPS.length)
  })

  it('degrades gracefully on an unknown step', () => {
    expect(sshStepLabel('not-a-step' as SshStep, g)).toBeTruthy()
  })
})
