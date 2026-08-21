import { $connection, connectLocal, connectSsh } from '@/store/connection'
import { loadGatewayTarget } from '@/store/gateway-restore'
import { $gatewayMode } from '@/store/gateway-switch'
import { notify } from '@/store/notifications'

/**
 * What happens to the LIVE CHAT when the app's profile changes — said out loud.
 *
 * Switching profile (`store/profiles` `setActiveProfile`) re-scopes every
 * profile-scoped REST call: config, skills, tools, model, the session list. NEW
 * chats follow too — `session.create` / `session.resume` carry `profile` per
 * request (store/chat `ensureSession`, store/session). What does NOT move is a
 * chat that is already open: its session was built against the profile it
 * started in, and the socket itself has no profile to switch.
 *
 * So the honest answer depends on who owns the backend:
 *
 *  * **local / ssh** — the backend is one we started, so it CAN be re-homed
 *    wholesale (MCP discovery is still per launch profile), by respawning it as
 *    the new profile. Offered, not done silently: a respawn drops the socket and
 *    every running turn with it.
 *  * **remote / cloud** — the gateway is somebody else's process. New chats land
 *    on the profile; the open one stays put, so say that instead of implying it
 *    followed.
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
    message: `Settings, skills and new chats now use ${name}. The open chat keeps the profile it was started in.`
  })
}
