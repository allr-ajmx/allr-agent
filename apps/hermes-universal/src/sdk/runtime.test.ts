import { beforeAll, describe, expect, it, vi } from 'vitest'

// jsdom has no createObjectURL. Capture what the shims are built from so the test
// can assert on the generated module source, not just that a URL came back.
const blobs = new Map<string, string>()

beforeAll(() => {
  let n = 0

  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: (blob: Blob) => {
      const url = `blob:mock/${n++}`
      // Blob.text() is async; the sync `parts` are what we actually want, so read
      // them off the stub's own bookkeeping below instead.
      blobs.set(url, (blob as Blob & { __source?: string }).__source ?? '')

      return url
    },
    revokeObjectURL: () => {}
  })

  const RealBlob = globalThis.Blob
  vi.stubGlobal(
    'Blob',
    class extends RealBlob {
      __source: string

      constructor(parts: BlobPart[], options?: BlobPropertyBag) {
        super(parts, options)
        this.__source = parts.map(String).join('')
      }
    }
  )
})

// Imported after the stubs: sdkImportMap() builds its blobs on first call, but
// installPluginSdk/module init must not touch URL before they exist.
const { installPluginSdk, sdkImportMap } = await import('./runtime')

describe('installPluginSdk', () => {
  it('installs the SDK and the app React singletons as globals', () => {
    installPluginSdk()

    const g = globalThis as Record<string, unknown>

    expect(g.__HERMES_PLUGIN_SDK__).toBeTruthy()
    expect(g.__HERMES_REACT__).toBeTruthy()
    expect(g.__HERMES_REACT_JSX__).toBeTruthy()
    expect(g.__HERMES_REACT_JSX_DEV__).toBeTruthy()
  })

  it('exposes the real app React, not a copy', async () => {
    installPluginSdk()

    const React = await import('react')

    expect((globalThis as Record<string, unknown>).__HERMES_REACT__).toBe(React)
  })

  it('hands plugins the same `host` object the app uses', async () => {
    installPluginSdk()

    const sdk = await import('./index')
    const installed = (globalThis as Record<string, unknown>).__HERMES_PLUGIN_SDK__ as typeof sdk

    expect(installed.host).toBe(sdk.host)
  })
})

describe('sdkImportMap', () => {
  it('maps every specifier the loader rewrites, longest key first', () => {
    const map = sdkImportMap()

    expect(Object.keys(map)).toEqual([
      '@hermes/plugin-sdk',
      'react/jsx-dev-runtime',
      'react/jsx-runtime',
      'react'
    ])

    for (const url of Object.values(map)) {
      expect(url).toMatch(/^blob:/)
    }
  })

  it('is cached — the same blob URLs across calls', () => {
    expect(sdkImportMap()).toBe(sdkImportMap())
  })

  it('re-exports live named members read off the global at call time', () => {
    const source = blobs.get(sdkImportMap()['@hermes/plugin-sdk']) ?? ''

    // The shim must READ the global (so it tracks the live namespace) and
    // re-export by name, with the names derived from the namespace itself.
    expect(source).toContain('const m = globalThis.__HERMES_PLUGIN_SDK__;')
    expect(source).toContain('export default m.default ?? m;')
    expect(source).toMatch(/export const \{ [^}]*\bhost\b[^}]*\} = m;/)
  })

  it('never emits an empty destructuring (a syntax error) for a bare namespace', () => {
    for (const url of Object.values(sdkImportMap())) {
      expect(blobs.get(url) ?? '').not.toContain('export const {  } = m')
    }
  })
})
