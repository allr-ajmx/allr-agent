/**
 * `@tauri-apps/plugin-haptics`, stubbed for the browser.
 *
 * Only reached when a `HapticsProvider` registered the Tauri trigger — the
 * Storybook preview does not mount one, so `triggerHaptic` is already a no-op
 * (`src/lib/haptics.ts`). This exists so the IMPORT resolves.
 */

export type ImpactFeedbackStyle = 'heavy' | 'light' | 'medium' | 'rigid' | 'soft'

export function impactFeedback(style: ImpactFeedbackStyle): Promise<void> {
  void style

  return Promise.resolve()
}

export function notificationFeedback(): Promise<void> {
  return Promise.resolve()
}

export function selectionFeedback(): Promise<void> {
  return Promise.resolve()
}

export function vibrate(duration: number): Promise<void> {
  void duration

  return Promise.resolve()
}
