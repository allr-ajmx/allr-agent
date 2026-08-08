// Ported from desktop `app/chat/sidebar/session-row-state.ts`. Desktop also has
// a `background` state (a terminal process alive while the LLM is idle), driven
// by `$backgroundRunningSessionIds`; universal has no equivalent tracking yet
// (`store/composer-status.ts` only holds `$statusItemsBySession`), so that state
// is left out rather than faked.
export type SessionDotState = 'idle' | 'needs-input' | 'stalled' | 'unread' | 'working'

interface SessionRowState {
  isStalled: boolean
  isUnread: boolean
  isWorking: boolean
  needsInput: boolean
}

/** Resolve the sidebar dot's mutually-exclusive display state by priority. */
export function sessionDotState({ isStalled, isUnread, isWorking, needsInput }: SessionRowState): SessionDotState {
  if (needsInput) {
    return 'needs-input'
  }

  if (isWorking) {
    return isStalled ? 'stalled' : 'working'
  }

  return isUnread ? 'unread' : 'idle'
}

/** A quiet turn is still authoritatively running. Keep the unmistakable row
 * arc until the gateway reports completion; only a blocking prompt suppresses
 * it in favour of the needs-input treatment. */
export function sessionShowsRunningArc({
  isWorking,
  needsInput
}: Pick<SessionRowState, 'isWorking' | 'needsInput'>): boolean {
  return isWorking && !needsInput
}
