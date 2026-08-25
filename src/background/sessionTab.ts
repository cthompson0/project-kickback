import { parseMutedIds, withMuted, withoutMuted } from '../core/mute'

/**
 * What the panel remembers about the contextual stream session.
 *
 * Three small facts, all local, none of them a room record:
 *
 *   * which session the viewer intentionally opened, so a Twitch refresh does
 *     not throw them back to Friends;
 *   * how far they had read on each channel, so unread survives the same
 *     refresh rather than lying about what they had seen;
 *   * who they have muted, which the server never learns.
 *
 * WHY NONE OF THIS IS IN THE DATABASE
 *
 * A persistent automatic-room record would be a second source of truth about a
 * fact presence already owns, and it would have to have an opinion about what
 * happens to a room id on split and merge. None of that is needed to reopen a
 * tab. What is stored here is a channel login the browser has already seen, a
 * timestamp, and a list of user ids - and it self-destructs.
 *
 * THE RULE FOR COMING BACK
 *
 * A remembered selection is only honoured when the world still looks the way
 * it did: same canonical destination, still live, and a room that still has
 * somebody in it. Those three are checked by the caller against live state, so
 * a stale record can never reopen an unrelated streamer's room. The twelve
 * hour bound below is belt and braces on top of that - it stops a forgotten key
 * resurfacing after a weekend, and it means the file cannot grow without limit.
 */

const SELECTION_KEY = 'kickback:sessionTab'
const READ_KEY = 'kickback:sessionRead'
const MUTED_KEY = 'kickback:mutedUsers'

/**
 * How long a remembered selection, or a read watermark, is worth honouring.
 *
 * Longer than any plausible refresh-and-return, far shorter than a habit.
 */
export const SELECTION_TTL_MS = 12 * 60 * 60_000

export interface SessionSelection {
  /** Canonical lowercase login. */
  channel: string
  /** Epoch ms the viewer chose it. */
  selectedAt: number
}

export interface SessionStorage {
  get(keys: string | string[]): Promise<Record<string, unknown>>
  set(items: Record<string, unknown>): Promise<void> | void
  remove(keys: string | string[]): Promise<void> | void
}

export interface SessionTabDeps {
  storage: SessionStorage
  onChange?: () => void
  now?: () => number
  onError?: (context: string, error: unknown) => void
}

export interface SessionTab {
  /** Read everything back after a worker restart. Safe to call once, at boot. */
  hydrate(): Promise<void>
  /**
   * The channel whose session the viewer intentionally opened.
   *
   * Null once it has expired. Whether it is still ELIGIBLE is not this
   * module's question - the caller checks that against live state.
   */
  selected(): string | null
  /** Remember, or forget, an intentional selection. */
  select(channel: string | null): void
  /** How far the viewer has read on a channel. Zero when never opened. */
  readAt(channel: string): number
  /** Mark a channel read up to now. */
  markRead(channel: string): void
  /** Everyone this viewer has muted. */
  muted(): string[]
  setMuted(userId: string, muted: boolean): void
}

function parseSelection(value: unknown, now: number): SessionSelection | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const channel = raw.channel
  const selectedAt = raw.selectedAt

  if (typeof channel !== 'string' || !/^[a-z0-9_]{3,25}$/.test(channel)) return null
  if (typeof selectedAt !== 'number' || !Number.isFinite(selectedAt)) return null
  if (now - selectedAt > SELECTION_TTL_MS) return null

  return { channel, selectedAt }
}

function parseRead(value: unknown, now: number): Record<string, number> {
  if (!value || typeof value !== 'object') return {}
  const out: Record<string, number> = {}
  for (const [channel, at] of Object.entries(value as Record<string, unknown>)) {
    if (!/^[a-z0-9_]{3,25}$/.test(channel)) continue
    if (typeof at !== 'number' || !Number.isFinite(at)) continue
    // Watermarks age out with the selection, so this cannot accumulate a row
    // per channel the browser has ever visited.
    if (now - at > SELECTION_TTL_MS) continue
    out[channel] = at
  }
  return out
}

export function createSessionTab(deps: SessionTabDeps): SessionTab {
  const now = deps.now ?? (() => Date.now())

  let selection: SessionSelection | null = null
  let read: Record<string, number> = {}
  let mutedIds: string[] = []

  function persistSelection(): void {
    try {
      if (selection) void deps.storage.set({ [SELECTION_KEY]: selection })
      else void deps.storage.remove(SELECTION_KEY)
    } catch (error) {
      deps.onError?.('sessionTab.persist', error)
    }
  }

  return {
    async hydrate(): Promise<void> {
      try {
        const stored = await deps.storage.get([SELECTION_KEY, READ_KEY, MUTED_KEY])
        const at = now()
        selection = parseSelection(stored?.[SELECTION_KEY], at)
        read = parseRead(stored?.[READ_KEY], at)
        mutedIds = parseMutedIds(stored?.[MUTED_KEY])
        deps.onChange?.()
      } catch (error) {
        deps.onError?.('sessionTab.hydrate', error)
      }
    },

    selected(): string | null {
      if (!selection) return null
      if (now() - selection.selectedAt > SELECTION_TTL_MS) {
        selection = null
        persistSelection()
        return null
      }
      return selection.channel
    },

    select(channel): void {
      const login = channel ? channel.trim().toLowerCase() : null
      if (login === (selection?.channel ?? null)) {
        // Re-selecting the same session refreshes the clock, so a long
        // evening's viewing does not expire out from under the viewer.
        if (selection) selection = { channel: selection.channel, selectedAt: now() }
        persistSelection()
        return
      }
      selection = login ? { channel: login, selectedAt: now() } : null
      persistSelection()
      deps.onChange?.()
    },

    readAt(channel): number {
      return read[channel.toLowerCase()] ?? 0
    },

    markRead(channel): void {
      const login = channel.toLowerCase()
      read = { ...read, [login]: now() }
      try {
        void deps.storage.set({ [READ_KEY]: read })
      } catch (error) {
        deps.onError?.('sessionTab.markRead', error)
      }
      deps.onChange?.()
    },

    muted: () => mutedIds,

    setMuted(userId, muted): void {
      const next = muted ? withMuted(mutedIds, userId) : withoutMuted(mutedIds, userId)
      if (next.length === mutedIds.length && next.every((id, i) => id === mutedIds[i])) return
      mutedIds = next
      try {
        void deps.storage.set({ [MUTED_KEY]: mutedIds })
      } catch (error) {
        deps.onError?.('sessionTab.mute', error)
      }
      deps.onChange?.()
    },
  }
}
