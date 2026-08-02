import { describe, expect, it } from 'vitest'

import {
  EMPTY_SSH_FORM,
  parsePortField,
  splitSshHostInput,
  SSH_SECRET_FIELDS,
  type SshFormState,
  sshTargetFromForm
} from './ssh-panel'

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

describe('splitSshHostInput', () => {
  it('splits the form people actually paste', () => {
    // The reported confusion: this connected fine, because Rust absorbs the
    // user and port itself, but the User and Port rows sat empty as though
    // neither had been given.
    expect(splitSshHostInput('xm@localhost:2222')).toEqual({
      host: 'localhost',
      port: '2222',
      user: 'xm'
    })
  })

  it('takes either part on its own', () => {
    expect(splitSshHostInput('xm@box')).toEqual({ host: 'box', port: undefined, user: 'xm' })
    expect(splitSshHostInput('box:2222')).toEqual({ host: 'box', port: '2222', user: undefined })
  })

  it('leaves a plain host and a config alias alone', () => {
    expect(splitSshHostInput('  example.com  ')).toEqual({
      host: 'example.com',
      port: undefined,
      user: undefined
    })
    expect(splitSshHostInput('my-alias')).toEqual({ host: 'my-alias', port: undefined, user: undefined })
    expect(splitSshHostInput('')).toEqual({ host: '' })
  })

  it('does not mistake a bare IPv6 literal for a host:port', () => {
    // Two or more colons means the colons belong to the address itself.
    expect(splitSshHostInput('fd00::1')).toEqual({ host: 'fd00::1', port: undefined, user: undefined })
    expect(splitSshHostInput('xm@fd00::1')).toEqual({ host: 'fd00::1', port: undefined, user: 'xm' })
  })

  it('reads a bracketed IPv6 host, with or without a port', () => {
    expect(splitSshHostInput('[fd00::1]:2222')).toEqual({
      host: 'fd00::1',
      port: '2222',
      user: undefined
    })
    expect(splitSshHostInput('[fd00::1]')).toEqual({ host: 'fd00::1', port: undefined, user: undefined })
    expect(splitSshHostInput('xm@[fd00::1]:2222')).toEqual({
      host: 'fd00::1',
      port: '2222',
      user: 'xm'
    })
  })

  it('leaves a non-numeric port where it is, to fail validation as a host', () => {
    // Matching Rust: an unparseable port is not split off, so the whole string
    // stays the host and is rejected there rather than silently half-read.
    expect(splitSshHostInput('box:ssh')).toEqual({ host: 'box:ssh', port: undefined, user: undefined })
    expect(splitSshHostInput('box:99999')).toEqual({ host: 'box:99999', port: undefined, user: undefined })
    expect(splitSshHostInput('[fd00::1]:ssh')).toEqual({
      host: '[fd00::1]:ssh',
      port: undefined,
      user: undefined
    })
  })

  it('does not read a leading @ as an empty user', () => {
    // Rust requires the @ past index 0 so this falls through to host
    // validation and fails there; splitting it would invent a blank user.
    expect(splitSshHostInput('@box')).toEqual({ host: '@box', port: undefined, user: undefined })
  })

  it('splits on the first @, as Rust does', () => {
    expect(splitSshHostInput('xm@weird@box')).toEqual({
      host: 'weird@box',
      port: undefined,
      user: 'xm'
    })
  })
})

describe('secrets stay out of the saved target', () => {
  it('never puts a secret in what sshTargetFromForm returns', () => {
    // saveGatewayTarget persists this to localStorage in plaintext, so a
    // credential leaking into it would be written to disk unencrypted. The
    // keystore is the only place these may go.
    const target = sshTargetFromForm(
      form({
        host: 'box',
        passphrase: 'key-passphrase',
        password: 'login-password',
        privateKeyPem: '-----BEGIN OPENSSH PRIVATE KEY-----'
      })
    )

    const serialised = JSON.stringify(target)

    for (const secret of ['login-password', 'key-passphrase', 'BEGIN OPENSSH PRIVATE KEY']) {
      expect(serialised, secret).not.toContain(secret)
    }

    for (const field of SSH_SECRET_FIELDS) {
      expect(target, field).not.toHaveProperty(field)
    }
  })

  it('keeps the passphrase and the password apart', () => {
    // They are different credentials: the passphrase only ever decrypts a
    // private key, so a login password typed into it authenticates nothing.
    // Conflating the two fields is what made that failure look like a bug.
    expect(EMPTY_SSH_FORM).toHaveProperty('passphrase')
    expect(EMPTY_SSH_FORM).toHaveProperty('password')
    expect(EMPTY_SSH_FORM.passphrase).toBe('')
    expect(EMPTY_SSH_FORM.password).toBe('')
  })
})
