import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

// SSH gateway bindings (MJX-55). The whole lifecycle — dial, host-key check,
// auth, remote spawn, port forward — lives in Rust (src-tauri/src/ssh/); these
// are the typed JS calls. Mirrors store/local-backend.ts.
//
// Unlike Local mode this is NOT desktop-only: Rust speaks SSH with the pure-Rust
// `russh`, so it works on Android and iOS too. What differs on mobile is only
// where credentials come from — see SSH_LOCAL_FILES_SUPPORTED in lib/platform.

/** What a connect needs. Non-secret fields come from the settings form; the
 *  secrets are read from the keyring by the caller and passed through here. */
export interface SshConnectConfig {
  host: string
  user?: string
  port?: number | null
  keyPath?: string
  remoteHermesPath?: string
  profile?: string | null
  /** A pasted PEM held in the keyring. The mobile route — neither Android nor
   *  iOS offers a file picker russh can read a private key through. */
  privateKeyPem?: string
  passphrase?: string
  password?: string
  /** Whether this caller can answer prompts. False for the boot restore, which
   *  runs before any UI is mounted — Rust then fails fast instead of blocking on
   *  a dialog that will never appear. */
  interactive?: boolean
  /** This install's stable id (keyring-held). Without a STABLE value, remote
   *  backends are orphaned: the next connect will not recognize their lockfile
   *  and so will neither reuse nor clean them up. */
  installationId?: string
  /** The token from the last successful connect. Without it a running remote
   *  backend cannot be reattached to, only replaced. */
  reuseToken?: string
}

export interface SshConnection {
  /** Always `http://127.0.0.1:<ephemeral>` — a fresh port on every re-tunnel, so
   *  never key a cache on it (use `ownershipId`). */
  baseUrl: string
  token: string
  wsUrl: string
  localPort: number
  remotePort: number
  pid: number
  /** True when we reattached to a backend that was already running remotely. */
  reused: boolean
  remotePlatform: string
  remoteArch: string
  hermesPath: string
  hermesVersion: string
  ownershipId: string
  hostLabel: string
}

export interface SshTestResult {
  reachable: boolean
  hostLabel: string
  platform?: string
  arch?: string
}

export interface SshResolvedHost {
  hostname?: string
  user?: string
  port?: number
  identityFile?: string
  /** Directives we parsed but do not honour (ProxyJump, ProxyCommand, Match).
   *  Shown in the form: silently ignoring one would connect somewhere the user
   *  did not ask for. */
  unsupported?: string[]
}

/** Why a connect failed. The UI branches on `kind` to pick its copy. */
export type SshErrorKind =
  | 'unreachable'
  | 'auth-failed'
  | 'host-key-changed'
  | 'timeout'
  | 'hermes-not-found'
  | 'unsupported-platform'
  | 'update-required'
  | 'transient-transport-error'
  | 'authenticated-stale'
  | 'superseded'
  | 'cancelled'
  | 'unknown'

export interface SshError {
  kind: SshErrorKind
  message: string
}

/** Narrow an unknown rejection to the typed error Rust returns. */
export function isSshError(value: unknown): value is SshError {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as SshError).kind === 'string' &&
    typeof (value as SshError).message === 'string'
  )
}

export type SshStep =
  | 'connecting'
  | 'authenticating'
  | 'probing-platform'
  | 'locating-hermes'
  | 'checking-existing'
  | 'uploading-token'
  | 'spawning'
  | 'waiting-ready'
  | 'forwarding'
  | 'verifying'

export interface SshProgress {
  step: SshStep
  /** 0–1, for a determinate indicator. */
  fraction: number
  detail?: string
}

export interface SshPromptEvent {
  promptId: string
  kind: 'passphrase' | 'password' | 'keyboard-interactive'
  label: string
  secret: boolean
}

export interface SshHostKeyEvent {
  host: string
  port: number
  fingerprint: string
}

/** A fresh attempt id. Subscribe to its events BEFORE invoking — see below. */
export function newAttemptId(): string {
  return crypto.randomUUID()
}

/**
 * Establish (or reattach to) an SSH-backed gateway.
 *
 * A cold connect can take 45–90s (platform probe, hermes discovery, capability
 * check, token upload, spawn, wait-ready), so callers should subscribe to
 * {@link onSshProgress} first and show the steps.
 */
export function connectSshBackend(attemptId: string, config: SshConnectConfig): Promise<SshConnection> {
  return invoke<SshConnection>('ssh_connect', { attemptId, config })
}

/** Check a host is reachable, authenticates, and runs a supported OS. Uses a
 *  throwaway session, so a failed test can never disturb a live connection. */
export function testSshBackend(attemptId: string, config: SshConnectConfig): Promise<SshTestResult> {
  return invoke<SshTestResult>('ssh_test', { attemptId, config })
}

/** Drop the tunnel for a profile. Deliberately leaves the REMOTE backend
 *  running — it is detached on purpose so the next connect reuses it. */
export function disconnectSsh(profile?: string | null): Promise<void> {
  return invoke<void>('ssh_disconnect', { profile: profile ?? null })
}

/** Abandon an in-flight attempt. */
export function cancelSsh(attemptId: string): Promise<void> {
  return invoke<void>('ssh_cancel', { attemptId })
}

/** Concrete `Host` aliases from `~/.ssh/config`, for the settings dropdown.
 *  Empty on mobile, where there is no config to read. */
export function listSshConfigHosts(): Promise<string[]> {
  return invoke<string[]>('ssh_list_config_hosts')
}

/** What `~/.ssh/config` resolves an alias to. Replaces desktop's `ssh -G`. */
export function resolveSshHost(host: string): Promise<SshResolvedHost> {
  return invoke<SshResolvedHost>('ssh_resolve_host', { host })
}

/** Answer a passphrase/password prompt raised by an in-flight attempt. */
export function answerSshPrompt(attemptId: string, promptId: string, answer: string): Promise<void> {
  return invoke<void>('ssh_answer_prompt', { attemptId, promptId, answer })
}

/** Accept or refuse a host key we have never seen before. */
export function trustSshHostKey(attemptId: string, accept: boolean): Promise<void> {
  return invoke<void>('ssh_trust_host_key', { attemptId, accept })
}

// Events follow transport.rs's `ws://{id}/…` convention and share its contract:
// subscribe BEFORE invoking, or an early step (or a prompt) is missed and the
// connect stalls with nothing on screen.

export function onSshProgress(attemptId: string, handler: (progress: SshProgress) => void): Promise<UnlistenFn> {
  return listen<SshProgress>(`ssh://${attemptId}/progress`, event => handler(event.payload))
}

export function onSshPrompt(attemptId: string, handler: (prompt: SshPromptEvent) => void): Promise<UnlistenFn> {
  return listen<SshPromptEvent>(`ssh://${attemptId}/prompt`, event => handler(event.payload))
}

export function onSshHostKey(attemptId: string, handler: (request: SshHostKeyEvent) => void): Promise<UnlistenFn> {
  return listen<SshHostKeyEvent>(`ssh://${attemptId}/host-key`, event => handler(event.payload))
}
