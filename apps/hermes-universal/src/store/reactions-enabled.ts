/**
 * Message reactions (iMessage-style tapbacks) — opt-in.
 *
 * Off by default: reactions add affordances to every message row (the ☺ slot,
 * the picker, `:shortcode:` completions in the composer), and the agent gains a
 * tool that reacts to your messages. Presentation-scoped, so the renderer owns
 * it.
 *
 * Gates the UI only — reactions that already exist still render if the data is
 * there. One you set before turning the feature off should not vanish.
 */

import { persistentAtom } from '@/lib/persisted'
import { requestGateway } from '@/store/gateway'

export const $reactionsEnabled = persistentAtom<boolean>('hermes.reactions.v1', false, {
  decode: raw => raw === 'on',
  encode: value => (value ? 'on' : 'off')
})

export function setReactionsEnabled(enabled: boolean): void {
  $reactionsEnabled.set(enabled)
}

if (typeof window !== 'undefined') {
  // listen, not subscribe: fire on CHANGE only, so app startup doesn't write
  // config.set (or clobber a profile's setting with another window's default).
  $reactionsEnabled.listen(enabled => {
    // Mirror into gateway config: the backend gates the agent's
    // `react_to_message` tool and the model-context annotation on
    // `display.message_reactions`, so this toggle is the one lever.
    void requestGateway('config.set', {
      key: 'display.message_reactions',
      value: enabled ? 'true' : 'false'
    }).catch(() => {
      // Not connected yet — the next toggle (or default-off) still holds.
    })
  })
}
