package work.allr.plugin.mic

import android.app.Activity
import app.tauri.annotation.Permission
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Plugin

/**
 * Android side of tauri-plugin-mic.
 *
 * There is no custom logic here: Tauri's base [Plugin] class already implements
 * `checkPermissions` / `requestPermissions` driven entirely by the
 * `@TauriPlugin(permissions = [...])` annotation below. Declaring RECORD_AUDIO as
 * the `microphone` alias is all that's needed for `getPermissionStates()` and the
 * runtime request dialog to cover the mic.
 *
 * MODIFY_AUDIO_SETTINGS is intentionally NOT listed here — it is an install-time
 * permission with no runtime dialog, so it only needs the manifest declaration
 * (see AndroidManifest.xml).
 */
@TauriPlugin(
    permissions = [
        Permission(strings = ["android.permission.RECORD_AUDIO"], alias = "microphone")
    ]
)
class MicPlugin(activity: Activity) : Plugin(activity)
