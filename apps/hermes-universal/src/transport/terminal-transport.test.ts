import { describe, expect, it } from 'vitest'

import { resolveTerminalTransportKind, type TerminalTransportInputs } from './terminal-transport'

// The rule that decides WHICH MACHINE a terminal shells into. It is the whole
// point of the seam, so it is tested as a pure function rather than through a
// mounted xterm.

function inputs(overrides: Partial<TerminalTransportInputs> = {}): TerminalTransportInputs {
  return { hasConnection: true, localSupported: true, mode: 'local', preference: 'auto', ...overrides }
}

describe('resolveTerminalTransportKind', () => {
  it('keeps a local-mode gateway on the local PTY', () => {
    expect(resolveTerminalTransportKind(inputs({ mode: 'local' }))).toBe('local')
  })

  it.each(['remote', 'cloud', 'ssh'] as const)('sends a %s gateway to the remote shell', mode => {
    expect(resolveTerminalTransportKind(inputs({ mode }))).toBe('remote')
  })

  it('treats an unset mode as remote, matching modeIsRemoteLike', () => {
    expect(resolveTerminalTransportKind(inputs({ mode: undefined }))).toBe('remote')
  })

  it('always goes remote where there is no local shell, even for a local gateway', () => {
    // A phone: pty.rs is #[cfg(mobile)]-stubbed, so `device` is not honourable.
    expect(resolveTerminalTransportKind(inputs({ localSupported: false, mode: 'local' }))).toBe('remote')
    expect(resolveTerminalTransportKind(inputs({ localSupported: false, preference: 'device' }))).toBe('remote')
  })

  it('falls back to local when there is no connection to reach a remote shell through', () => {
    expect(resolveTerminalTransportKind(inputs({ hasConnection: false, mode: 'remote' }))).toBe('local')
  })

  it('lets an explicit preference override the gateway mode', () => {
    expect(resolveTerminalTransportKind(inputs({ mode: 'remote', preference: 'device' }))).toBe('local')
    expect(resolveTerminalTransportKind(inputs({ mode: 'local', preference: 'gateway' }))).toBe('remote')
  })
})
