// Remove Kotlin codegen trees left behind by an older app identifier.
//
// gen/android/**/generated is gitignored, so switching identifiers/branches leaves the old
// package tree in place. It fails to compile, and it also stops tauri's build.rs from
// re-emitting TauriActivity.kt into the new package (its rerun-if-changed points at the old
// path, which still exists). Deleting the stale tree fixes both.
import { readdirSync, readFileSync, rmSync } from 'node:fs'
import { basename, sep } from 'node:path'

const root = new URL('../src-tauri/', import.meta.url)
const { identifier } = JSON.parse(readFileSync(new URL('tauri.conf.json', root), 'utf8'))
const keep = `${identifier.replaceAll('.', '/').replaceAll('-', '_')}/generated`
const java = new URL('gen/android/app/src/main/java/', root)

let entries = []
try {
  entries = readdirSync(java, { recursive: true })
} catch {
  process.exit(0) // android project not initialised yet
}
for (const entry of entries) {
  const rel = entry.split(sep).join('/')
  if (basename(rel) !== 'generated' || rel === keep) continue
  rmSync(new URL(rel, java), { recursive: true, force: true })
  console.log(`[android:prune] removed stale codegen tree ${rel}`)
}
