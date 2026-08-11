import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ArtifactDetection } from '@/lib/artifact-detect'

import {
  $artifactRegistry,
  $artifactVersionSelection,
  artifactsForSession,
  clearArtifactRegistry,
  getArtifact,
  openArtifact,
  selectArtifactVersion,
  upsertArtifact
} from './artifacts'
import { $activePreviewPath, $previewTabs, closePreviewTab } from './preview'

// `store/artifacts` reaches the staging commands through `invoke`; nothing in
// this file exercises them, but the import must not blow up outside Tauri.
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => undefined) }))

const HTML: ArtifactDetection = { kind: 'html', language: 'html', title: 'Pomodoro Timer' }

function reset() {
  clearArtifactRegistry()
  $previewTabs.set([])
  $activePreviewPath.set(null)
}

beforeEach(reset)
afterEach(reset)

describe('artifact registry', () => {
  it('registers a new artifact with one version', () => {
    const result = upsertArtifact('session-1', HTML, '<html>v1</html>')

    expect(result?.versionAdded).toBe(true)
    expect(artifactsForSession('session-1')).toHaveLength(1)
    expect(getArtifact(result!.artifactId)?.versions).toHaveLength(1)
  })

  it('dedupes identical content by hash (streaming replays are no-ops)', () => {
    const first = upsertArtifact('session-1', HTML, '<html>v1</html>')
    const replay = upsertArtifact('session-1', HTML, '<html>v1</html>')

    expect(replay?.versionAdded).toBe(false)
    expect(replay?.artifactId).toBe(first?.artifactId)
    expect(getArtifact(first!.artifactId)?.versions).toHaveLength(1)
  })

  it('appends a version when the same artifact regenerates, keeping the old content', () => {
    const first = upsertArtifact('session-1', HTML, '<html>v1</html>')
    const second = upsertArtifact('session-1', HTML, '<html>v2</html>')

    expect(second?.artifactId).toBe(first?.artifactId)

    const record = getArtifact(first!.artifactId)

    // "Versioned" has to mean the earlier draft is still readable — an append
    // that overwrote would look identical from the card.
    expect(record?.versions.map(version => version.content)).toEqual(['<html>v1</html>', '<html>v2</html>'])
    expect(artifactsForSession('session-1')).toHaveLength(1)
  })

  it('keeps different titles as separate artifacts', () => {
    upsertArtifact('session-1', HTML, '<html>timer</html>')
    upsertArtifact('session-1', { ...HTML, title: 'Budget Dashboard' }, '<html>budget</html>')

    expect(artifactsForSession('session-1')).toHaveLength(2)
  })

  it('scopes artifacts per session', () => {
    upsertArtifact('session-1', HTML, '<html>a</html>')
    upsertArtifact('session-2', HTML, '<html>b</html>')

    expect(artifactsForSession('session-1')).toHaveLength(1)
    expect(artifactsForSession('session-2')).toHaveLength(1)
  })

  it('rejects empty sessions and empty content', () => {
    expect(upsertArtifact('', HTML, '<html>x</html>')).toBeNull()
    expect(upsertArtifact('session-1', HTML, '   ')).toBeNull()
  })
})

describe('artifact preview tabs', () => {
  it('opens an artifact as a tab that references the registry by id', () => {
    const result = upsertArtifact('session-1', HTML, '<html>v1</html>')!

    openArtifact(result.artifactId)

    expect($previewTabs.get()).toEqual([{ name: 'Pomodoro Timer', path: `artifact:${result.artifactId}` }])
    expect($activePreviewPath.get()).toBe(`artifact:${result.artifactId}`)
  })

  it('does not duplicate a tab when the same artifact opens twice', () => {
    const result = upsertArtifact('session-1', HTML, '<html>v1</html>')!

    openArtifact(result.artifactId)
    openArtifact(result.artifactId)

    expect($previewTabs.get()).toHaveLength(1)
  })

  it('opening an unknown artifact opens nothing', () => {
    openArtifact('session-1:nope')

    expect($previewTabs.get()).toEqual([])
  })

  it('clearing the registry closes the tabs pointing into it', () => {
    const result = upsertArtifact('session-1', HTML, '<html>v1</html>')!

    openArtifact(result.artifactId)
    clearArtifactRegistry()

    expect($previewTabs.get()).toEqual([])
    expect($activePreviewPath.get()).toBeNull()
    expect(artifactsForSession('session-1')).toEqual([])
  })

  it('leaves a file tab alone when the registry is cleared', () => {
    const result = upsertArtifact('session-1', HTML, '<html>v1</html>')!

    $previewTabs.set([{ name: 'app.ts', path: '/repo/app.ts' }])
    openArtifact(result.artifactId)
    clearArtifactRegistry()

    expect($previewTabs.get()).toEqual([{ name: 'app.ts', path: '/repo/app.ts' }])
    expect($activePreviewPath.get()).toBe('/repo/app.ts')
  })

  it('closing the tab leaves the artifact in the registry', () => {
    const result = upsertArtifact('session-1', HTML, '<html>v1</html>')!

    openArtifact(result.artifactId)
    closePreviewTab(`artifact:${result.artifactId}`)

    expect($previewTabs.get()).toEqual([])
    expect(getArtifact(result.artifactId)).not.toBeNull()
  })
})

describe('artifact version selection', () => {
  it('tracks a pin and snaps back to latest', () => {
    const result = upsertArtifact('session-1', HTML, '<html>v1</html>')!

    upsertArtifact('session-1', HTML, '<html>v2</html>')
    upsertArtifact('session-1', HTML, '<html>v3</html>')

    selectArtifactVersion(result.artifactId, 0)

    expect($artifactVersionSelection.get()[result.artifactId]).toBe(0)

    // Selecting the newest clears the pin — absent means "follow the newest".
    selectArtifactVersion(result.artifactId, 2)

    expect(result.artifactId in $artifactVersionSelection.get()).toBe(false)

    selectArtifactVersion(result.artifactId, -5)

    expect($artifactVersionSelection.get()[result.artifactId]).toBe(0)
  })

  it('opens at the newest version by default and at a pinned one on request', () => {
    const result = upsertArtifact('session-1', HTML, '<html>v1</html>')!

    upsertArtifact('session-1', HTML, '<html>v2</html>')

    openArtifact(result.artifactId, 0)

    expect($artifactVersionSelection.get()[result.artifactId]).toBe(0)

    openArtifact(result.artifactId)

    expect(result.artifactId in $artifactVersionSelection.get()).toBe(false)
  })

  // The version cap drops the OLDEST version, which renumbers every survivor.
  // A pinned index left alone would silently start naming a different version —
  // the content under an open viewer changing with nothing on screen saying so.
  it('re-bases a pinned version when the cap drops the oldest one', () => {
    const result = upsertArtifact('session-1', HTML, '<html>v1</html>')!

    for (let version = 2; version <= 20; version += 1) {
      upsertArtifact('session-1', HTML, `<html>v${version}</html>`)
    }

    selectArtifactVersion(result.artifactId, 5)

    expect(getArtifact(result.artifactId)?.versions[5]?.content).toBe('<html>v6</html>')

    // The 21st version evicts v1, so index 5 would now be v7 without the shift.
    upsertArtifact('session-1', HTML, '<html>v21</html>')

    const pinned = $artifactVersionSelection.get()[result.artifactId]!

    expect(getArtifact(result.artifactId)?.versions[pinned]?.content).toBe('<html>v6</html>')
  })

  it('clamps a pin at the oldest survivor once the version it named is gone', () => {
    const result = upsertArtifact('session-1', HTML, '<html>v1</html>')!

    for (let version = 2; version <= 20; version += 1) {
      upsertArtifact('session-1', HTML, `<html>v${version}</html>`)
    }

    selectArtifactVersion(result.artifactId, 0)
    upsertArtifact('session-1', HTML, '<html>v21</html>')

    expect($artifactVersionSelection.get()[result.artifactId]).toBe(0)
    expect(getArtifact(result.artifactId)?.versions[0]?.content).toBe('<html>v2</html>')
  })

  it('leaves an unpinned artifact unpinned when the cap evicts', () => {
    const result = upsertArtifact('session-1', HTML, '<html>v1</html>')!

    for (let version = 2; version <= 21; version += 1) {
      upsertArtifact('session-1', HTML, `<html>v${version}</html>`)
    }

    expect(result.artifactId in $artifactVersionSelection.get()).toBe(false)
    expect($artifactRegistry.get()['session-1']![0]!.versions).toHaveLength(20)
  })
})
