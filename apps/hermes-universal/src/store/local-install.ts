import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { atom, computed } from 'nanostores'

// The Local gateway step's state: find an existing Hermes, and if there isn't
// one, install it.
//
// Reducer shape is lifted from apps/bootstrap-installer/src/store.ts, which
// already consumes this exact install protocol. Two of its details are load
// bearing rather than cosmetic and are called out at their definitions: the
// half-step progress weighting, and the log ring cap.

export type InstallKind = 'managed' | 'none' | 'path'

export interface LocalInstall {
  kind: InstallKind
  root: null | string
  command: null | string
  version: null | string
  hasMarker: boolean
}

/** Which Hermes to install. Rust owns the URLs; this is only a name. */
export type Repo = 'fork' | 'upstream'

export type StageState = 'failed' | 'pending' | 'running' | 'skipped' | 'succeeded'

export interface StageInfo {
  name: string
  title: string
  category?: string
  needs_user_input?: boolean
}

export interface LogLine {
  stage: null | string
  line: string
  stream: 'stderr' | 'stdout'
}

export type InstallEvent =
  | { type: 'complete'; installRoot: string; marker?: unknown }
  | { type: 'failed'; stage?: null | string; error: string }
  | { type: 'log'; stage?: null | string; line: string; stream: 'stderr' | 'stdout' }
  | { type: 'manifest'; stages: StageInfo[]; protocolVersion: null | number }
  | { type: 'stage'; name: string; state: Exclude<StageState, 'pending'>; durationMs?: number; reason?: null | string }

export type InstallPhase =
  | 'choosing'
  | 'detecting'
  | 'done'
  | 'failed'
  | 'found'
  | 'installing'
  | 'missing'

export interface LocalInstallState {
  phase: InstallPhase
  install: LocalInstall | null
  repo: null | Repo
  stages: Record<string, { title: string; state: StageState; durationMs?: number; reason?: null | string }>
  stageOrder: string[]
  log: LogLine[]
  error: null | string
  startedAt: null | number
  installRoot: null | string
}

const INITIAL: LocalInstallState = {
  error: null,
  install: null,
  installRoot: null,
  log: [],
  phase: 'detecting',
  repo: null,
  stageOrder: [],
  stages: {},
  startedAt: null
}

export const $localInstall = atom<LocalInstallState>(INITIAL)

export interface InstallProgress {
  done: number
  total: number
  fraction: number
}

/**
 * How far along an install is.
 *
 * A `node-deps` stage pulls a Playwright Chromium and runs for minutes. Counting
 * only finished stages leaves the bar frozen for that whole time, which reads as
 * a hang; a running stage therefore counts as half. Same trick as the desktop
 * install overlay.
 *
 * Exported as a plain function because the SSH remote install runs the identical
 * protocol over a different transport and shares this arithmetic — two copies
 * would drift.
 */
export function installProgressOf(state: LocalInstallState): InstallProgress {
  const total = state.stageOrder.length

  if (total === 0) {
    return { done: 0, total: 0, fraction: 0 }
  }

  let units = 0
  let done = 0

  for (const name of state.stageOrder) {
    const stage = state.stages[name]?.state

    if (stage === 'succeeded' || stage === 'skipped' || stage === 'failed') {
      units += 1
      done += 1
    } else if (stage === 'running') {
      units += 0.5
    }
  }

  return { done, total, fraction: units / total }
}

export const $installProgress = computed($localInstall, installProgressOf)

// The Playwright download alone is ~10k lines. Keeping every line would grow the
// atom without bound and re-render the log pane on each one.
const LOG_LIMIT = 2000

/** Pure reducer, exported so the state machine is testable without Tauri. */
export function applyInstallEvent(state: LocalInstallState, event: InstallEvent): LocalInstallState {
  switch (event.type) {
    case 'manifest': {
      const stages: LocalInstallState['stages'] = {}

      for (const stage of event.stages) {
        stages[stage.name] = { state: 'pending', title: stage.title }
      }

      // Seeded all-pending up front so the user sees the whole ladder and can
      // judge how far along the install is, rather than watching rows appear.
      return {
        ...state,
        error: null,
        phase: 'installing',
        stageOrder: event.stages.map(stage => stage.name),
        stages,
        startedAt: state.startedAt ?? Date.now()
      }
    }

    case 'stage': {
      const existing = state.stages[event.name]

      return {
        ...state,
        stages: {
          ...state.stages,
          [event.name]: {
            durationMs: event.durationMs,
            reason: event.reason ?? null,
            state: event.state,
            title: existing?.title ?? event.name
          }
        }
      }
    }

    case 'log': {
      const next = [...state.log, { line: event.line, stage: event.stage ?? null, stream: event.stream }]

      return { ...state, log: next.length > LOG_LIMIT ? next.slice(next.length - LOG_LIMIT) : next }
    }

    case 'complete':
      return { ...state, error: null, installRoot: event.installRoot, phase: 'done' }

    case 'failed':
      return { ...state, error: event.error, phase: 'failed' }

    default:
      return state
  }
}

/** Look for an existing install. Never rejects — "none" is a normal answer. */
export async function detectLocalInstall(): Promise<void> {
  $localInstall.set({ ...INITIAL, phase: 'detecting' })

  try {
    const install = await invoke<LocalInstall>('local_install_detect')

    $localInstall.set({
      ...$localInstall.get(),
      install,
      phase: install.kind === 'none' ? 'missing' : 'found'
    })
  } catch {
    // A detection that could not run is indistinguishable from nothing being
    // installed, and the recovery is the same screen either way.
    $localInstall.set({ ...$localInstall.get(), install: null, phase: 'missing' })
  }
}

export function chooseRepo(repo: Repo): void {
  $localInstall.set({ ...$localInstall.get(), phase: 'choosing', repo })
}

export function backToRepoChoice(): void {
  $localInstall.set({ ...$localInstall.get(), phase: 'missing', repo: null })
}

/**
 * Step back one level WITHIN the local flow, if there is one.
 *
 * Returns true when it consumed the press. The wizard has exactly one Back
 * button, in its step header, and it calls this first — so the repo description
 * can be backed out of without the panel growing a second Back underneath the
 * first. Only the repo description is a level of its own: an install in flight
 * is cancelled, not navigated away from.
 */
export function stepBackInLocalInstall(): boolean {
  if ($localInstall.get().phase !== 'choosing') {
    return false
  }

  backToRepoChoice()

  return true
}

let activeInstallId: null | string = null

/** The id the current install is streaming under, for cancel. */
export function currentInstallId(): null | string {
  return activeInstallId
}

function mintInstallId(): string {
  const bytes = new Uint8Array(8)

  crypto.getRandomValues(bytes)

  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Install the chosen repo.
 *
 * Subscribes BEFORE invoking — the house contract for streamed work. The Rust
 * side emits the manifest almost immediately, and a listener attached after the
 * invoke would miss it and leave the UI with no stage list at all.
 */
export async function startLocalInstall(): Promise<void> {
  const state = $localInstall.get()
  const repo = state.repo

  if (!repo) {
    return
  }

  const installId = mintInstallId()

  activeInstallId = installId

  $localInstall.set({
    ...state,
    error: null,
    log: [],
    phase: 'installing',
    stageOrder: [],
    stages: {},
    startedAt: Date.now()
  })

  let unlisten: UnlistenFn | null = null

  try {
    unlisten = await listen<InstallEvent>(`hermes-install://${installId}/event`, event => {
      $localInstall.set(applyInstallEvent($localInstall.get(), event.payload))
    })

    await invoke<void>('local_install_start', { installId, repo, branch: null })
  } catch (err) {
    // Rust emits `failed` for anything it reaches; this covers the rest (the
    // command itself rejecting, or the listener failing to attach).
    const message = err instanceof Error ? err.message : String(err)
    const current = $localInstall.get()

    if (current.phase !== 'failed') {
      $localInstall.set({ ...current, error: message, phase: 'failed' })
    }
  } finally {
    unlisten?.()
    activeInstallId = null
  }
}

export async function cancelLocalInstall(): Promise<void> {
  const installId = activeInstallId

  if (!installId) {
    return
  }

  try {
    await invoke<void>('local_install_cancel', { installId })
  } catch {
    // Best effort — the run may already have finished.
  }
}

/** Test seam. */
export function resetLocalInstall(next: Partial<LocalInstallState> = {}): void {
  activeInstallId = null
  $localInstall.set({ ...INITIAL, ...next })
}
