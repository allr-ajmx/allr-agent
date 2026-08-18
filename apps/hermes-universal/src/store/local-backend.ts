import { invoke } from '@tauri-apps/api/core'

// Local-spawn backend bindings (E3.b, desktop-only). The spawn/readiness lifecycle
// lives in Rust (src-tauri/src/local_backend.rs); these are the typed JS calls.
// On mobile the Rust commands return `unsupported_platform`, but the UI gates the
// Local mode off (LOCAL_MODE_SUPPORTED) so these are never reached there.

export interface LocalBackend {
  baseUrl: string
  token: string
  wsUrl: string
}

export interface LocalBackendStatus {
  running: boolean
  baseUrl?: string | null
}

/** Spawn `allr serve` and resolve once it's HTTP-ready. */
export function spawnLocalBackend(profile?: string | null): Promise<LocalBackend> {
  return invoke<LocalBackend>('local_backend_spawn', { profile: profile ?? null })
}

/** Whether a local backend is currently running (+ its base URL). */
export function localBackendStatus(): Promise<LocalBackendStatus> {
  return invoke<LocalBackendStatus>('local_backend_status')
}

/** Stop the running local backend (kills the child). Best-effort. */
export function stopLocalBackend(): Promise<void> {
  return invoke<void>('local_backend_stop')
}
