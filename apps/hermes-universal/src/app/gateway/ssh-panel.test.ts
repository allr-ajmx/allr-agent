import { describe, expect, it } from 'vitest'

import { EMPTY_SSH_FORM, parsePortField, type SshFormState, sshTargetFromForm } from './ssh-panel'

const form = (over: Partial<SshFormState> = {}): SshFormState => ({ ...EMPTY_SSH_FORM, ...over })

describe('parsePortField', () => {
  it('reads a valid port', () => {
    expect(parsePortField('2222')).toBe(2222)
    expect(parsePortField('  2222  ')).toBe(2222)
    expect(parsePortField('22')).toBe(22)
  })

  it('treats blank and nonsense as unset, never 0', () => {
    // Unset is what lets ~/.ssh/config (or the default 22) decide. A 0 would be
    // taken as an explicit port and fail the connect.
    for (const value of ['', '   ', 'abc', '22a', '-1', '2.5']) {
      expect(parsePortField(value), value).toBeNull()
    }
  })

  it('rejects out-of-range ports', () => {
    expect(parsePortField('0')).toBeNull()
    expect(parsePortField('65536')).toBeNull()
    expect(parsePortField('65535')).toBe(65535)
  })
})

describe('sshTargetFromForm', () => {
  it('trims and drops empty optional fields', () => {
    const target = sshTargetFromForm(form({ host: '  deploy@box  ', user: '  ', remoteHermesPath: '' }))

    expect(target.host).toBe('deploy@box')
    // Rust distinguishes "unset" from "blank": a blank remote hermes path means
    // auto-detect, not "look for a file named ''".
    expect(target.user).toBeUndefined()
    expect(target.remoteHermesPath).toBeUndefined()
    expect(target.keyPath).toBeUndefined()
  })

  it('carries the fields that are set', () => {
    const target = sshTargetFromForm(
      form({
        host: 'box',
        keyPath: '~/.ssh/id_ed25519',
        port: '2222',
        remoteHermesPath: '/opt/hermes',
        user: 'deploy'
      })
    )

    expect(target).toEqual({
      host: 'box',
      keyPath: '~/.ssh/id_ed25519',
      port: 2222,
      remoteHermesPath: '/opt/hermes',
      user: 'deploy'
    })
  })

  it('never carries a secret', () => {
    // The target is persisted to localStorage by saveGatewayTarget; credentials
    // belong in the OS keyring and must not ride along.
    const target = sshTargetFromForm(form({ host: 'box', passphrase: 'hunter2', privateKeyPem: 'PEM' }))

    expect(JSON.stringify(target)).not.toContain('hunter2')
    expect(JSON.stringify(target)).not.toContain('PEM')
  })
})
