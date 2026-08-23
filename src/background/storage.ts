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

export function createExtensionStorage(area: AsyncStorageArea): KeyValueStorage {
  return {
    async getItem(key) {
      const result = await area.get(key)
      const value = result[key]
      return typeof value === 'string' ? value : null
    },
    async setItem(key, value) {
      await area.set({ [key]: value })
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
