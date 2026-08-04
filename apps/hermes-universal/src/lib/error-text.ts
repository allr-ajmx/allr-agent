/**
 * Turn an unknown thrown value into something worth showing a person.
 *
 * `err instanceof Error ? err.message : String(err)` is the reflex, and it is
 * wrong at every boundary Rust is on the other side of. A rejected Tauri
 * `invoke` does not reject with an `Error` — it rejects with whatever the
 * command's error type serialised to, and ours serialise to objects
 * (`SshError` is `{ kind, message }`). `String({...})` is `"[object Object]"`,
 * so the one place a real diagnosis was available rendered as the least
 * informative string in JavaScript.
 *
 * Order matters: `message` is checked before falling back to stringifying,
 * because that is the field every error shape in this app actually carries.
 */
export function errorText(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  if (typeof error === 'string') {
    return error
  }

  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message

    if (typeof message === 'string' && message) {
      return message
    }

    // Not one of ours. JSON beats "[object Object]" — a bug report can act on
    // it — but a value that cannot be encoded (a cycle, a BigInt) must not take
    // the error path down with it.
    try {
      return JSON.stringify(error)
    } catch {
      return String(error)
    }
  }

  return String(error)
}
