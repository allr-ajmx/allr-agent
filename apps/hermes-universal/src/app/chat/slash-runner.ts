/**
 * The primary chat's slash dispatcher, reachable from outside React.
 *
 * `useSlashCommand` is a hook: it closes over the i18n copy, the skin command,
 * and — since MJXHRM-357 — the SESSION VIEW it was mounted under, which is what
 * makes a tile's `/compress` compress the tile. That binding is the reason it
 * cannot simply be called as a function from module code, and the reason this
 * registry holds exactly one runner: the PRIMARY composer's. A tile's runner
 * would act on the tile, and a caller out here has no way to mean that.
 *
 * The one caller is Quick Entry (`app/quick-entry/bridge.ts`), whose captured
 * text is submitted through this window's normal prompt machinery. Without this
 * it reached `sendPrompt` directly, so a `/`-command typed into the capture
 * window was delivered to the agent as prose — desktop's bridge routes the same
 * text through its slash-aware `submitText`, so this was a port gap, not a
 * design difference.
 *
 * Registration is per WINDOW (module state), so a tile window registering its
 * own primary composer cannot be reached from the main window, and the bridge —
 * which refuses to install anywhere but the primary window — can only ever find
 * its own. Null whenever no chat composer is mounted (the user is on Settings, a
 * full-screen overlay, …); callers must handle that rather than assume.
 */

export type SlashCommandRunner = (command: string) => Promise<void>

let runner: null | SlashCommandRunner = null

/** Publish (or, with null, retract) the primary composer's dispatcher. */
export function setPrimarySlashRunner(next: null | SlashCommandRunner): void {
  runner = next
}

export function primarySlashRunner(): null | SlashCommandRunner {
  return runner
}
