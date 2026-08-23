/** `@tauri-apps/plugin-fs`, stubbed for the browser. Reads come back empty
 *  rather than throwing, so a caller that renders file contents renders nothing
 *  instead of crashing the story. */

export function readFile(path: string): Promise<Uint8Array> {
  console.debug('[storybook] fs.readFile', path)

  return Promise.resolve(new Uint8Array())
}

export function readTextFile(path: string): Promise<string> {
  console.debug('[storybook] fs.readTextFile', path)

  return Promise.resolve('')
}

export function writeTextFile(path: string, contents: string): Promise<void> {
  console.debug('[storybook] fs.writeTextFile', path, contents.length)

  return Promise.resolve()
}

export function exists(): Promise<boolean> {
  return Promise.resolve(false)
}
