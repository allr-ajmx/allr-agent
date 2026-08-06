#!/usr/bin/env node
// build-sample-plugins.mjs — compile packages/hermes-sample-plugins/* to the
// standalone `plugin.js` artifacts the disk door loads.
//
//   node scripts/build-sample-plugins.mjs [--out <dir>] [--profile <name>]
//
// Default output is `$HERMES_HOME/desktop-plugins/<name>/plugin.js` (HERMES_HOME
// defaults to ~/.hermes), which is where the runtime loader watches.
//
// Why this exists alongside the vite glob that already bundles these: a bundled
// plugin is compiled with the app and never touches the runtime pipeline —
// specifier rewrite -> SDK/react shim blobs -> blob: import under the app CSP ->
// React singleton. Only an artifact through the disk door exercises any of it,
// and that pipeline is what a third-party plugin actually goes through. The two
// paths are not redundant: bundling gives typechecking, the artifact is the
// honest test of the published contract.
import { build } from 'esbuild'
import { copyFile, mkdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const samples = join(root, 'packages/hermes-sample-plugins')

// EXACTLY the specifiers `sdkImportMap()` rewrites (src/sdk/runtime.ts). The
// loader rejects any other bare import up front, so anything else left external
// would produce an artifact that cannot load — better to fail the bundle.
const EXTERNAL = ['@hermes/plugin-sdk', 'react', 'react/jsx-runtime', 'react/jsx-dev-runtime']

/**
 * Inline `import './x.css'` as a style-injecting module.
 *
 * esbuild would otherwise emit a sibling .css file, and the disk door loads one
 * file per plugin. Keyed by `<plugin>/<file>` rather than the absolute path so
 * the artifact is reproducible and doesn't carry the build machine's home
 * directory — and so a hot reload REPLACES its own <style> instead of stacking
 * a new one on every poll.
 */
const cssAsStyleTag = {
  name: 'css-as-style-tag',
  setup(pluginBuild) {
    pluginBuild.onLoad({ filter: /\.css$/ }, async file => {
      const key = file.path.slice(samples.length + 1)
      const css = await readFile(file.path, 'utf8')

      return {
        loader: 'js',
        contents: `
const KEY = ${JSON.stringify(`hermes-plugin-style:${key}`)}
const el = document.querySelector(\`style[data-plugin-style="\${KEY}"]\`) ?? document.createElement('style')
el.dataset.pluginStyle = KEY
el.textContent = ${JSON.stringify(css)}
if (!el.isConnected) document.head.append(el)
`
      }
    })
  }
}

function flag(name, fallback) {
  const at = process.argv.indexOf(`--${name}`)

  return at === -1 ? fallback : process.argv[at + 1]
}

// Mirrors plugin_root_under() in src-tauri/src/plugins.rs: the default profile
// sits at the home root, a named one under profiles/<name>/.
function outRoot() {
  const explicit = flag('out')

  if (explicit) {
    return resolve(explicit)
  }

  const home = process.env.HERMES_HOME || join(homedir(), '.hermes')
  const profile = flag('profile')

  return join(profile ? join(home, 'profiles', profile) : home, 'desktop-plugins')
}

const out = outRoot()

// Each sample is either a compiled entry or, for hello-runtime, already exactly
// what the door wants — plain ESM with jsx() calls, hand-written to show what an
// agent (or a compiler) writes. Compiling it would defeat its purpose.
const SAMPLES = [
  { entry: 'example/plugin.tsx', name: 'example' },
  { entry: 'gateway-pill/plugin.tsx', name: 'gateway-pill' },
  { copy: 'hello-runtime/plugin.runtime.js', name: 'hello-runtime' },
  { entry: 'kanban/plugin.tsx', name: 'kanban' }
]

for (const sample of SAMPLES) {
  const target = join(out, sample.name, 'plugin.js')
  await mkdir(dirname(target), { recursive: true })

  if (sample.copy) {
    await copyFile(join(samples, sample.copy), target)
  } else {
    await build({
      bundle: true,
      entryPoints: [join(samples, sample.entry)],
      external: EXTERNAL,
      format: 'esm',
      jsx: 'automatic',
      // Left unminified on purpose: this is the file a plugin author reads to
      // see what the compiler produced, and what shows up in a stack trace.
      outfile: target,
      platform: 'browser',
      plugins: [cssAsStyleTag],
      target: 'es2022'
    })
  }

  console.log(`  ${sample.name} -> ${target}`)
}

console.log(`\n${SAMPLES.length} plugins built into ${out}`)
