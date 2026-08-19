import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }))

import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

import {
  $installProgress,
  $localInstall,
  applyInstallEvent,
  detectLocalInstall,
  type InstallEvent,
  type LocalInstallState,
  resetLocalInstall,
  startLocalInstall,
  stepBackInLocalInstall
} from './local-install'

const invokeMock = vi.mocked(invoke)
const listenMock = vi.mocked(listen)

const STAGES = [
  { name: 'prerequisites', title: 'System prerequisites' },
  { name: 'repository', title: 'Download Allr' },
  { name: 'venv', title: 'Create Python virtual environment' }
]

const manifest: InstallEvent = { protocolVersion: 1, stages: STAGES, type: 'manifest' }

/** Fold a list of events over the initial state. */
function reduce(events: InstallEvent[], from?: Partial<LocalInstallState>): LocalInstallState {
  resetLocalInstall(from)

  return events.reduce(applyInstallEvent, $localInstall.get())
}

beforeEach(() => {
  listenMock.mockReset()
  invokeMock.mockReset()
  listenMock.mockResolvedValue(() => {})
  invokeMock.mockResolvedValue(undefined)
  resetLocalInstall()
})

describe('the install reducer', () => {
  it('seeds every stage as pending from the manifest', () => {
    const state = reduce([manifest])

    expect(state.phase).toBe('installing')
    expect(state.stageOrder).toEqual(['prerequisites', 'repository', 'venv'])
    // All-pending up front, so the user can see how long the ladder is rather
    // than watching rows appear one at a time.
    expect(Object.values(state.stages).every(stage => stage.state === 'pending')).toBe(true)
    expect(state.stages.venv.title).toBe('Create Python virtual environment')
  })

  it('keeps the manifest title when a stage transitions', () => {
    // The stage event carries no title; losing it would flip the row to a raw
    // slug mid-install.
    const state = reduce([manifest, { name: 'venv', state: 'running', type: 'stage' }])

    expect(state.stages.venv.title).toBe('Create Python virtual environment')
    expect(state.stages.venv.state).toBe('running')
  })

  it('records skipped separately from succeeded', () => {
    // setup/gateway report skipped under --non-interactive; showing them as
    // failed would make a healthy install look broken.
    const state = reduce([manifest, { name: 'venv', state: 'skipped', type: 'stage' }])

    expect(state.stages.venv.state).toBe('skipped')
  })

  it('moves to done on complete and failed on failure', () => {
    expect(reduce([manifest, { installRoot: '/root', type: 'complete' }]).phase).toBe('done')

    const failed = reduce([manifest, { error: 'no python', stage: 'venv', type: 'failed' }])

    expect(failed.phase).toBe('failed')
    expect(failed.error).toBe('no python')
  })

  it('trims the log ring so a huge install cannot grow it without bound', () => {
    // The Playwright download alone is ~10k lines.
    const lines: InstallEvent[] = Array.from({ length: 2500 }, (_, i) => ({
      line: `line ${i}`,
      stream: 'stdout',
      type: 'log'
    }))

    const state = reduce([manifest, ...lines])

    expect(state.log).toHaveLength(2000)
    // The trim must drop the OLDEST lines — the tail is what explains a failure.
    expect(state.log.at(-1)?.line).toBe('line 2499')
    expect(state.log[0].line).toBe('line 500')
  })

  it('tags which pipe a line came from', () => {
    const state = reduce([{ line: 'Resolving deps', stream: 'stderr', type: 'log' }])

    // uv/pip/git/npm write ordinary progress to stderr; the UI dims it rather
    // than painting it as an error.
    expect(state.log[0].stream).toBe('stderr')
  })
})

describe('install progress', () => {
  it('counts a running stage as half a step', () => {
    // node-deps runs for minutes. Counting only finished stages leaves the bar
    // motionless for that whole time, which reads as a hang.
    $localInstall.set(reduce([manifest, { name: 'prerequisites', state: 'running', type: 'stage' }]))

    const progress = $installProgress.get()

    expect(progress.done).toBe(0)
    expect(progress.total).toBe(3)
    expect(progress.fraction).toBeCloseTo(0.5 / 3)
  })

  it('counts finished stages regardless of outcome', () => {
    $localInstall.set(
      reduce([
        manifest,
        { name: 'prerequisites', state: 'succeeded', type: 'stage' },
        { name: 'repository', state: 'skipped', type: 'stage' },
        { name: 'venv', state: 'failed', type: 'stage' }
      ])
    )

    const progress = $installProgress.get()

    // A failed stage is still resolved — the bar must not stall at 2/3 while
    // the UI is already showing the failure.
    expect(progress.done).toBe(3)
    expect(progress.fraction).toBe(1)
  })

  it('is zero rather than NaN before any manifest arrives', () => {
    resetLocalInstall()
    expect($installProgress.get()).toEqual({ done: 0, fraction: 0, total: 0 })
  })
})

describe('stepping back inside the local flow', () => {
  it('consumes the press on the repo description and returns to the list', () => {
    resetLocalInstall({ phase: 'choosing', repo: 'fork' })

    expect(stepBackInLocalInstall()).toBe(true)
    expect($localInstall.get().phase).toBe('missing')
    // The selection is cleared too, so the list opens with nothing preselected.
    expect($localInstall.get().repo).toBeNull()
  })

  it('declines the press everywhere else, so the wizard handles it', () => {
    // Returning true here would trap the user in the local step: the header's
    // Back would stop rewinding the wizard and appear to do nothing.
    for (const phase of ['detecting', 'found', 'missing', 'installing', 'done', 'failed'] as const) {
      resetLocalInstall({ phase })
      expect(stepBackInLocalInstall(), phase).toBe(false)
      expect($localInstall.get().phase).toBe(phase)
    }
  })
})

describe('detection', () => {
  it('reports found for a real install', async () => {
    invokeMock.mockResolvedValue({
      command: '/usr/local/bin/allr',
      hasMarker: false,
      kind: 'path',
      root: null,
      version: 'hermes 1.2.3'
    })

    await detectLocalInstall()

    expect($localInstall.get().phase).toBe('found')
    expect($localInstall.get().install?.version).toBe('hermes 1.2.3')
  })

  it('reports missing for kind none', async () => {
    invokeMock.mockResolvedValue({ command: null, hasMarker: false, kind: 'none', root: null, version: null })

    await detectLocalInstall()

    expect($localInstall.get().phase).toBe('missing')
  })

  it('falls back to missing when detection itself fails', async () => {
    // "Could not tell" and "not installed" lead to the same screen, and an
    // unhandled rejection here would leave the step on a dead spinner.
    invokeMock.mockRejectedValue(new Error('boom'))

    await detectLocalInstall()

    expect($localInstall.get().phase).toBe('missing')
  })
})

describe('starting an install', () => {
  it('subscribes before invoking', async () => {
    // Rust emits the manifest almost immediately; a listener attached after the
    // invoke would miss it and the UI would have no stage list at all.
    const order: string[] = []

    listenMock.mockImplementation(async () => {
      order.push('listen')

      return () => {}
    })
    invokeMock.mockImplementation(async () => {
      order.push('invoke')
    })

    resetLocalInstall({ phase: 'choosing', repo: 'fork' })
    await startLocalInstall()

    expect(order).toEqual(['listen', 'invoke'])
  })

  it('passes the chosen repo as a name, never a URL', async () => {
    resetLocalInstall({ phase: 'choosing', repo: 'fork' })
    await startLocalInstall()

    const [command, args] = invokeMock.mock.calls[0] as [string, { repo: string }]

    expect(command).toBe('local_install_start')
    expect(args.repo).toBe('fork')
    // Rust owns the URLs. A URL from here would become a clone target and an
    // executed script.
    expect(JSON.stringify(args)).not.toContain('http')
  })

  it('subscribes to a per-install channel', async () => {
    resetLocalInstall({ phase: 'choosing', repo: 'upstream' })
    await startLocalInstall()

    const channel = listenMock.mock.calls[0][0] as string
    const { installId } = invokeMock.mock.calls[0][1] as unknown as { installId: string }

    expect(channel).toBe(`hermes-install://${installId}/event`)
  })

  it('does nothing without a chosen repo', async () => {
    resetLocalInstall({ phase: 'missing', repo: null })
    await startLocalInstall()

    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('surfaces a rejected command as a failure', async () => {
    invokeMock.mockRejectedValue(new Error('git missing'))
    resetLocalInstall({ phase: 'choosing', repo: 'upstream' })

    await startLocalInstall()

    expect($localInstall.get().phase).toBe('failed')
    expect($localInstall.get().error).toContain('git missing')
  })

  it('clears a previous run’s stages and log', async () => {
    resetLocalInstall({
      log: [{ line: 'old', stage: null, stream: 'stdout' }],
      phase: 'choosing',
      repo: 'fork',
      stageOrder: ['stale'],
      stages: { stale: { state: 'failed', title: 'Stale' } }
    })

    await startLocalInstall()

    // A retry that kept the failed ladder would show the old failure beside the
    // new run's progress.
    expect($localInstall.get().stageOrder).toEqual([])
    expect($localInstall.get().log).toEqual([])
  })
})
