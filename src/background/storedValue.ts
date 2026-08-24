/**
 * One JSON value in extension storage, read and written whole.
 *
 * Analytics needs two of these - the open session and the pending JOIN
 * attribution - and both exist for the same reason: an MV3 service worker is
 * killed after about thirty seconds idle, so anything that must outlive a
 * pause cannot live in a variable.
 *
 * Deliberately tiny, and deliberately validating. Storage is shared with every
 * other part of the extension and survives upgrades, so what comes back is not
 * guaranteed to be what was written by this version of the code. A value that
 * does not pass its own check reads as absent rather than being handed on as
 * something the caller will trip over later.
 */

export interface StorageArea {
  get(keys: string | string[]): Promise<Record<string, unknown>>
  set(items: Record<string, unknown>): Promise<void>
  remove(keys: string | string[]): Promise<void>
}

export interface StoredValue<T> {
  read(): Promise<T | null>
  write(value: T | null): Promise<void>
}

export function createStoredValue<T>(
  storage: StorageArea,
  key: string,
  isValid: (value: unknown) => value is T,
): StoredValue<T> {
  return {
    async read(): Promise<T | null> {
      try {
        const stored = await storage.get(key)
        const value = stored?.[key]
        return isValid(value) ? value : null
      } catch {
        // Storage being unavailable is not something analytics may complain
        // about. No value simply means no session, or no pending JOIN.
        return null
      }
    },

    async write(value: T | null): Promise<void> {
      try {
        if (value === null) await storage.remove(key)
        else await storage.set({ [key]: value })
      } catch {
        // Same rule: a write that fails costs an event, not an error.
      }
    },
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function isSessionRecord(
  value: unknown,
): value is { id: string; startedAt: number; lastActiveAt: number } {
  return (
    isObject(value) &&
    typeof value.id === 'string' &&
    typeof value.startedAt === 'number' &&
    typeof value.lastActiveAt === 'number'
  )
}

export function isJoinAttribution(value: unknown): value is {
  id: string
  channel: string
  source: string
  sessionId: string | null
  clickedAt: number
  state: 'pending' | 'arrived'
  arrivedAt: number | null
} {
  return (
    isObject(value) &&
    typeof value.id === 'string' &&
    typeof value.channel === 'string' &&
    typeof value.source === 'string' &&
    (value.sessionId === null || typeof value.sessionId === 'string') &&
    typeof value.clickedAt === 'number' &&
    (value.state === 'pending' || value.state === 'arrived') &&
    (value.arrivedAt === null || typeof value.arrivedAt === 'number')
  )
}
