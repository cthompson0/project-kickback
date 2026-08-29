/**
 * Mints the keypair that pins Watchside's extension ID.
 *
 * An unpacked extension's ID is derived from its public key. Without a `key`
 * field in the manifest Chrome invents one per machine, so the OAuth redirect
 * URL (https://<id>.chromiumapp.org/) would differ for every developer and
 * every fresh profile - and that URL has to be registered in Supabase.
 *
 *   node scripts/generate-extension-key.mjs
 *
 * Writes the private key to .keys/ (gitignored) and prints the manifest `key`
 * value and the resulting extension ID. Run once; re-running mints a NEW
 * identity and invalidates the registered redirect URL.
 */
import { generateKeyPairSync, createHash } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const KEY_DIR = '.keys'
const PRIVATE_KEY_PATH = join(KEY_DIR, 'kickback-extension.pem')

if (existsSync(PRIVATE_KEY_PATH) && !process.argv.includes('--force')) {
  console.error(
    `${PRIVATE_KEY_PATH} already exists.\n` +
      'Refusing to mint a new identity - that would change the extension ID and break\n' +
      'the registered OAuth redirect URL. Pass --force only if that is what you want.',
  )
  process.exit(1)
}

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })

// Chrome derives the id from the DER-encoded SubjectPublicKeyInfo.
const der = publicKey.export({ type: 'spki', format: 'der' })

/**
 * Extension id = first 128 bits of SHA-256 over the DER public key, hex
 * encoded, then digits 0-f remapped onto letters a-p.
 */
const extensionId = createHash('sha256')
  .update(der)
  .digest('hex')
  .slice(0, 32)
  .replace(/[0-9a-f]/g, (hexDigit) =>
    String.fromCharCode('a'.charCodeAt(0) + parseInt(hexDigit, 16)),
  )

mkdirSync(KEY_DIR, { recursive: true })
writeFileSync(PRIVATE_KEY_PATH, privateKey.export({ type: 'pkcs8', format: 'pem' }))

const manifestKey = der.toString('base64')

console.log('extension id   :', extensionId)
console.log('redirect url   :', `https://${extensionId}.chromiumapp.org/`)
console.log('private key    :', PRIVATE_KEY_PATH, '(gitignored - do not commit)')
console.log('\nmanifest "key" :\n' + manifestKey)
