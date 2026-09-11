import { describe, expect, it } from 'vitest'

import { artifactOpenAction } from './artifact-open'

describe('artifactOpenAction', () => {
  it('downloads an absolute gateway path rather than opening its href', () => {
    // The regression this pins, and the reason `href` is carried at all: for a
    // gateway-local record `href` is the raw /api/files/download URL with a
    // token in the query. Sending the OS browser there behind a gated gateway
    // is a 401 and, to the user, a click that did nothing.
    expect(
      artifactOpenAction({
        href: 'https://gw/api/files/download?path=%2Fwork%2Fout%2Freport.pdf&token=secret',
        value: '/work/out/report.pdf'
      })
    ).toEqual({ kind: 'download', path: '/work/out/report.pdf' })
  })

  it('downloads a file:// artifact too, and hands the path on untouched', () => {
    // `downloadPath` normalizes `file://` itself (`filePathFromMediaPath`), so
    // this layer must NOT pre-decode it — two decodes corrupt a path with a %.
    expect(artifactOpenAction({ href: 'file:///work/q3%20report.pdf', value: 'file:///work/q3%20report.pdf' })).toEqual(
      {
        kind: 'download',
        path: 'file:///work/q3%20report.pdf'
      }
    )
  })

  it('downloads a Windows-drive path', () => {
    expect(artifactOpenAction({ href: 'C:/work/out.png', value: 'C:/work/out.png' })).toEqual({
      kind: 'download',
      path: 'C:/work/out.png'
    })
  })

  it('opens an http artifact externally, by its href and not its value', () => {
    expect(
      artifactOpenAction({ href: 'https://example.com/docs/getting-started', value: 'https://example.com/docs' })
    ).toEqual({ href: 'https://example.com/docs/getting-started', kind: 'external' })
  })

  it('treats a relative path as external, not as a gateway file', () => {
    // `./out.png` cannot be resolved without knowing which cwd it was relative
    // to, and guessing would ask the gateway to read a path that is not there.
    expect(artifactOpenAction({ href: './out.png', value: './out.png' })).toEqual({
      href: './out.png',
      kind: 'external'
    })
  })
})
