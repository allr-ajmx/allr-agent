import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }))
vi.mock('@/store/installation-id', () => ({ getInstallationId: vi.fn().mockResolvedValue('a'.repeat(32)) }))
vi.mock('@/lib/secure-store', () => ({
  loadSshSecrets: vi.fn().mockResolvedValue({ passphrase: undefined, password: undefined, privateKeyPem: undefined })
}))

import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

import { applyInstallEvent, type InstallEvent } from './local-install'
import {
  $sshInstall,
  $sshInstallProgress,
  cancelSshInstall,
  chooseSshRepo,
  dismissSshInstall,
  offerSshInstall,
  resetSshInstall,
  startSshInstall,
  stepBackInSshInstall
} from './ssh-install'

const invokeMock = vi.mocked(invoke)
const listenMock = vi.mocked(listen)

const target = { host: 'box.example.com', user: 'me' } as never

beforeEach(() => {
  invokeMock.mockReset()
  listenMock.mockReset()
  invokeMock.mockResolvedValue(undefined)
  listenMock.mockResolvedValue(() => {})
  resetSshInstall()
})

describe('the offer', () => {
  it('is absent until a connect fails', () => {
    // `null` is "no offer on screen" — there is no detection phase here,
    // because detection already happened as part of the failed connect.
    expect($sshInstall.get()).toBeNull()
  })

  it('names the host it is about', () => {
    offerSshInstall('box.example.com')

    expect($sshInstall.get()?.host).toBe('box.example.com')
    // 'missing' is the repo-card phase, shared with the local flow: Hermes IS
    // missing, on that host.
    expect($sshInstall.get()?.phase).toBe('missing')
  })

  it('is dismissable without installing anything', async () => {
    offerSshInstall('box.example.com')
    dismissSshInstall()

    expect($sshInstall.get()).toBeNull()
    expect(invokeMock).not.toHaveBeenCalled()
  })
})

describe('stepping back', () => {
  it('consumes the press on the repo description', () => {
    offerSshInstall('h')
    chooseSshRepo('fork')

    expect(stepBackInSshInstall()).toBe(true)
    expect($sshInstall.get()?.phase).toBe('missing')
    expect($sshInstall.get()?.repo).toBeNull()
  })

  it('declines it everywhere else', () => {
    expect(stepBackInSshInstall()).toBe(false)

    offerSshInstall('h')
    expect(stepBackInSshInstall()).toBe(false)
  })
})

/** The install id is minted inside `startSshInstall`; recover it from a channel. */
function installId(order: string[]): string {
  return order.find(entry => entry.startsWith('ssh://'))?.split('/')[2] ?? ''
}

describe('starting a remote install', () => {
  it('subscribes to every channel before invoking', async () => {
    const order: string[] = []

    listenMock.mockImplementation(async (channel: string) => {
      order.push(channel)

      return () => {}
    })
    invokeMock.mockImplementation(async () => {
      order.push('invoke')
    })

    offerSshInstall('h')
    chooseSshRepo('upstream')
    await startSshInstall(target)

    // Three channels, not one. The install events are the obvious pair, but auth
    // happens FIRST: a remote that wants a key passphrase, or whose host key is
    // not yet trusted, asks before a single install stage runs — and with nobody
    // listening that stalled for the 60s prompt timeout and then failed.
    expect(order.filter(entry => entry.startsWith('hermes-install://'))).toHaveLength(1)
    expect(order.filter(entry => entry.startsWith('ssh://'))).toEqual([
      `ssh://${installId(order)}/prompt`,
      `ssh://${installId(order)}/host-key`
    ])
    expect(order.indexOf('invoke')).toBe(order.length - 1)
  })

  it('passes the repo as a name, never a URL', async () => {
    offerSshInstall('h')
    chooseSshRepo('fork')
    await startSshInstall(target)

    const call = invokeMock.mock.calls.find(([command]) => command === 'ssh_install')
    const args = call?.[1] as { repo: string; config: Record<string, unknown> }

    expect(args.repo).toBe('fork')
    // Rust owns the URLs — one arriving from here would become a clone target
    // AND a script executed on someone else's machine.
    expect(JSON.stringify(args)).not.toContain('http')
  })

  it('sends credentials and stays interactive so prompts still work', async () => {
    offerSshInstall('h')
    chooseSshRepo('upstream')
    await startSshInstall(target)

    const args = invokeMock.mock.calls.find(([c]) => c === 'ssh_install')?.[1] as {
      config: { interactive: boolean; installationId: string }
    }

    // A key passphrase or host-key confirmation must still be answerable.
    expect(args.config.interactive).toBe(true)
    expect(args.config.installationId).toHaveLength(32)
  })

  it('does nothing without a chosen repo', async () => {
    offerSshInstall('h')
    await startSshInstall(target)

    expect(invokeMock).not.toHaveBeenCalledWith('ssh_install', expect.anything())
  })

  it('surfaces a typed Rust rejection', async () => {
    // Rust rejects with {kind, message}, not an Error.
    invokeMock.mockRejectedValue({ kind: 'auth-failed', message: 'permission denied' })

    offerSshInstall('h')
    chooseSshRepo('upstream')
    await startSshInstall(target)

    expect($sshInstall.get()?.phase).toBe('failed')
    expect($sshInstall.get()?.error).toBe('permission denied')
  })

  it('cancels through the shared ssh attempt registry', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'ssh_install') {
        return new Promise(() => {})
      }

      return undefined
    })

    offerSshInstall('h')
    chooseSshRepo('upstream')
    void startSshInstall(target)

    await vi.waitFor(() => expect(invokeMock.mock.calls.some(([c]) => c === 'ssh_install')).toBe(true))

    const installId = (invokeMock.mock.calls.find(([c]) => c === 'ssh_install')?.[1] as { attemptId: string })
      .attemptId

    await cancelSshInstall()

    // The install runs under an attempt id like any other SSH work, so cancel is
    // the existing command rather than a second mechanism.
    expect(invokeMock).toHaveBeenCalledWith('ssh_cancel', { attemptId: installId })
  })
})

describe('the shared reducer drives the SSH state', () => {
  function emit(...events: InstallEvent[]) {
    for (const event of events) {
      const current = $sshInstall.get()

      if (current) {
        $sshInstall.set({ ...applyInstallEvent(current, event), host: current.host })
      }
    }
  }

  it('builds the ladder and counts a running stage as half a step', () => {
    offerSshInstall('box')
    emit(
      {
        protocolVersion: 1,
        stages: [
          { name: 'prerequisites', title: 'System prerequisites' },
          { name: 'venv', title: 'Create venv' }
        ],
        type: 'manifest'
      },
      { name: 'prerequisites', state: 'running', type: 'stage' }
    )

    expect($sshInstall.get()?.stageOrder).toEqual(['prerequisites', 'venv'])
    expect($sshInstallProgress.get().fraction).toBeCloseTo(0.25)
  })

  it('keeps the host across every update', () => {
    // `host` is ours, not the reducer's — losing it would blank the copy that
    // names the machine mid-install.
    offerSshInstall('box.example.com')
    emit({ line: 'cloning', stream: 'stderr', type: 'log' }, { installRoot: '/home/u', type: 'complete' })

    expect($sshInstall.get()?.host).toBe('box.example.com')
    expect($sshInstall.get()?.phase).toBe('done')
  })

  it('is zero progress before any manifest', () => {
    offerSshInstall('box')
    expect($sshInstallProgress.get()).toEqual({ done: 0, fraction: 0, total: 0 })
  })
})
