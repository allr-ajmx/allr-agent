import { useEffect } from 'react'

import { useHermesConfigRecord } from '@/app/hooks/use-config-record'

import { setTerminalFontFamilyFromConfig, terminalFontFamilyFromConfig } from './terminal-font'

/**
 * Push `terminal.font_family` into `$terminalFontFamily` from the SHARED
 * config-record query — universal's counterpart to desktop's side-effecting
 * `use-hermes-config.ts:112`.
 *
 * The shared cache is what makes the setting live: the Settings picker writes
 * through it, a profile switch invalidates it, opening any settings surface
 * revalidates it — and every one of those lands here, so a `config.yaml` value no
 * longer waits for the terminal pane to be torn down and rebuilt before it is
 * seen. Cross-WebView delivery (a detached tile window, the Android Settings
 * activity) is the other half, and lives in `./terminal-font-sync`.
 *
 * Its own module rather than an inline effect in `terminal-view.tsx` so this hop
 * — the whole point of the setting — is reachable without standing up an xterm.
 */
export function useTerminalFontFromConfig(): void {
  const { data: config } = useHermesConfigRecord()

  useEffect(() => {
    // `undefined` is "not fetched yet", not "unset": adopting it would blank a
    // font the picker or a peer WebView has already pushed in.
    if (config) {
      setTerminalFontFamilyFromConfig(terminalFontFamilyFromConfig(config))
    }
  }, [config])
}
