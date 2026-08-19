import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { atom, computed } from 'nanostores'

import { loadSshSecrets } from '@/lib/secure-store'
import type { SshTarget } from '@/store/connection'
import { getInstallationId } from '@/store/installation-id'
import {
  applyInstallEvent,
  type InstallEvent,
  installProgressOf,
  type LocalInstallState,
  type Repo
} from '@/store/local-install'
import { attachSshPrompts } from '@/store/ssh-backend'

// Installing Allr on a REMOTE host, after an SSH connect failed with
// `hermes-not-found`.
//
// Rust runs the same staged install protocol as the local flow — just over SSH
// exec rather than a child process — and emits on the same
// `hermes-install://{id}/event` channel. So the reducer, the half-step progress
// arithmetic and the 2000-line log ring are imported from `local-install` rather
// than copied; two divergent copies of that logic would be a bug factory.
//
// The state reuses `LocalInstallState`'s phase union verbatim, including
// `'missing'` for "showing the two repo cards". That reads oddly for a second
// there, but it is exactly right: Allr IS missing, on that host. Inventing a
// parallel union would fork `applyInstallEvent`'s return type for no gain.
//
// `null` means no offer is on screen — there is no detection phase here, because
// detection already happened as part of the connect that failed.

export interface SshInstallState extends LocalInstallState {
  /** The host the offer is about, so copy can name it. */
  host: string
}

export const $sshInstall = atom<null | SshInstallState>(null)

export const $sshInstallProgress = computed($sshInstall, state =>
  state ? installProgressOf(state) : { done: 0, total: 0, fraction: 0 }
)

function base(host: string): SshInstallState {
  return {
    error: null,
    host,
    install: null,
    installRoot: null,
    log: [],
    phase: 'missing',
    repo: null,
    stageOrder: [],
    stages: {},
    startedAt: null
  }
}

/** Offer to install on `host`, after a connect failed with hermes-not-found. */
export function offerSshInstall(host: string): void {
  $sshInstall.set(base(host))
}

export function dismissSshInstall(): void {
  $sshInstall.set(null)
}

export function chooseSshRepo(repo: Repo): void {
  const state = $sshInstall.get()

  if (state) {
    $sshInstall.set({ ...state, phase: 'choosing', repo })
  }
}

/**
 * Step back one level within the SSH install flow.
 *
 * Mirrors `stepBackInLocalInstall`: the repo description is a level of its own;
 * an install in flight is cancelled, not navigated away from.
 */
export function stepBackInSshInstall(): boolean {
  const state = $sshInstall.get()

  if (state?.phase !== 'choosing') {
    return false
  }

  $sshInstall.set({ ...state, phase: 'missing', repo: null })

  return true
}

let activeInstallId: null | string = null

function mintInstallId(): string {
  const bytes = new Uint8Array(8)

  crypto.getRandomValues(bytes)

  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Install on the remote host.
 *
 * Subscribes before invoking — the house contract for streamed work. Rust emits
 * the manifest as soon as the remote answers `--manifest`, and a listener
 * attached after the invoke would miss it and leave the UI with no ladder.
 *
 * Credentials come from the keyring exactly as `connectSsh` fetches them, so the
 * install authenticates the same way the failed connect did.
 *
 * `interactive: true` makes Rust arm a real prompter and a host-key policy of
 * Ask — which is only useful if something is listening. It was not: this
 * subscribed to the install channel alone, so a remote wanting a key passphrase
 * (or one whose host key was not yet trusted) stalled for the full 60s prompt
 * timeout and then failed with "Timed out waiting for an answer". Hence
 * `attachSshPrompts`, which publishes to the atoms SshPromptDialog renders.
 */
export async function startSshInstall(target: SshTarget): Promise<void> {
  const state = $sshInstall.get()
  const repo = state?.repo

  if (!state || !repo) {
    return
  }

  const installId = mintInstallId()

  activeInstallId = installId

  $sshInstall.set({
    ...state,
    error: null,
    log: [],
    phase: 'installing',
    stageOrder: [],
    stages: {},
    startedAt: Date.now()
  })

  const unlisten: UnlistenFn[] = []

  try {
    unlisten.push(
      await listen<InstallEvent>(`hermes-install://${installId}/event`, event => {
        const current = $sshInstall.get()

        if (current) {
          // `host` is ours, not the reducer's — carry it across every update.
          $sshInstall.set({ ...applyInstallEvent(current, event.payload), host: current.host })
        }
      })
    )

    // Same contract as the install channel: subscribed BEFORE the invoke,
    // because auth is the first thing that happens and a prompt raised in that
    // window would otherwise be lost.
    unlisten.push(await attachSshPrompts(installId))

    const [installationId, secrets] = await Promise.all([getInstallationId(), loadSshSecrets()])

    await invoke<void>('ssh_install', {
      attemptId: installId,
      branch: null,
      config: {
        ...target,
        installationId,
        interactive: true,
        passphrase: secrets.passphrase,
        password: secrets.password,
        privateKeyPem: secrets.privateKeyPem
      },
      repo
    })
  } catch (err) {
    const current = $sshInstall.get()

    if (current && current.phase !== 'failed') {
      $sshInstall.set({ ...current, error: errorText(err), phase: 'failed' })
    }
  } finally {
    unlisten.forEach(stop => stop())
    activeInstallId = null
  }
}

/** Rust rejects with a typed `{kind, message}`, not an `Error`. */
function errorText(value: unknown): string {
  if (value instanceof Error) {
    return value.message
  }

  if (typeof value === 'object' && value !== null && 'message' in value) {
    return String((value as { message: unknown }).message)
  }

  return String(value)
}

/** Reuses `ssh_cancel` — the install runs under an attempt id like any other. */
export async function cancelSshInstall(): Promise<void> {
  const installId = activeInstallId

  if (!installId) {
    return
  }

  try {
    await invoke<void>('ssh_cancel', { attemptId: installId })
  } catch {
    // Best effort — the run may already have finished.
  }
}

/** Test seam. */
export function resetSshInstall(next: null | Partial<SshInstallState> = null): void {
  activeInstallId = null
  $sshInstall.set(next ? { ...base(next.host ?? 'example.com'), ...next } : null)
}
