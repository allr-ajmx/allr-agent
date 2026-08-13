import { $connection, connectLocal, connectSsh } from '@/store/connection'
import { loadGatewayTarget } from '@/store/gateway-restore'
import { $gatewayMode } from '@/store/gateway-switch'
import { notify } from '@/store/notifications'

/**
 * What happens to the LIVE CHAT when the app's profile changes — said out loud.
 *
 * Switching profile (`store/profiles` `setActiveProfile`) re-scopes every
 * profile-scoped REST call: config, skills, tools, model, the session list. It
 * does NOT re-scope the chat. `requestGateway` — `session.create`,
 * `prompt.submit` — rides one WebSocket that was opened as one profile, and
 * there is no per-request profile on it.
 *
 * So the honest answer depends on who owns the backend:
 *
 *  * **local / ssh** — the backend is one we started, so it CAN be re-homed, by
 *    respawning it as the new profile. Offered, not done silently: a respawn
 *    drops the socket and every running turn with it.
 *  * **remote / cloud** — the gateway is somebody else's process running its own
 *    profile. Nothing the client does moves it, so say that instead of implying
 *    the chat followed.
 *
 * Extracted from `app/gateway/profile-selector.tsx`, which was the only place
 * that knew this (MJXHRM-389). The wake-phrase router needs the identical
 * answer, and a second copy of it is a second chance to tell the user the chat
 * moved when it did not.
 */
export function announceProfileChatScope(target: null | string): void {
  if (!$connection.get()) {
    // Nothing is connected: there is no live chat to be wrong about, and the
    // next connection opens under the profile just selected.
    return
  }

  const mode = $gatewayMode.get()
  const name = target ? `"${target}"` : 'the default profile'

  // ssh behaves like local here: the backend is one we started, so a profile
  // change genuinely needs a respawn rather than a REST re-scope.
  if (mode === 'local' || mode === 'ssh') {
    const restart =
      mode === 'ssh'
        ? () => {
            const saved = loadGatewayTarget()

            if (saved?.ssh) {
              void connectSsh({ ...saved.ssh, profile: target }, { interactive: true })
            }
          }
        : () => void connectLocal(target)

    notify({
      kind: 'info',
      message: `Restart the backend as ${name} to apply it to chat?`,
      action: { label: 'Restart', onClick: restart }
    })

    return
  }

  notify({
    kind: 'info',
    message: `Settings and skills now use ${name}. The live chat still runs the gateway's own profile.`
  })
}
