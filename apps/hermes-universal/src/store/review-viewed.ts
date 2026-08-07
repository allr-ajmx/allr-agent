import type { HermesReviewFile } from '@/global'
import { Codecs, persistentAtom } from '@/lib/persisted'

// "Viewed" marks for the review list, the way GitHub's Files-changed tab does it.
//
// It exists for the phone: reviewing twenty changed files happens across three
// sittings on a train, and without a place-marker every one of them starts over.
// Desktop shows the whole list at once and never needed it.
//
// The mark stores a SIGNATURE of the file's diff, not a boolean, so a file the
// agent touches again automatically un-views itself — a stale checkmark that hides
// new changes would be worse than no marks at all.

const KEY = 'hermes.reviewViewed'

export const $reviewViewed = persistentAtom<Record<string, string>>(KEY, {}, Codecs.stringRecord)

/** Cheap stand-in for the diff's identity: status + churn. It moves whenever the
 *  file is edited again, which is the only precision the mark needs. */
export function reviewFileSignature(file: HermesReviewFile): string {
  return `${file.status}:${file.added}:${file.removed}`
}

export function isReviewFileViewed(viewed: Record<string, string>, file: HermesReviewFile): boolean {
  return viewed[file.path] === reviewFileSignature(file)
}

export function setReviewFileViewed(file: HermesReviewFile, value: boolean): void {
  const current = $reviewViewed.get()

  if (value) {
    $reviewViewed.set({ ...current, [file.path]: reviewFileSignature(file) })

    return
  }

  if (!(file.path in current)) {
    return
  }

  const next = { ...current }
  delete next[file.path]
  $reviewViewed.set(next)
}

/** Drop marks for files that are no longer in the changed set (committed,
 *  reverted, or the repo changed under us) so the store can't grow forever. */
export function pruneReviewViewed(files: HermesReviewFile[]): void {
  const current = $reviewViewed.get()
  const live = new Set(files.map(file => file.path))
  const kept = Object.entries(current).filter(([path]) => live.has(path))

  if (kept.length !== Object.keys(current).length) {
    $reviewViewed.set(Object.fromEntries(kept))
  }
}
