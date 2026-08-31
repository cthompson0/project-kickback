import type { AsyncStorageArea } from './storage'

/**
 * Client-side preferences.
 *
 * These live in chrome.storage.local rather than the database because they
 * describe this browser's behaviour, not the user's account: whether *this*
 * machine should raise a desktop notification. Presence visibility is the
 * opposite - it governs what other people see, so it stays server-side and
 * server-enforced.
 *
 * Shaped so Phase 2B can add per-group mute lists without reworking anything.
 */

export interface KickbackPreferences {
  /** Desktop notifications when a gathering forms. */
  gatheringNotifications: boolean
  /**
   * Whether the optional measurement permission has been waved away.
   *
   * Remembered so the explanation does not reappear every time somebody opens
   * their account panel. It is a DISMISSAL, not a refusal: the control stays,
   * collapsed to a single line, so granting later is always one click away.
   */
  followPermissionDismissed: boolean
}

export const DEFAULT_PREFERENCES: KickbackPreferences = {
  // On by default: the whole point of this checkpoint is to find out whether
  // gathering alerts actually bring people together. One click turns it off.
  gatheringNotifications: true,
  // Nothing has been dismissed until somebody dismisses it.
  followPermissionDismissed: false,
}

const STORAGE_KEY = 'kickback:preferences'

export interface PreferencesService {
  get(): KickbackPreferences
  set(patch: Partial<KickbackPreferences>): Promise<KickbackPreferences>
  hydrate(): Promise<void>
  subscribe(listener: (preferences: KickbackPreferences) => void): () => void
}

export function createPreferences(
  storage?: AsyncStorageArea,
  onError?: (context: string, error: unknown) => void,
): PreferencesService {
  const listeners = new Set<(preferences: KickbackPreferences) => void>()
  let preferences: KickbackPreferences = { ...DEFAULT_PREFERENCES }

  const emit = () => {
    for (const listener of listeners) listener(preferences)
  }

  return {
    get: () => preferences,

    async hydrate() {
      if (!storage) return
      try {
        const stored = await storage.get(STORAGE_KEY)
        const value = stored[STORAGE_KEY]
        if (value && typeof value === 'object') {
          const candidate = value as Partial<KickbackPreferences>
          preferences = {
            gatheringNotifications:
              typeof candidate.gatheringNotifications === 'boolean'
                ? candidate.gatheringNotifications
                : DEFAULT_PREFERENCES.gatheringNotifications,
            followPermissionDismissed:
              typeof candidate.followPermissionDismissed === 'boolean'
                ? candidate.followPermissionDismissed
                : DEFAULT_PREFERENCES.followPermissionDismissed,
          }
          emit()
        }
      } catch (error) {
        onError?.('preferences.hydrate', error)
      }
    },

    async set(patch: Partial<KickbackPreferences>): Promise<KickbackPreferences> {
      preferences = { ...preferences, ...patch }
      emit()
      if (storage) {
        try {
          await storage.set({ [STORAGE_KEY]: preferences })
        } catch (error) {
          onError?.('preferences.set', error)
        }
      }
      return preferences
    },

    subscribe(listener) {
      listeners.add(listener)
      listener(preferences)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
