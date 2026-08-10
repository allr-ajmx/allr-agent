/**
 * Profile-name validation, in one place.
 *
 * The rule is the backend's, not ours: `hermes_cli/profiles.py`
 * `validate_profile_name()` matches `^[a-z0-9][a-z0-9_-]{0,63}$` and additionally
 * refuses a small reserved set. Accepting a reserved name here only defers the
 * refusal to a 4xx from `POST /api/profiles` with a message the dialog cannot
 * explain — so the same rule is enforced at the point of typing.
 *
 * Previously this regex lived (twice, verbatim) in the create dialog and the
 * Profiles overlay; both now import from here.
 */

const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/

/**
 * Names the backend refuses outright, because they would collide on disk (a
 * `hermes` profile inside `~/.hermes/`) or be rejected at alias-creation time.
 * Mirrors `_RESERVED_NAMES` in `hermes_cli/profiles.py`.
 *
 * `default` is deliberately absent: the backend treats it as a pass-through
 * alias for the built-in root profile, and universal already ships it as the
 * `is_default` entry — so it is "taken", which the caller's duplicate check
 * reports far better than "invalid".
 */
export const RESERVED_PROFILE_NAMES: ReadonlySet<string> = new Set(['hermes', 'root', 'sudo', 'test', 'tmp'])

/** True when `name` is a profile name the backend will actually accept. */
export function isValidProfileName(name: string): boolean {
  const trimmed = name.trim()

  return PROFILE_NAME_RE.test(trimmed) && !RESERVED_PROFILE_NAMES.has(trimmed)
}
