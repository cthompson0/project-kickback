/**
 * Sealing a Twitch credential.
 *
 * The database holds ciphertext and never the key. The key lives in the Edge
 * Function's environment, which means a complete database compromise - a dump,
 * a leaked service-role key, an administrator running a SELECT - yields bytes
 * nobody can read. That is the property Supabase Vault could not give us: Vault
 * is for system secrets and its decrypted view is reachable by SQL privilege.
 *
 * No custom cryptography. One standard construction, AES-256-GCM through Web
 * Crypto, used the way it is meant to be used.
 *
 * THE ENVELOPE
 *
 *   byte 0      format version   (currently 1)
 *   byte 1      key version      (which secret encrypted this)
 *   bytes 2-13  nonce            (96-bit, fresh random per seal)
 *   bytes 14+   ciphertext ‖ GCM tag
 *
 * Self-describing on purpose. A row that outlives a key rotation still says
 * which key opens it, so rotation is additive and needs no migration and no
 * bulk re-encryption pass.
 *
 * ADDITIONAL AUTHENTICATED DATA
 *
 * The actor id is authenticated but not encrypted. Copying one user's row into
 * another user's row therefore fails to open rather than silently succeeding -
 * it turns database tampering into a clean authentication failure.
 *
 * NONCE REUSE
 *
 * Catastrophic for GCM, so the nonce is drawn from crypto.getRandomValues on
 * every seal and never derived, never counted, never reused. There is no code
 * path that seals twice with the same nonce because there is no code path that
 * chooses a nonce at all.
 */

export const FORMAT_VERSION = 1
const NONCE_BYTES = 12
const HEADER_BYTES = 2 + NONCE_BYTES

export class CredentialCryptoError extends Error {
  readonly code: string

  constructor(code: string) {
    super(code)
    this.code = code
    this.name = 'CredentialCryptoError'
  }
}

/** What actually gets sealed. Nothing else about the OAuth response is kept. */
export interface CredentialSecret {
  accessToken: string
  refreshToken: string
}

/** version -> raw 32-byte key material, base64. */
export type KeyRing = Readonly<Record<number, string>>

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

async function importKey(keys: KeyRing, version: number): Promise<CryptoKey> {
  const material = keys[version]
  // Fail closed. An unknown or missing key is never a reason to fall back to
  // anything - least of all to storing or returning plaintext.
  if (!material) throw new CredentialCryptoError('key_unavailable')

  let raw: Uint8Array
  try {
    raw = base64ToBytes(material)
  } catch {
    throw new CredentialCryptoError('key_malformed')
  }
  if (raw.length !== 32) throw new CredentialCryptoError('key_wrong_length')

  return crypto.subtle.importKey(
    'raw',
    raw as unknown as BufferSource,
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt'],
  )
}

/**
 * Encrypts a credential for one actor.
 *
 * Returns the complete envelope. The caller stores these bytes and nothing
 * else - there is no separate nonce column to keep in step.
 */
export async function seal(
  secret: CredentialSecret,
  actorId: string,
  keys: KeyRing,
  keyVersion: number,
): Promise<Uint8Array> {
  const key = await importKey(keys, keyVersion)
  if (keyVersion < 0 || keyVersion > 255) throw new CredentialCryptoError('key_version_range')

  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES))
  const plaintext = encoder.encode(
    JSON.stringify({ a: secret.accessToken, r: secret.refreshToken }),
  )

  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: nonce as unknown as BufferSource,
        additionalData: encoder.encode(actorId) as unknown as BufferSource,
      },
      key,
      plaintext as unknown as BufferSource,
    ),
  )

  const envelope = new Uint8Array(HEADER_BYTES + sealed.length)
  envelope[0] = FORMAT_VERSION
  envelope[1] = keyVersion
  envelope.set(nonce, 2)
  envelope.set(sealed, HEADER_BYTES)
  return envelope
}

/** Which key version an envelope needs, without opening it. */
export function keyVersionOf(envelope: Uint8Array): number {
  if (envelope.length < HEADER_BYTES) throw new CredentialCryptoError('ciphertext_malformed')
  if (envelope[0] !== FORMAT_VERSION) throw new CredentialCryptoError('format_unsupported')
  return envelope[1]
}

/**
 * Opens an envelope, or throws.
 *
 * Every failure mode is fail-closed and distinguishable only by a fixed code -
 * a wrong key, a wrong actor, a truncated envelope and a flipped bit all end
 * here, and none of them yields a partial result.
 */
export async function open(
  envelope: Uint8Array,
  actorId: string,
  keys: KeyRing,
): Promise<CredentialSecret> {
  const keyVersion = keyVersionOf(envelope)
  const key = await importKey(keys, keyVersion)

  const nonce = envelope.subarray(2, HEADER_BYTES)
  const sealed = envelope.subarray(HEADER_BYTES)
  if (sealed.length === 0) throw new CredentialCryptoError('ciphertext_malformed')

  let plaintext: ArrayBuffer
  try {
    plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: nonce as unknown as BufferSource,
        additionalData: encoder.encode(actorId) as unknown as BufferSource,
      },
      key,
      sealed as unknown as BufferSource,
    )
  } catch {
    // Wrong key, wrong actor, or tampered bytes. GCM cannot tell us which, and
    // it does not matter: all three mean "do not proceed".
    throw new CredentialCryptoError('decrypt_failed')
  }

  let parsed: { a?: unknown; r?: unknown }
  try {
    parsed = JSON.parse(decoder.decode(plaintext))
  } catch {
    throw new CredentialCryptoError('plaintext_malformed')
  }

  if (typeof parsed.a !== 'string' || typeof parsed.r !== 'string') {
    throw new CredentialCryptoError('plaintext_malformed')
  }
  return { accessToken: parsed.a, refreshToken: parsed.r }
}

/**
 * Reads the key ring from the environment.
 *
 * Keys are named TWITCH_CREDENTIAL_KEY_V<n>. Adding a version is a deployment
 * step, not a code change, and both versions coexist while old rows drain.
 */
export function keyRingFrom(env: (name: string) => string | undefined, maxVersion = 8): KeyRing {
  const ring: Record<number, string> = {}
  for (let version = 1; version <= maxVersion; version += 1) {
    const value = env(`TWITCH_CREDENTIAL_KEY_V${version}`)
    if (value) ring[version] = value
  }
  return ring
}

/** The version new writes use: the highest key configured. */
export function currentKeyVersion(keys: KeyRing): number {
  const versions = Object.keys(keys).map(Number)
  if (versions.length === 0) throw new CredentialCryptoError('key_unavailable')
  return Math.max(...versions)
}
