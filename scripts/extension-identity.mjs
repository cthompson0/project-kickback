/**
 * Who Kickback is, as far as Chrome is concerned.
 *
 * One constant, in one file, because this ID is about to move exactly once and
 * it must move everywhere at the same moment.
 *
 * WHERE THE ID COMES FROM TODAY
 *
 * `public/manifest.json` pins a public `key`. Chrome derives an unpacked
 * extension's ID from the first 128 bits of SHA-256 over that key, so every
 * machine that loads the same files gets the same ID - which is what lets one
 * OAuth redirect allow-list serve every tester of a sideloaded build.
 *
 * WHERE IT COMES FROM AFTER THE CHROME WEB STORE
 *
 * Somewhere else. The Web Store mints its own keypair when an item is created
 * and the item ID follows from that, not from anything we ship. Our key is a
 * local invention; the store's is the real one. The documented flow is the
 * reverse of what we did: create the item, read its public key off the Package
 * tab, and put THAT in the manifest so local builds and the published item
 * share an identity.
 *
 * So this file exists to make that swap a one-line change with a check behind
 * it, rather than a hunt through a packaging script, two test files, a README
 * and a privacy policy - each of which would fail differently and none of which
 * would fail immediately.
 *
 * WHAT BREAKS IF THEY DISAGREE
 *
 * `chrome.identity.getRedirectURL()` returns https://<id>.chromiumapp.org/, and
 * that exact string has to be in Supabase's redirect allow-list. Get it wrong
 * and sign-in fails at the very last hop, after Twitch has already said yes -
 * which reads to a tester as "Kickback is broken", not as "a URL is missing
 * from a dashboard".
 */
import { createHash } from 'node:crypto'

/**
 * The ID the currently shipped `key` produces.
 *
 * Change this and `public/manifest.json` together, never one alone, and then
 * run `npm run verify:store` - it recomputes the ID from the key and greps the
 * repository for stale copies.
 */
export const EXPECTED_EXTENSION_ID = 'almhfkicihekhiloapoimglfdoneglni'

/** The redirect Chrome hands to `launchWebAuthFlow` for a given ID. */
export const redirectUrlFor = (id) => `https://${id}.chromiumapp.org/`

/**
 * Chrome's own derivation: SHA-256 over the DER public key, first 16 bytes,
 * each nibble mapped into a-p.
 */
export function extensionIdFromKey(base64Key) {
  const hash = createHash('sha256').update(Buffer.from(base64Key, 'base64')).digest('hex')
  return [...hash.slice(0, 32)].map((c) => String.fromCharCode(parseInt(c, 16) + 97)).join('')
}
