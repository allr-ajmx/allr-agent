#!/usr/bin/env node
/**
 * iOS app-icon sync — the one branding path Tauri does not close for us.
 *
 * `tauri icon` regenerates every platform's icons from `src-tauri/app-icon.png`,
 * but it does not treat the two mobile platforms the same way:
 *
 *   - Android: it writes the mipmaps DIRECTLY into the
 *     `src-tauri/gen/android/app/src/main/res/mipmap-<density>` dirs. That tree
 *     is tracked, so a rebrand lands in the same commit as everything else and
 *     ships.
 *   - iOS: it writes ONLY `src-tauri/icons/ios/*.png`. Those files reach the
 *     Xcode asset catalog exactly once, when `tauri ios init` copies them into
 *     `gen/apple/Assets.xcassets/AppIcon.appiconset/`. `tauri ios build` re-runs
 *     xcodegen on every build but never re-copies them.
 *
 * So after any `tauri icon` run the iOS catalog keeps compiling the icons from
 * whenever `ios init` last ran. That is exactly how the Aug-15 "Hermes (MJX)"
 * rebrand shipped an iOS build still wearing the default Tauri logo from Aug 3:
 * every build was green, the Xcode wiring was correct
 * (`ASSETCATALOG_COMPILER_APPICON_NAME = AppIcon`, `Assets.xcassets` in the
 * Resources phase), and it faithfully compiled the wrong art.
 *
 * This script re-copies them, and is wired into the `ios:*` npm scripts so the
 * gap cannot reopen silently.
 *
 * It also strips the alpha channel. `tauri icon` composites the iOS set onto the
 * `bg_color` from `src-tauri/app-icon.json` (`#fff`) but still emits RGBA, so the
 * icons are visually opaque while carrying a channel App Store Connect rejects
 * outright (ITMS-90717 "Invalid App Store Icon"). The pre-rebrand icons happened
 * to be RGB, so nothing has hit this yet — flattening here means nothing will.
 *
 * Usage:
 *   node scripts/sync-ios-icons.mjs           # sync (idempotent)
 *   node scripts/sync-ios-icons.mjs --check   # report drift, exit 1, write nothing
 */

import { Buffer } from 'node:buffer'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync, inflateSync } from 'node:zlib'

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE_DIR = join(APP_DIR, 'src-tauri', 'icons', 'ios')
const GEN_APPLE_DIR = join(APP_DIR, 'src-tauri', 'gen', 'apple')
const APPICONSET_DIR = join(GEN_APPLE_DIR, 'Assets.xcassets', 'AppIcon.appiconset')

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const COLOR_TYPE_RGB = 2
const COLOR_TYPE_RGBA = 6

// ---------------------------------------------------------------------------
// PNG re-encoding
//
// Deliberately dependency-free: this runs on every `npm run dev:ios`, and a
// native image dependency (sharp) or a brew prerequisite (ImageMagick) is a
// heavier tax than ~100 lines against node's built-in zlib. The inputs are all
// `tauri icon` output — 8-bit non-interlaced RGBA — so the parser asserts that
// shape rather than growing into a general PNG decoder.
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** Split a PNG into its chunks. Returns `{ type, data }` in file order. */
function readChunks(png, label) {
  if (!png.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error(`${label}: not a PNG (bad signature)`)
  }
  const chunks = []
  let offset = 8
  while (offset < png.length) {
    if (offset + 8 > png.length) throw new Error(`${label}: truncated chunk header`)
    const length = png.readUInt32BE(offset)
    const type = png.toString('ascii', offset + 4, offset + 8)
    const start = offset + 8
    const end = start + length
    if (end + 4 > png.length) throw new Error(`${label}: truncated ${type} chunk`)
    chunks.push({ type, data: png.subarray(start, end) })
    offset = end + 4 // skip the chunk's CRC
    if (type === 'IEND') break
  }
  return chunks
}

function encodeChunk(type, data) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, crc])
}

/** Reverse the per-scanline filters (PNG spec §9.2) in place, returning raw rows. */
function unfilter(raw, width, height, bytesPerPixel) {
  const stride = width * bytesPerPixel
  const out = Buffer.alloc(height * stride)
  let pos = 0
  for (let y = 0; y < height; y += 1) {
    const filter = raw[pos]
    pos += 1
    const rowStart = y * stride
    const prevStart = rowStart - stride
    for (let x = 0; x < stride; x += 1) {
      const value = raw[pos + x]
      const a = x >= bytesPerPixel ? out[rowStart + x - bytesPerPixel] : 0
      const b = y > 0 ? out[prevStart + x] : 0
      const c = y > 0 && x >= bytesPerPixel ? out[prevStart + x - bytesPerPixel] : 0
      let recon
      switch (filter) {
        case 0:
          recon = value
          break
        case 1:
          recon = value + a
          break
        case 2:
          recon = value + b
          break
        case 3:
          recon = value + ((a + b) >> 1)
          break
        case 4: {
          // Paeth predictor
          const p = a + b - c
          const pa = Math.abs(p - a)
          const pb = Math.abs(p - b)
          const pc = Math.abs(p - c)
          recon = value + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)
          break
        }
        default:
          throw new Error(`unsupported PNG filter type ${filter} on row ${y}`)
      }
      out[rowStart + x] = recon & 0xff
    }
    pos += stride
  }
  return out
}

/**
 * Composite an 8-bit RGBA PNG onto white and re-emit it as 8-bit RGB.
 *
 * Returns the input untouched when it is already RGB — that keeps the sync
 * idempotent against its own output and against a future `tauri icon` that
 * flattens for us.
 */
function flattenOntoWhite(png, label) {
  const chunks = readChunks(png, label)
  const ihdr = chunks.find(chunk => chunk.type === 'IHDR')
  if (!ihdr) throw new Error(`${label}: missing IHDR`)

  const width = ihdr.data.readUInt32BE(0)
  const height = ihdr.data.readUInt32BE(4)
  const bitDepth = ihdr.data[8]
  const colorType = ihdr.data[9]
  const interlace = ihdr.data[12]

  if (colorType === COLOR_TYPE_RGB && bitDepth === 8) return png
  if (colorType !== COLOR_TYPE_RGBA || bitDepth !== 8 || interlace !== 0) {
    throw new Error(
      `${label}: expected an 8-bit non-interlaced RGBA or RGB PNG (what \`tauri icon\` emits), ` +
        `got bitDepth=${bitDepth} colorType=${colorType} interlace=${interlace}`
    )
  }

  const idat = Buffer.concat(chunks.filter(chunk => chunk.type === 'IDAT').map(chunk => chunk.data))
  const rgba = unfilter(inflateSync(idat), width, height, 4)

  // Filter type 0 on every row: these are 1024px-max icons, so the extra bytes
  // are irrelevant next to keeping the encoder obvious.
  const rgbStride = width * 3
  const filtered = Buffer.alloc(height * (rgbStride + 1))
  for (let y = 0; y < height; y += 1) {
    const src = y * width * 4
    const dst = y * (rgbStride + 1)
    filtered[dst] = 0
    for (let x = 0; x < width; x += 1) {
      const alpha = rgba[src + x * 4 + 3] / 255
      for (let channel = 0; channel < 3; channel += 1) {
        const value = rgba[src + x * 4 + channel]
        filtered[dst + 1 + x * 3 + channel] = Math.round(value * alpha + 255 * (1 - alpha))
      }
    }
  }

  const newIhdr = Buffer.from(ihdr.data)
  newIhdr[9] = COLOR_TYPE_RGB

  // Only IHDR/IDAT/IEND survive: dropping the ancillary chunks (tRNS, sRGB,
  // iCCP, text) guarantees no transparency information is left behind for
  // App Store validation to find.
  return Buffer.concat([
    PNG_SIGNATURE,
    encodeChunk('IHDR', newIhdr),
    encodeChunk('IDAT', deflateSync(filtered, { level: 9 })),
    encodeChunk('IEND', Buffer.alloc(0))
  ])
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

/**
 * The catalog's own `Contents.json` is the list of files to sync — never a
 * hardcoded one. A Tauri upgrade that adds entries (iOS 18 dark/tinted
 * appearances, say) is then picked up without touching this script.
 */
function requiredFilenames() {
  const contentsPath = join(APPICONSET_DIR, 'Contents.json')
  if (!existsSync(contentsPath)) {
    throw new Error(`${contentsPath} not found — the asset catalog looks incomplete. Re-run \`npm run ios:init\`.`)
  }
  const contents = JSON.parse(readFileSync(contentsPath, 'utf8'))
  const filenames = (contents.images ?? []).map(image => image.filename).filter(Boolean)
  return [...new Set(filenames)]
}

function main() {
  const check = process.argv.includes('--check')

  // `dev:ios` runs this before Tauri gets a chance to initialize the project on
  // a fresh clone, so an uninitialized tree is a notice, not a failure.
  if (!existsSync(GEN_APPLE_DIR)) {
    console.log('sync-ios-icons: src-tauri/gen/apple does not exist yet — nothing to sync.')
    return
  }

  if (!existsSync(SOURCE_DIR)) {
    throw new Error(`${SOURCE_DIR} not found — run \`npx tauri icon\` to generate the iOS icons.`)
  }

  const filenames = requiredFilenames()
  const updated = []
  let unchanged = 0

  for (const filename of filenames) {
    const sourcePath = join(SOURCE_DIR, filename)
    if (!existsSync(sourcePath)) {
      throw new Error(
        `${filename} is listed in the asset catalog but missing from src-tauri/icons/ios — ` +
          'run `npx tauri icon` to regenerate the iOS icons.'
      )
    }
    const flattened = flattenOntoWhite(readFileSync(sourcePath), `icons/ios/${filename}`)
    const destPath = join(APPICONSET_DIR, filename)
    if (existsSync(destPath) && readFileSync(destPath).equals(flattened)) {
      unchanged += 1
      continue
    }
    updated.push(filename)
    if (!check) writeFileSync(destPath, flattened)
  }

  // A file in the catalog that no Contents.json entry references is dead weight
  // Xcode ignores; flag it rather than deleting someone's deliberate addition.
  const stale = readdirSync(APPICONSET_DIR).filter(entry => entry.endsWith('.png') && !filenames.includes(entry))
  for (const entry of stale) {
    console.warn(`sync-ios-icons: ${entry} is not referenced by Contents.json — safe to delete.`)
  }

  if (check) {
    if (updated.length > 0) {
      console.error(
        `sync-ios-icons: ${updated.length} icon(s) out of sync with src-tauri/icons/ios:\n` +
          updated.map(name => `  - ${name}`).join('\n') +
          '\nRun `npm run ios:icons` and commit the result.'
      )
      process.exitCode = 1
      return
    }
    console.log(`sync-ios-icons: up to date (${unchanged} icons).`)
    return
  }

  console.log(`sync-ios-icons: ${updated.length} updated, ${unchanged} unchanged.`)
}

try {
  main()
} catch (error) {
  console.error(`sync-ios-icons: ${error.message}`)
  process.exitCode = 1
}
