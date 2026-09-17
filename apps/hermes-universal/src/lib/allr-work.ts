import { invoke } from '@tauri-apps/api/core'

import { GatewaySignInBusyError } from '@/gateway'

// Allr Work sign-in (ALLR-51): the typed JS bindings for src-tauri/src/allr_work.rs.
//
// The whole sign-in — portal hand-off, workspace validation, preflight, the RFC 8252
// token exchange, the keyring write — runs in Rust. What crosses IPC is a workspace
// base URL and a stable error kind, never a state, a code or a token. The
// orchestration (connect afterwards, the mobile resume marker, sign-out) lives in
// store/allr-work.ts; this file only speaks to Rust, plus one pure mirror of the Rust
// workspace host rule for a URL that did NOT come from Rust (a saved restore target).

/**
 * Why an Allr Work sign-in did not complete. Exactly `decide::AllrWorkErrorKind`,
 * serialised kebab-case (`allr_work_error_kinds_serialize_kebab_case` pins the Rust
 * side). A renamed variant is a silently broken error message, so this list and the
 * Rust enum move together.
 */
export type AllrWorkErrorKind =
  | 'invalid-portal-config'
  | 'cancelled'
  | 'timed-out'
  | 'navigation-refused'
  | 'already-on-sign-in-page'
  | 'portal-refused'
  | 'no-workspace'
  | 'portal-outdated'
  | 'state-mismatch'
  | 'invalid-workspace'
  | 'workspace-unsupported'
  | 'unreachable'
  | 'sign-in-failed'
  | 'credential-not-saved'
  | 'cookie-store-failed'

/** Every kind, exactly once. A `Record` over the union, so a kind missing here OR one the
 *  union does not know fails to typecheck — the list cannot drift from the type. */
const KINDS: Record<AllrWorkErrorKind, true> = {
  'invalid-portal-config': true,
  cancelled: true,
  'timed-out': true,
  'navigation-refused': true,
  'already-on-sign-in-page': true,
  'portal-refused': true,
  'no-workspace': true,
  'portal-outdated': true,
  'state-mismatch': true,
  'invalid-workspace': true,
  'workspace-unsupported': true,
  unreachable: true,
  'sign-in-failed': true,
  'credential-not-saved': true,
  'cookie-store-failed': true
}

export const ALLR_WORK_ERROR_KINDS = Object.keys(KINDS) as readonly AllrWorkErrorKind[]

/** Own keys only: `'toString' in KINDS` is true. */
function isKind(value: unknown): value is AllrWorkErrorKind {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(KINDS, value)
}

/**
 * An Allr Work failure, BRANDED at the IPC boundary.
 *
 * Rust rejects with a bare `{ kind, message }`, and that shape is not unique to this
 * module: `SshError` serialises the same way, with kinds (`cancelled`, `unreachable`) that
 * collide with these. A structural guard therefore mistook an SSH host-key decline for a
 * cancelled Allr Work sign-in. So only the wrappers below — the one place an Allr Work
 * command is invoked — turn a Rust error into this class, and {@link isAllrWorkError}
 * accepts nothing without the brand.
 */
export interface AllrWorkError {
  kind: AllrWorkErrorKind
  /** Human text. May quote the workspace host, never anything else. */
  message: string
  readonly source: 'allr-work'
}

export class AllrWorkInvokeError extends Error implements AllrWorkError {
  readonly source = 'allr-work' as const

  constructor(
    readonly kind: AllrWorkErrorKind,
    message: string
  ) {
    super(message)
    this.name = 'AllrWorkInvokeError'
  }
}

/** Brand a raw Rust rejection from an Allr Work command. Anything that is not a known
 *  `{ kind, message }` passes through untouched (an IPC failure, a JS error). */
function brand(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null || raw instanceof AllrWorkInvokeError) {
    return raw
  }

  const { kind, message } = raw as { kind?: unknown; message?: unknown }

  return isKind(kind) && typeof message === 'string'
    ? new AllrWorkInvokeError(kind, message)
    : raw
}

/** Invoke an Allr Work command, branding its rejection. */
async function invokeAllrWork<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await (args === undefined ? invoke<T>(cmd) : invoke<T>(cmd, args))
  } catch (err) {
    throw brand(err)
  }
}

/** `allr_work_config`: the portal this build signs in through, and the parent domain every
 *  workspace sits under (`https://app.allr.work` → `allr.work`). */
export interface AllrWorkConfig {
  portalUrl: string
  parentDomain: string
}

/** `allr_work_sign_in`'s reply. `busy` means another sign-in already owns the sign-in
 *  surface and this call did nothing — a normal outcome, not a failure. */
export interface AllrWorkSignIn {
  busy: boolean
  /** The workspace base (`https://<user>.<parent>`, no trailing slash) when not busy. */
  workspace: null | string
}

/** A finished MOBILE sign-in parked for the next boot (`allr_work_take_outcome`). */
export type AllrWorkOutcome =
  | { kind: 'signed-in'; workspace: string }
  | { kind: 'failed'; error: AllrWorkError; workspace: null | string }

type RawAllrWorkOutcome = { kind: 'signed-in'; workspace: string } | { kind: 'failed'; error: unknown; workspace: null | string }

/** `allr_work_clear_session`'s reply. `supported: false` means this platform could not
 *  touch the sign-in page's cookies at all — not "there was nothing to clear". */
export interface AllrWorkClearReport {
  cleared: number
  supported: boolean
}

/** Is `err` an Allr Work failure from Rust (as opposed to an IPC, JS or SSH error)? Requires
 *  the brand the wrappers add — see {@link AllrWorkError}. */
export function isAllrWorkError(err: unknown): err is AllrWorkError {
  if (typeof err !== 'object' || err === null) {
    return false
  }

  const { kind, message, source } = err as { kind?: unknown; message?: unknown; source?: unknown }

  return source === 'allr-work' && typeof message === 'string' && isKind(kind)
}

/** The user closed the sign-in window or backed out: not a failure to show anyone. */
export function isAllrWorkCancelled(err: unknown): boolean {
  return isAllrWorkError(err) && err.kind === 'cancelled'
}

export function allrWorkConfig(): Promise<AllrWorkConfig> {
  return invokeAllrWork<AllrWorkConfig>('allr_work_config')
}

/**
 * How many `allr_work_sign_in` calls THIS webview has in flight.
 *
 * `allr_work_clear_session` takes no sign-in lease in Rust, so deleting the Allr Work
 * cookies mid-flow would pull the Dex/Pomerium session out from under hop 2. The guard
 * therefore has to live on the JS side, and here — the one chokepoint every caller goes
 * through — rather than in each caller.
 *
 * It cannot see another webview's sign-in (desktop pop-outs, the Android `screen`
 * activity) or a flow Rust is still finishing after a mobile reload; Rust would have to
 * take the lease for that.
 */
let signInsInFlight = 0

export function isAllrWorkSignInInFlight(): boolean {
  return signInsInFlight > 0
}

/**
 * Run the Allr Work sign-in (both hops) in Rust.
 *
 * Desktop resolves with the workspace once the credential is in the keyring. On ANDROID
 * AND iOS the command navigates the CALLING webview away, which destroys this JS context:
 * the promise never settles here, and the next boot collects the result with
 * {@link allrWorkTakeOutcome}. A rejection on mobile therefore means the app was never left.
 *
 * `switchAccount`: this sign-in follows a Switch account. On desktop the sign-in window then
 * asks Google for its account chooser (once — the workspace hop after it stays silent); on
 * mobile Rust ignores it. Every other sign-in leaves it off.
 */
export async function allrWorkSignIn(options: { switchAccount?: boolean } = {}): Promise<AllrWorkSignIn> {
  signInsInFlight++

  try {
    return await invokeAllrWork<AllrWorkSignIn>('allr_work_sign_in', { switchAccount: options.switchAccount === true })
  } finally {
    signInsInFlight--
  }
}

/** Collect (and clear) the outcome a mobile sign-in parked before navigating back. Take-once;
 *  always `null` on desktop. A parked failure's error is branded like a rejection's; one
 *  that is not a recognisable Allr Work error is dropped (the outcome becomes `null`). */
export async function allrWorkTakeOutcome(): Promise<AllrWorkOutcome | null> {
  const raw = await invokeAllrWork<RawAllrWorkOutcome | null>('allr_work_take_outcome')

  if (!raw) {
    return null
  }

  if (raw.kind === 'signed-in') {
    return raw
  }

  const error = brand(raw.error)

  return isAllrWorkError(error) ? { kind: 'failed', error, workspace: raw.workspace ?? null } : null
}

/**
 * Forget the Allr Work browser session (the cookies the portal, Pomerium and Dex left),
 * so the next sign-in can pick a different account.
 *
 * `workspace` is the signed-in workspace base when there is one: Android cannot list its
 * cookies and only reaches the workspace's own when it is named. Rust validates it and
 * refuses an invalid one (`invalid-workspace`) without clearing anything.
 *
 * `switchAccount`: the clear is the first step of a Switch account. On Android and iOS Rust
 * then also deletes Google's sign-in cookies, so Google cannot silently sign the same account
 * back in (a phone has no way to ask for Google's account chooser). Desktop ignores it and
 * keeps the Google session. A plain sign-out leaves it off.
 *
 * Refuses — without calling Rust — while a sign-in is in flight in this webview, because
 * the command takes no lease (see {@link isAllrWorkSignInInFlight}).
 */
export async function allrWorkClearSession(
  options: { switchAccount?: boolean; workspace?: null | string } = {}
): Promise<AllrWorkClearReport> {
  if (isAllrWorkSignInInFlight()) {
    throw new GatewaySignInBusyError('An Allr Work sign-in is in progress')
  }

  return invokeAllrWork<AllrWorkClearReport>('allr_work_clear_session', {
    workspace: options.workspace ?? null,
    switchAccount: options.switchAccount === true
  })
}

// --- The workspace host rule, mirrored --------------------------------------------

/** Host labels under the parent domain that belong to the platform, never to a person.
 *  Same list as `decide::RESERVED_LABELS`. */
export const ALLR_RESERVED_LABELS: readonly string[] = ['app', 'auth', 'authenticate', 'admin', 'pgadmin']

/** Rust's `to_ascii_lowercase`: A–Z only. `String.prototype.toLowerCase` also folds non-ASCII
 *  (U+212A KELVIN SIGN → `k`), which would let a Unicode spelling match its IDNA-mapped host
 *  in the canonical comparison below — exactly what that comparison exists to reject. */
function asciiLowercase(value: string): string {
  return value.replace(/[A-Z]/g, c => c.toLowerCase())
}

/** The portal's `USERNAME_RE`, whole-string. */
const WORKSPACE_LABEL = /^[a-z0-9][a-z0-9-]{0,30}$/

/**
 * The normalised workspace base for `raw` (`https://<label>.<parent>`, no trailing slash),
 * or `null` when this app would not send a credential there.
 *
 * A pure mirror of `decide::validate_workspace` (src-tauri/src/allr_work.rs) for the one
 * URL that reaches a connect WITHOUT passing through Rust's check: the saved restore target,
 * which is only localStorage. Rust exposes no validation command to call instead.
 *
 * Exactly `https://<label>.<parent>`: https, no userinfo, no port (not even `:443`), no path,
 * query or fragment, a DNS name, no trailing dot, one label matching the username rule, not
 * reserved. A trailing `/` and uppercase are tolerated. Like Rust, the final comparison is
 * against the canonical spelling, because WHATWG parsing silently drops a default port, an
 * empty `?`, tabs and newlines, and IDNA-maps Unicode.
 */
export function allrWorkspaceBase(raw: string, parentDomain: string): null | string {
  const parent = asciiLowercase(parentDomain.trim())

  if (!parent) {
    return null
  }

  let url: URL

  try {
    url = new URL(raw)
  } catch {
    return null
  }

  if (url.protocol !== 'https:' || url.username || url.password || url.port) {
    return null
  }

  if (url.pathname !== '/' || url.search || url.hash) {
    return null
  }

  const host = url.hostname

  if (!host || host.endsWith('.')) {
    return null
  }

  const lower = asciiLowercase(raw)
  const canonical = `https://${host}`

  if (lower !== canonical && lower !== `${canonical}/`) {
    return null
  }

  const suffix = `.${parent}`

  if (!host.endsWith(suffix)) {
    return null
  }

  const label = host.slice(0, -suffix.length)

  // The label regex has no dot, so `a.b.<parent>` fails here; an IP literal can never
  // end with a DNS parent.
  if (!WORKSPACE_LABEL.test(label) || ALLR_RESERVED_LABELS.includes(label)) {
    return null
  }

  return canonical
}
