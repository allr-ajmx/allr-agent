import { loadString } from '@/lib/persist'
import { Codecs, persistentAtom } from '@/lib/persisted'

// Default project directory: the folder new LOCAL chats start in. Ported from
// desktop's Sessions settings (DefaultProjectDirSetting). Desktop persists a
// project-dir.json in the Electron userData dir; here it's a non-secret path in
// localStorage (the native folder picker only returns existing folders, so no
// mkdir/existence-check is needed). The chosen dir is applied per-session as the
// `cwd` field of the `session.create` RPC (store/chat.ts ensureSession), which the
// gateway honors — cwd is a create-time param, not a backend-spawn one. Local mode
// only: a local path is meaningless to a remote/cloud gateway.
export const $defaultProjectDir = persistentAtom<null | string>('hermes.defaultProjectDir', null, Codecs.nullableText)

/** Set (or clear, with null) the default project directory. */
export function setDefaultProjectDir(dir: null | string): void {
  $defaultProjectDir.set(dir?.trim() || null)
}

/**
 * The cwd to pre-attach to a NEW session's `session.create`, or undefined. Only
 * applies to LOCAL connections (a local path is meaningless to a remote/cloud
 * gateway — matches desktop's local-only workspaceCwdForNewSession). Reads the
 * persisted gateway mode directly (key from store/gateway-switch) to stay
 * import-light — importing the connection store into chat.ts drags in the whole
 * gateway module and breaks store tests that mock it partially.
 */
export function cwdForNewSession(): string | undefined {
  const dir = $defaultProjectDir.get()?.trim()

  if (!dir) {
    return undefined
  }

  // Deliberately `local` only. An ssh-backed gateway runs on the REMOTE host, so
  // a directory picked from this machine's filesystem does not exist there —
  // sending it would point new sessions at a path that is absent or, worse,
  // happens to exist and means something else. Same reasoning for remote/cloud.
  return loadString('hermes.gateway.mode') === 'local' ? dir : undefined
}
