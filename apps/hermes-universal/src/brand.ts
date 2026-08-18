/**
 * Product naming — the one place the app's own name is spelled.
 *
 * Every user-visible sentence that names the product reads from here rather
 * than carrying its own literal, so the name is renamed by editing this file
 * instead of by walking a few hundred strings again.
 *
 * What deliberately does NOT read from here: the persisted `hermes.*`
 * localStorage keys and the `@/hermes` module paths. Those are contracts
 * with existing user state and with upstream's source layout — renaming them
 * rebrands nothing and quietly breaks things.
 */

/** Capitalised — prose, titles, metadata, anywhere the name is a noun. */
export const BRAND = 'Allr'

/** Lowercase — the wordmark lockup. Never `ALLR`; the brand book forbids it. */
export const BRAND_LOWER = 'allr'

/** The hosted backend, as users refer to it. */
export const BRAND_CLOUD = `${BRAND} Cloud`

/** Hero eyebrow from the brand book — used on the connect/first-run screens. */
export const BRAND_TAGLINE = 'One workspace. Finished work.'
