/** `@tauri-apps/plugin-notification`, stubbed for the browser. Permission is
 *  reported as denied so nothing tries to post an OS notification from a story. */

export function isPermissionGranted(): Promise<boolean> {
  return Promise.resolve(false)
}

export function requestPermission(): Promise<string> {
  return Promise.resolve('denied')
}

export function sendNotification(options: unknown): void {
  console.debug('[storybook] sendNotification', options)
}
