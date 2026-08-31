/**
 * Session storage for the service worker.
 *
 * supabase-js persists sessions in localStorage by default, which does not
 * exist in an MV3 service worker - the session would be lost every time Chrome
 * shuts the worker down. chrome.storage.local survives worker restarts and
 * browser restarts, which is exactly the lifetime a session needs.
 */

export interface AsyncStorageArea {
  get(keys: string | string[]): Promise<Record<string, unknown>>
  set(items: Record<string, unknown>): Promise<void>
  remove(keys: string | string[]): Promise<void>
}

export interface KeyValueStorage {
  getItem(key: string): Promise<string | null>
  setItem(key: string, value: string): Promise<void>
  removeItem(key: string): Promise<void>
}

/**
 * Twitch's own OAuth credentials, which Supabase hands back at sign-in.
 *
 * These are NOT the tokens Watchside signs in with. Supabase's own
 * `access_token` and `refresh_token` keep somebody logged in and must survive
 * untouched; these two belong to Twitch, and Watchside has never had a use for
 * them - `toSession()` throws them away the moment they arrive.
 *
 * They still reached the disk, because supabase-js serialises the WHOLE session
 * object and this adapter wrote whatever string it was handed. That is invisible
 * in Watchside's own source: nothing here mentions a provider token, so grepping
 * for one finds nothing while a live Twitch credential sits in
 * chrome.storage.local anyway. It took a real sign-in to see it.
 */
const PROVIDER_CREDENTIALS = ['provider_token', 'provider_refresh_token'] as const

/**
 * Deletes the two provider keys wherever they appear, and reports whether it
 * found any.
 *
 * The walk is deliberate rather than clever. supabase-js has changed the shape
 * it persists before - session at the top level, session nested under a wrapper
 * - and a sanitiser pinned to one shape would fail silently and unobservably the
 * next time it changes. Only these two exact key names are ever removed, so no
 * amount of nesting can make it touch a Supabase token.
 */
function removeProviderCredentials(value: unknown): boolean {
  if (Array.isArray(value)) {
    let removed = false
    for (const entry of value) removed = removeProviderCredentials(entry) || removed
    return removed
  }
  if (value === null || typeof value !== 'object') return false

  const record = value as Record<string, unknown>
  let removed = false
  for (const key of PROVIDER_CREDENTIALS) {
    if (key in record) {
      delete record[key]
      removed = true
    }
  }
  for (const entry of Object.values(record)) {
    removed = removeProviderCredentials(entry) || removed
  }
  return removed
}

/**
 * Returns `value` with any Twitch provider credentials removed.
 *
 * Anything that is not JSON is passed through untouched - this adapter is
 * general key/value storage and must not corrupt a value it does not understand.
 * A clean value is returned by identity rather than re-serialised, so ordinary
 * writes keep their exact bytes.
 */
export function stripProviderCredentials(value: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return value
  }
  return removeProviderCredentials(parsed) ? JSON.stringify(parsed) : value
}

export function createExtensionStorage(area: AsyncStorageArea): KeyValueStorage {
  return {
    async getItem(key) {
      const result = await area.get(key)
      const value = result[key]
      if (typeof value !== 'string') return null

      const clean = stripProviderCredentials(value)
      if (clean !== value) {
        // Somebody who signed in before this shipped still has a live Twitch
        // credential on disk. Reading is the first chance to remove it, so take
        // it - but never let that failure become a failure to read the session,
        // which would lock them out over a cleanup.
        try {
          await area.set({ [key]: clean })
        } catch {
          // Purged on the next write instead.
        }
      }
      return clean
    },
    async setItem(key, value) {
      // The boundary. Stripping here means the credential is never written,
      // rather than written and deleted afterwards.
      await area.set({ [key]: stripProviderCredentials(value) })
    },
    async removeItem(key) {
      await area.remove(key)
    },
  }
}

/** Simple in-memory area, used by tests and as a fallback. */
export function createMemoryStorageArea(): AsyncStorageArea {
  const map = new Map<string, unknown>()
  return {
    async get(keys) {
      const wanted = Array.isArray(keys) ? keys : [keys]
      const out: Record<string, unknown> = {}
      for (const key of wanted) {
        if (map.has(key)) out[key] = map.get(key)
      }
      return out
    },
    async set(items) {
      for (const [key, value] of Object.entries(items)) map.set(key, value)
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) map.delete(key)
    },
  }
}
