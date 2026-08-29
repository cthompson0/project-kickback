/**
 * Who Watchside is, as far as Chrome is concerned.
 *
 * One constant, in one file, because this ID is about to move exactly once and
 * it must move everywhere at the same moment.
 *
 * WHERE THE ID COMES FROM
 *
 * `public/manifest.json` pins a public `key`. Chrome derives an unpacked
 * extension's ID from the first 128 bits of SHA-256 over that key, so every
 * machine that loads the same files gets the same ID.
 *
 * That key used to be one we generated ourselves, which was fine while Watchside
 * was only ever sideloaded. It is not what the published extension is: the Web
 * Store mints its own keypair when an item is created, and the item ID follows
 * from that rather than from anything we ship.
 *
 * So the swap has now happened, in the direction the documentation describes -
 * the item was created, its public key was read off the Package tab, and it now
 * lives in the manifest. A local build and the published item are the same
 * extension to Chrome, with the same ID and therefore the same OAuth redirect.
 *
 * This file exists so that swap was a one-line change with a check behind it,
 * rather than a hunt through a packaging script, two test files, a README and a
 * privacy policy - each of which would fail differently and none of which would
 * fail immediately.
 *
 * WHAT BREAKS IF THEY DISAGREE
 *
 * `chrome.identity.getRedirectURL()` returns https://<id>.chromiumapp.org/, and
 * that exact string has to be in Supabase's redirect allow-list. Get it wrong
 * and sign-in fails at the very last hop, after Twitch has already said yes -
 * which reads to a tester as "Watchside is broken", not as "a URL is missing
 * from a dashboard".
 */
import { createHash } from 'node:crypto'

/**
 * The ID the currently shipped `key` produces.
 *
 * This is now the CHROME WEB STORE's own identity, adopted from the item's
 * Package tab after review. It is no longer something we chose - the store
 * minted the keypair, the ID follows from it, and `public/manifest.json`
 * carries the matching public key so a local build and the published item are
 * the same extension to Chrome.
 *
 * Change this and `public/manifest.json` together, never one alone, and then
 * run `npm run verify:store` - it recomputes the ID from the key and greps the
 * repository for stale copies.
 */
export const EXPECTED_EXTENSION_ID = 'ngfopkeokddfnncdhfkhnffilbdhkkip'

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
