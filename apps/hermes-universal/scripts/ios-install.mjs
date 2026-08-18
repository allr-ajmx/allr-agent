#!/usr/bin/env node
/**
 * Install the built iOS app on a connected device.
 *
 * `tauri ios build` produces an .ipa but stops there, and `tauri ios dev` only
 * covers the run-from-source loop — so getting a *release-shaped* build onto a
 * phone had no command at all. This is that command.
 *
 * Three decisions worth stating, because each has an obvious-looking alternative:
 *
 *   - **The .ipa under `gen/apple/build/`, not the .app in DerivedData.** Both are
 *     produced by the same build, but DerivedData lives at a path with a hash in
 *     it (`hermes-universal-auexyynrmjfoyqawwsdqfbxhwijr`) that changes whenever
 *     Xcode decides it should. The .ipa path is inside the repo and stable.
 *
 *   - **`xcrun devicectl`, not `ios-deploy`.** devicectl ships with Xcode 15+,
 *     so there is no extra dependency for anyone who can already build the app.
 *     ios-deploy is a third-party tool that has to be installed separately and
 *     no longer keeps pace with new device/OS pairs.
 *
 *   - **A script, not a one-liner in package.json.** The bundle is called
 *     `Hermes (MJX).ipa` — spaces and parentheses — and it has to survive being
 *     passed through npm to a shell. Doing this with `execFileSync` and an
 *     argument array sidesteps the quoting entirely. The device also has to be
 *     looked up, which is not a one-liner in any case.
 *
 * For the simulator, use `npm run dev:ios` — installing an .ipa there does not
 * work anyway (a device build is signed and compiled for arm64 hardware).
 *
 * Usage:
 *   node scripts/ios-install.mjs                     # newest build → the one connected device
 *   node scripts/ios-install.mjs --device "iPhone"   # by name, UDID or identifier
 *   node scripts/ios-install.mjs --ipa path/to.ipa   # an explicit bundle
 *
 *   HERMES_IOS_DEVICE=<name|udid>  # same as --device, for a machine with several
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BUILD_DIR = join(ROOT, 'src-tauri/gen/apple/build')

class Failure extends Error {}

/** Read `--flag value` pairs; everything here is optional. */
function parseArgs(argv) {
  const args = {}

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]

    if (flag === '--help' || flag === '-h') {
      args.help = true
    } else if (flag === '--device' || flag === '--ipa') {
      const value = argv[i + 1]

      if (!value || value.startsWith('--')) {
        throw new Failure(`${flag} needs a value`)
      }

      args[flag.slice(2)] = value
      i += 1
    } else {
      throw new Failure(`unknown argument: ${flag}`)
    }
  }

  return args
}

/**
 * The most recently built .ipa.
 *
 * Newest rather than first: the build directory is per-architecture and is never
 * cleaned, so an old arm64 bundle can sit next to the one just built and would
 * otherwise be installed silently in its place.
 */
function findIpa(explicit) {
  if (explicit) {
    const path = resolve(explicit)

    if (!existsSync(path)) {
      throw new Failure(`no such file: ${path}`)
    }

    return path
  }

  if (!existsSync(BUILD_DIR)) {
    throw new Failure('nothing has been built yet — run `npm run ios:build:debug` first')
  }

  const found = readdirSync(BUILD_DIR, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .flatMap(entry => {
      const dir = join(BUILD_DIR, entry.name)

      return readdirSync(dir)
        .filter(name => name.endsWith('.ipa'))
        .map(name => join(dir, name))
    })
    .map(path => ({ path, mtime: statSync(path).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)

  if (found.length === 0) {
    throw new Failure('no .ipa under gen/apple/build — run `npm run ios:build:debug` first')
  }

  return found[0].path
}

/** Every device Xcode currently knows about. */
function listDevices() {
  const dir = mkdtempSync(join(tmpdir(), 'hermes-ios-'))
  const out = join(dir, 'devices.json')

  try {
    // devicectl only emits JSON to a file, never to stdout.
    execFileSync('xcrun', ['devicectl', 'list', 'devices', '--json-output', out], { stdio: 'pipe' })

    return (JSON.parse(readFileSync(out, 'utf8')).result?.devices ?? []).map(device => ({
      identifier: device.identifier,
      name: device.deviceProperties?.name ?? '(unnamed)',
      udid: device.hardwareProperties?.udid,
      platform: device.hardwareProperties?.platform,
      paired: device.connectionProperties?.pairingState === 'paired',
      connected: device.connectionProperties?.tunnelState === 'connected'
    }))
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Failure(`could not read the device list: ${error.message}`)
    }

    throw new Failure('could not list devices. Is Xcode installed and are its command line tools selected?')
  } finally {
    rmSync(dir, { force: true, recursive: true })
  }
}

function pickDevice(wanted) {
  const devices = listDevices().filter(device => device.platform === 'iOS')

  if (wanted) {
    const match = devices.find(
      device => device.name === wanted || device.udid === wanted || device.identifier === wanted
    )

    if (!match) {
      const known = devices.map(device => `  ${device.name} (${device.udid})`).join('\n')

      throw new Failure(`no iOS device matching ${JSON.stringify(wanted)}.${known ? `\nKnown:\n${known}` : ''}`)
    }

    return match
  }

  const usable = devices.filter(device => device.paired)

  if (usable.length === 0) {
    throw new Failure('no paired iOS device. Connect one, unlock it, and trust this computer when prompted.')
  }

  // A device that is merely paired may be asleep or off the network; prefer one
  // with a live tunnel so the common case does not sit waiting for a timeout.
  const connected = usable.filter(device => device.connected)
  const candidates = connected.length > 0 ? connected : usable

  if (candidates.length > 1) {
    const list = candidates.map(device => `  ${device.name} (${device.udid})`).join('\n')

    throw new Failure(`more than one device is available — pass --device.\n${list}`)
  }

  return candidates[0]
}

const USAGE = `Install the built iOS app on a connected device.

  node scripts/ios-install.mjs                     newest build -> the one connected device
  node scripts/ios-install.mjs --device "iPhone"   by name, UDID or identifier
  node scripts/ios-install.mjs --ipa path/to.ipa   an explicit bundle

  HERMES_IOS_DEVICE=<name|udid>                    same as --device

Build first with: npm run ios:build:debug`

function main() {
  const args = parseArgs(process.argv.slice(2))

  if (args.help) {
    console.log(USAGE)

    return
  }

  const ipa = findIpa(args.ipa)
  const device = pickDevice(args.device ?? process.env.HERMES_IOS_DEVICE)

  if (!device.connected) {
    console.warn(`ios-install: ${device.name} is paired but not connected; this may take a moment`)
  }

  console.log(`ios-install: installing ${ipa} → ${device.name} (${device.udid})`)

  // Inherit stdio: devicectl reports its own progress and, on a signing or
  // provisioning failure, an explanation far better than anything reproducible
  // from an exit code.
  execFileSync('xcrun', ['devicectl', 'device', 'install', 'app', '--device', device.identifier, ipa], {
    stdio: 'inherit'
  })
}

try {
  main()
} catch (error) {
  console.error(`ios-install: ${error.message}`)
  process.exitCode = 1
}
