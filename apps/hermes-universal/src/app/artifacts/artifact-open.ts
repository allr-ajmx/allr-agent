import { isFileMediaPath } from '@/lib/media-format'

/**
 * WHAT ACTIVATING AN ARTIFACT MEANS — the decision half, on its own (rule 35).
 *
 * The view around this is a webview problem: a save dialog, a Rust transport, a
 * tray row, an external browser. The QUESTION it has to answer first is none of
 * those — it is "is this bytes on the gateway's disk, or is it somebody else's
 * URL?" — and that answer is a pure function of the record. Split out so the
 * invariant below can be pinned without rendering anything.
 *
 * The invariant: a gateway-local artifact must NEVER take the external branch.
 * `artifact.href` for such a record is the raw `/api/files/download?path=…` URL,
 * and nothing outside the Rust transport can authenticate it — handing it to
 * the OS browser behind a gated gateway comes back 401, which is what "clicking
 * it does nothing" looks like from the outside.
 */
export type ArtifactOpenAction = { href: string; kind: 'external' } | { kind: 'download'; path: string }

/** Both fields, not just `href`: `value` is what decides, `href` is only ever
 *  used by the branch that does not own the bytes. */
export function artifactOpenAction(artifact: { href: string; value: string }): ArtifactOpenAction {
  if (isFileMediaPath(artifact.value)) {
    return { kind: 'download', path: artifact.value }
  }

  return { href: artifact.href, kind: 'external' }
}
