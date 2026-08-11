import { open } from '@tauri-apps/plugin-dialog'
import { readFile } from '@tauri-apps/plugin-fs'

import { formatRefValue as refValue } from '@/components/assistant-ui/directive-text'
import { translateNow } from '@/i18n'
import { selectRemotePaths } from '@/lib/desktop-fs'
import { ensureSession } from '@/store/chat'
import type { ComposerAttachment } from '@/store/composer'
import { requestGateway } from '@/store/gateway'
import { notifyError } from '@/store/notifications'
import { withSessionNotFoundResume } from '@/store/session-recovery'

// Attachment staging (Gc8/R7). Pick a file → read bytes → data-URL → file.attach
// (which stages it server-side and returns a @file:/@image: ref) → the ref is
// spliced into the prompt text on submit (the desktop model).
// FIXME(Gc8): base64 of a large file blocks the main thread; Android SAF
// content-URIs vs fs.readFile paths need on-device validation.
//
// Every ref this module BUILDS goes through `refValue` (formatRefValue), which
// quotes a value the reference grammar would otherwise cut short. The gateway's
// pattern falls back to `\S+` for an unquoted value, so `@folder:/srv/my code`
// resolves `/srv/my` — a directory that often exists — and strands ` code` in
// the prompt as prose. `file.attach` already quotes on its side
// (`_format_ref_value` in tui_gateway/methods_prompt.py); these are the refs we
// mint ourselves, so they have to do the same.

const MIME_BY_EXT: Record<string, string> = {
  gif: 'image/gif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  json: 'application/json',
  md: 'text/markdown',
  pdf: 'application/pdf',
  png: 'image/png',
  svg: 'image/svg+xml',
  txt: 'text/plain',
  webp: 'image/webp'
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() || path
}

function mimeFor(name: string): string {
  return MIME_BY_EXT[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream'
}

function toDataUrl(bytes: Uint8Array, mime: string): string {
  let binary = ''

  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }

  return `data:${mime};base64,${btoa(binary)}`
}

export interface StagedAttachment {
  ref: string
  name: string
}

/**
 * Stage an already-known absolute path via file.attach (read bytes → data-URL →
 * gateway) and return its prompt ref. Shared by the picker and the OS file-drop
 * handler (a Tauri drop hands over paths directly). Returns null on failure —
 * e.g. a dropped directory, whose readFile throws, is skipped rather than fatal.
 *
 * Failure RAISES a notification rather than returning quietly. The caller can't
 * tell "cancelled" from "failed" (both were null), so an unreadable file, an
 * Android SAF content-URI `readFile` can't open, or a `file.attach` that answers
 * without a ref all used to land as complete silence: no chip, no error, the
 * turn sent as if nothing had been attached. Cancel never reaches here — the
 * pickers return before calling.
 */
export async function stageAttachmentFromPath(path: string): Promise<StagedAttachment | null> {
  try {
    const name = basename(path)
    const bytes = await readFile(path)
    const dataUrl = toDataUrl(bytes, mimeFor(name))
    const { id: sessionId, storedId } = await ensureSession()

    // Attach runs against the RUNTIME session id, so after a sleep/wake it hits
    // a dead runtime and 'session not found' — while plain text silently
    // recovered on its own, which is exactly why the bug read as "text works,
    // images don't". One shared resolver rebinds and retries once (MJXHRM-219).
    const { result: res } = await withSessionNotFoundResume(sessionId, storedId, live =>
      requestGateway<{ ref_text?: string }>('file.attach', {
        name,
        path,
        session_id: live,
        data_url: dataUrl
      })
    )

    if (res.ref_text) {
      return { ref: res.ref_text, name }
    }

    throw new Error(translateNow('composer.attachNoRef'))
  } catch (error) {
    notifyError(error, translateNow('composer.attachFailed', basename(path)))

    return null
  }
}

/** Open the picker, stage the file via file.attach, return its prompt ref. */
export async function pickAttachment(): Promise<StagedAttachment | null> {
  const path = await open({ multiple: false }).catch(() => null)

  if (typeof path !== 'string') {
    return null
  }

  return stageAttachmentFromPath(path)
}

/**
 * Pick a folder (no byte staging — folders resolve as `@folder:` refs).
 *
 * LOCAL, so the path is only meaningful when this machine's disk IS the
 * gateway's: see `gatewayOwnsLocalFs`, which is what decides whether the
 * composer offers this at all.
 */
export async function pickFolderAttachment(): Promise<StagedAttachment | null> {
  const path = await open({ directory: true, multiple: false }).catch(() => null)

  if (typeof path !== 'string') {
    return null
  }

  return { name: basename(path), ref: `@folder:${refValue(path)}` }
}

// Remote picks browse the BACKEND filesystem, so no staging/file.attach — the
// path already lives where the session runs and a raw ref is the whole job
// (the same shape the gateway's @-mention completions produce).

/** Pick a file on the backend filesystem → `@file:` ref. */
export async function pickRemoteAttachment(defaultPath?: string): Promise<StagedAttachment | null> {
  const [path] = await selectRemotePaths({ defaultPath })

  return path ? { name: basename(path), ref: `@file:${refValue(path)}` } : null
}

/** Pick a folder on the backend filesystem → `@folder:` ref. */
export async function pickRemoteFolderAttachment(defaultPath?: string): Promise<StagedAttachment | null> {
  const [path] = await selectRemotePaths({ defaultPath, directories: true })

  return path ? { name: basename(path), ref: `@folder:${refValue(path)}` } : null
}

/**
 * Convert a StagedAttachment (gateway ref + name) into the ComposerAttachment
 * the ported composer's scope model uses. Kind is inferred from the ref prefix.
 */
export function stagedToComposerAttachment(staged: StagedAttachment): ComposerAttachment {
  const ref = staged.ref

  const kind: ComposerAttachment['kind'] = ref.startsWith('@image:')
    ? 'image'
    : ref.startsWith('@folder:')
      ? 'folder'
      : ref.startsWith('@url:')
        ? 'url'
        : ref.startsWith('@terminal:')
          ? 'terminal'
          : 'file'

  return { id: ref, kind, label: staged.name, refText: ref }
}
