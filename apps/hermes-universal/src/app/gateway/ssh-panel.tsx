import { useEffect, useState } from 'react'

import { ListRow } from '@/app/settings/primitives'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { Translations } from '@/i18n'
import { AlertCircle, Loader2 } from '@/lib/icons'
import { SSH_LOCAL_FILES_SUPPORTED } from '@/lib/platform'
import { listSshConfigHosts, resolveSshHost, type SshHostKeyEvent, type SshPromptEvent } from '@/store/ssh-backend'

// The SSH connection form. Split out of gateway-configurator so that file stays
// about mode selection rather than growing a fourth full panel inline.
//
// What differs from desktop's equivalent (src/app/settings/gateway-settings.tsx
// :1360-1425) is driven by two things:
//
//   - We have no `ssh` binary, so the ~/.ssh/config host list and its resolution
//     come from Rust rather than from `ssh -G`. Resolution is SHOWN in the form,
//     because our parser implements a documented subset and a silent divergence
//     from the user's own ssh would be a nasty way to fail.
//
//   - Desktop ran ssh with BatchMode=yes and so could never prompt. We can, which
//     is why this panel also renders passphrase/password and host-key questions
//     mid-connect.

type Gateway = Translations['settings']['gateway']

export interface SshFormState {
  host: string
  user: string
  port: string
  keyPath: string
  privateKeyPem: string
  passphrase: string
  remoteHermesPath: string
}

export const EMPTY_SSH_FORM: SshFormState = {
  host: '',
  user: '',
  port: '',
  keyPath: '',
  privateKeyPem: '',
  passphrase: '',
  remoteHermesPath: ''
}

/** Parse the port field. Blank or nonsense means "unset", which lets
 *  ~/.ssh/config (or the default 22) decide — never silently 0. */
export function parsePortField(value: string): number | null {
  const trimmed = value.trim()

  if (!trimmed || !/^\d+$/.test(trimmed)) {
    return null
  }

  const port = Number(trimmed)

  return port > 0 && port <= 65535 ? port : null
}

/** Whether a string is a port Rust's target parser would accept off the host.
 *  Deliberately wider than {@link parsePortField}: 0 is split off here and
 *  dropped there, which is what `normalize_ssh_target` does too. */
function isEmbeddedPort(value: string): boolean {
  return /^\d+$/.test(value) && Number(value) <= 65535
}

/** Split `[inner]` / `[inner]:port`. Null when not bracketed, or when what
 *  follows the bracket is not a port — the caller then treats the whole thing
 *  as a bare IPv6 literal, which has no port to take off it. */
function splitBracketed(value: string): null | { host: string; port?: string } {
  if (!value.startsWith('[')) {
    return null
  }

  const close = value.indexOf(']', 1)
  const inner = close < 0 ? '' : value.slice(1, close)

  if (!inner) {
    return null
  }

  const after = value.slice(close + 1)

  if (!after) {
    return { host: inner }
  }

  const rawPort = after.startsWith(':') ? after.slice(1) : ''

  return isEmbeddedPort(rawPort) ? { host: inner, port: rawPort } : null
}

/**
 * Pull an embedded user and port out of whatever was typed into the host field.
 *
 * Rust's `normalize_ssh_target` already absorbs `user@box:2222` — that is why
 * pasting one connects — but it does so invisibly, leaving the User and Port
 * rows looking empty while the connection plainly had both. This mirrors that
 * parser exactly so the form can show the same reading it will be given, rather
 * than the UI and the backend quietly disagreeing about what was entered.
 *
 * Kept in step with `src-tauri/src/ssh/target.rs`: first `@` only and only past
 * index 0 (a leading `@` is not an empty user — it stays put and fails host
 * validation, as there), brackets before colons, and a lone colon required
 * before splitting a port, since two or more mean a bare IPv6 literal.
 */
export function splitSshHostInput(raw: string): { host: string; port?: string; user?: string } {
  let host = raw.trim()

  if (!host) {
    return { host: '' }
  }

  let user: string | undefined
  let port: string | undefined

  const at = host.indexOf('@')

  if (at > 0) {
    user = host.slice(0, at)
    host = host.slice(at + 1)
  }

  const bracketed = splitBracketed(host)

  if (bracketed) {
    host = bracketed.host
    port = bracketed.port
  } else if (host.split(':').length === 2) {
    const [name, rawPort] = host.split(':')

    if (isEmbeddedPort(rawPort)) {
      host = name
      port = rawPort
    }
  }

  return { host, port, user }
}

/** The non-secret half of the form, as the connect call wants it. */
export function sshTargetFromForm(form: SshFormState): {
  host: string
  user?: string
  port: number | null
  keyPath?: string
  remoteHermesPath?: string
} {
  return {
    host: form.host.trim(),
    user: form.user.trim() || undefined,
    port: parsePortField(form.port),
    keyPath: form.keyPath.trim() || undefined,
    remoteHermesPath: form.remoteHermesPath.trim() || undefined
  }
}

export function SshPanel({
  form,
  g,
  hostKey,
  onAnswerPrompt,
  onTrustHostKey,
  progress,
  prompt,
  setForm
}: {
  form: SshFormState
  g: Gateway
  hostKey: null | SshHostKeyEvent
  onAnswerPrompt: (answer: string) => void
  onTrustHostKey: (accept: boolean) => void
  progress: null | string
  prompt: null | SshPromptEvent
  setForm: (next: SshFormState) => void
}) {
  const [configHosts, setConfigHosts] = useState<string[]>([])
  const [unsupported, setUnsupported] = useState<string[]>([])
  const [answer, setAnswer] = useState('')

  const set = <K extends keyof SshFormState>(key: K, value: SshFormState[K]) => setForm({ ...form, [key]: value })

  /**
   * Move an embedded user and port out of the host field and into their own.
   *
   * Run on commit (blur or Enter), not on every keystroke: splitting mid-typing
   * would move the caret out from under someone the moment they typed `@`.
   *
   * A field the user has already filled in wins and is left alone, matching the
   * precedence Rust applies — so this only ever fills blanks and never quietly
   * overwrites something that was typed deliberately.
   */
  const absorbHostParts = () => {
    const parts = splitSshHostInput(form.host)
    const user = form.user.trim() ? form.user : (parts.user ?? form.user)
    const port = form.port.trim() ? form.port : (parts.port ?? form.port)

    if (parts.host === form.host && user === form.user && port === form.port) {
      return
    }

    setForm({ ...form, host: parts.host, port, user })
  }

  // The ~/.ssh/config host list. Empty on mobile (no ~/.ssh), which is why this
  // is a datalist of suggestions rather than a required picker.
  useEffect(() => {
    if (!SSH_LOCAL_FILES_SUPPORTED) {
      return
    }

    let live = true
    void listSshConfigHosts()
      .then(hosts => {
        if (live) {
          setConfigHosts(hosts)
        }
      })
      .catch(() => {})

    return () => {
      live = false
    }
  }, [])

  // Show what ~/.ssh/config resolves this host to, and flag any directive we
  // parsed but do not honour. Debounced so typing does not hammer the IPC.
  const host = form.host.trim()

  useEffect(() => {
    if (!SSH_LOCAL_FILES_SUPPORTED || !host) {
      setUnsupported([])

      return
    }

    let live = true

    const timer = setTimeout(() => {
      void resolveSshHost(host)
        .then(resolved => {
          if (live) {
            setUnsupported(resolved.unsupported ?? [])
          }
        })
        .catch(() => {})
    }, 400)

    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [host])

  return (
    <div className="mt-5 grid gap-1">
      <ListRow
        action={
          <>
            <Input
              className="font-normal"
              list={configHosts.length ? 'hermes-ssh-config-hosts' : undefined}
              onBlur={absorbHostParts}
              onChange={event => set('host', event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter') {
                  absorbHostParts()
                }
              }}
              placeholder={g.sshHostPlaceholder}
              value={form.host}
            />
            {configHosts.length ? (
              <datalist id="hermes-ssh-config-hosts">
                {configHosts.map(alias => (
                  <option key={alias} value={alias} />
                ))}
              </datalist>
            ) : null}
          </>
        }
        description={g.sshHostDesc}
        title={g.sshHostTitle}
      />

      {unsupported.length ? (
        <div className="flex items-start gap-2 rounded-md bg-(--ui-warning-bg) px-3 py-2 text-xs text-(--ui-warning-text)">
          <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
          <span>{g.sshUnsupportedDirectives(unsupported.join(', '))}</span>
        </div>
      ) : null}

      <ListRow
        action={
          <Input
            className="font-normal"
            onChange={event => set('user', event.target.value)}
            placeholder="deploy"
            value={form.user}
          />
        }
        description={g.sshUserDesc}
        title={g.sshUserTitle}
      />

      <ListRow
        action={
          <Input
            className="font-normal"
            inputMode="numeric"
            onChange={event => set('port', event.target.value)}
            placeholder="22"
            value={form.port}
          />
        }
        description={g.sshPortDesc}
        title={g.sshPortTitle}
      />

      {/* Desktop: a path to a key file. Mobile has no file picker that yields a
          path russh can open, so it pastes the key instead (see below). */}
      {SSH_LOCAL_FILES_SUPPORTED ? (
        <ListRow
          action={
            <Input
              className="font-normal"
              onChange={event => set('keyPath', event.target.value)}
              placeholder="~/.ssh/id_ed25519"
              value={form.keyPath}
            />
          }
          description={g.sshKeyDesc}
          title={g.sshKeyTitle}
        />
      ) : (
        <ListRow
          action={
            <textarea
              className="h-24 w-full resize-y rounded-md border border-(--ui-border) bg-transparent px-2 py-1 font-mono text-xs"
              onChange={event => set('privateKeyPem', event.target.value)}
              placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
              value={form.privateKeyPem}
            />
          }
          description={g.sshKeyPemDesc}
          title={g.sshKeyPemTitle}
        />
      )}

      <ListRow
        action={
          <Input
            autoComplete="off"
            className="font-normal"
            onChange={event => set('passphrase', event.target.value)}
            type="password"
            value={form.passphrase}
          />
        }
        title={g.sshPassphraseTitle}
      />

      <ListRow
        action={
          <Input
            className="font-normal"
            onChange={event => set('remoteHermesPath', event.target.value)}
            placeholder={g.sshHermesPathPlaceholder}
            value={form.remoteHermesPath}
          />
        }
        description={g.sshHermesPathDesc}
        title={g.sshHermesPathTitle}
      />

      <p className="mt-2 text-xs text-(--ui-text-secondary)">{g.sshTrustHint}</p>

      {/* A cold connect spawns a process on the remote and waits for it to bind,
          which can take 45-90s. Without this the UI is a motionless spinner for
          long enough to read as a hang. */}
      {progress ? (
        <div className="mt-3 flex items-center gap-2 text-xs text-(--ui-text-secondary)">
          <Loader2 className="size-3.5 animate-spin" />
          <span>{progress}</span>
        </div>
      ) : null}

      {/* Trust-on-first-use. A CHANGED key never reaches here — it is refused
          outright in Rust, under every policy. */}
      {hostKey ? (
        <div className="mt-3 grid gap-2 rounded-md border border-(--ui-border) p-3">
          <div className="text-sm font-medium">{g.sshHostKeyTitle}</div>
          <p className="text-xs text-(--ui-text-secondary)">
            {g.sshHostKeyDesc(hostKey.host, hostKey.fingerprint)}
          </p>
          <div className="flex justify-end gap-2">
            <Button onClick={() => onTrustHostKey(false)} size="sm" variant="outline">
              {g.sshHostKeyReject}
            </Button>
            <Button onClick={() => onTrustHostKey(true)} size="sm">
              {g.sshHostKeyTrust}
            </Button>
          </div>
        </div>
      ) : null}

      {prompt ? (
        <div className="mt-3 grid gap-2 rounded-md border border-(--ui-border) p-3">
          <div className="text-sm font-medium">{g.sshPromptTitle}</div>
          <p className="text-xs text-(--ui-text-secondary)">{prompt.label}</p>
          <Input
            autoFocus
            className="font-normal"
            onChange={event => setAnswer(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter') {
                onAnswerPrompt(answer)
                setAnswer('')
              }
            }}
            type={prompt.secret ? 'password' : 'text'}
            value={answer}
          />
          <div className="flex justify-end">
            <Button
              onClick={() => {
                onAnswerPrompt(answer)
                setAnswer('')
              }}
              size="sm"
            >
              {g.sshConnect}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
