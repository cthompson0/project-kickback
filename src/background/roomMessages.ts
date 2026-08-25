import {
  parseRoomMessage,
  parseRoomMessages,
  pruneMessages,
  withMessage,
  withMessages,
} from '../core/roomMessages'
import type { RoomMessage } from '../core/roomMessages'

/**
 * The viewer's room-message inbox.
 *
 * The same shape as the reaction inbox, for the same reason: the server writes
 * one row PER RECIPIENT and each viewer subscribes to `recipient_id = <self>`
 * on a topic named after themselves, so every row has exactly one interested
 * subscriber. That is what makes delivery symmetric on hosted Supabase, and
 * authorization lives entirely on the write side - there is no client-side
 * privacy filter here, because a filter is one an attacker controls.
 *
 * WHAT IS DIFFERENT FROM REACTIONS, AND WHY
 *
 * Reactions are eight seconds of punctuation and are deliberately never read
 * back: a stale one restored after a wake-up would show somebody laughing at a
 * moment that has passed.
 *
 * A conversation is not that. Refreshing Twitch, or having the worker evicted,
 * must not destroy what people were saying - so this one FETCHES. That is the
 * whole functional difference and it is why 0021 has an inbox index that 0020
 * deliberately denied reactions.
 *
 * The fetch and the subscription overlap on purpose. Whichever arrives first
 * wins and the other is folded in by row id, so there is no window where a
 * message sent mid-fetch is lost and none where one is shown twice.
 */

export interface RoomMessageChannelHandlers {
  /** One inserted row, exactly as realtime delivered it. Parsed in one place. */
  onMessage: (row: unknown) => void
  onStatus: (status: 'connected' | 'error') => void
}

export interface RoomMessageChannel {
  /** Subscribe to one user's inbox. Returns an unsubscribe function. */
  open(userId: string, handlers: RoomMessageChannelHandlers): Promise<() => void>
}

export interface RoomMessageBackend {
  /** Resolves to how many people it reached. Rejects on refusal. */
  send(channel: string, body: string): Promise<number>
  /** This viewer's retained messages for one channel. Rejects on failure. */
  history(channel: string): Promise<unknown>
}

export interface RoomMessagesDeps {
  channel: RoomMessageChannel
  backend: RoomMessageBackend
  onChange?: () => void
  /** A message arrived, for unread and analytics. Includes the viewer's own. */
  onMessage?: (message: RoomMessage, mine: boolean) => void
  now?: () => number
  onError?: (context: string, error: unknown) => void
}

export interface RoomMessages {
  /** Who the inbox belongs to, or null when signed out. Idempotent. */
  setUser(userId: string | null): void
  /**
   * Where the viewer is watching, or null.
   *
   * Changing channel clears the buffer and fetches what was said on the new
   * one. Setting the SAME channel again re-fetches, which is what a refresh
   * needs: the worker may have been evicted with messages on the server that
   * this client has never seen.
   */
  setChannel(channel: string | null): void
  /** Send one. Fire-and-forget; failure is logged, never surfaced. */
  send(body: string): void
  /** Everything still worth showing, oldest first. */
  snapshot(): RoomMessage[]
  reset(): void
  /** For tests and diagnostics. */
  subscribedTo(): string | null
}

export function createRoomMessages(deps: RoomMessagesDeps): RoomMessages {
  const now = deps.now ?? (() => Date.now())

  let userId: string | null = null
  let channel: string | null = null
  let close: (() => void) | null = null
  let messages: RoomMessage[] = []
  /** Guards a slow open or fetch landing after the subscription was replaced. */
  let generation = 0

  function receive(row: unknown, mine: number): void {
    if (mine !== generation) return

    const message = parseRoomMessage(row)
    if (!message) return

    /*
     * A message for a channel the viewer has already left is dropped.
     *
     * The inbox is per user and outlives any one stream, so a row can arrive
     * moments after they moved on. It stays on the server for whoever is still
     * there; it simply does not belong on this screen.
     */
    if (message.channel !== channel) return

    const before = messages.length
    messages = withMessage(pruneMessages(messages, now()), message)
    if (messages.length === before) return

    deps.onMessage?.(message, message.senderId === userId)
    deps.onChange?.()
  }

  function fetchHistory(forChannel: string, mine: number): void {
    void deps.backend
      .history(forChannel)
      .then((payload) => {
        if (mine !== generation || forChannel !== channel) return
        const fetched = parseRoomMessages(payload).filter(
          (message) => message.channel === forChannel,
        )
        if (fetched.length === 0) return
        messages = withMessages(pruneMessages(messages, now()), fetched)
        deps.onChange?.()
      })
      .catch((error) => {
        /*
         * Nothing is cleared.
         *
         * A failed fetch means we cannot show what was said before we got
         * here; it does not mean nothing was said. Live delivery still works,
         * so the conversation starts from now rather than looking broken.
         */
        deps.onError?.('roomMessages.history', error)
      })
  }

  return {
    setUser(next): void {
      const id = next || null
      if (id === userId) return

      generation += 1
      const mine = generation

      close?.()
      close = null
      userId = id
      messages = []
      deps.onChange?.()

      if (!id) return

      void deps.channel
        .open(id, {
          onMessage: (row) => receive(row, mine),
          onStatus: (status) => {
            if (status === 'error') deps.onError?.('roomMessages.subscribe', status)
          },
        })
        .then((unsubscribe) => {
          if (mine !== generation) {
            unsubscribe()
            return
          }
          close = unsubscribe
          // Subscribed first, then fetched: a message sent in between is
          // delivered live and folded in by id rather than missed.
          if (channel) fetchHistory(channel, mine)
        })
        .catch((error) => {
          /*
           * Realtime is down. Presence is not, so the room still shows who is
           * in it - there is simply nothing landing. Enrichment failing must
           * never take the social map with it.
           */
          deps.onError?.('roomMessages.subscribe', error)
        })
    },

    setChannel(next): void {
      const login = next ? next.trim().toLowerCase() : null
      const changed = login !== channel
      channel = login

      if (changed) {
        // A conversation belongs to the stream it happened on.
        messages = []
        deps.onChange?.()
      }

      if (!login || !userId) return
      // Re-fetched even when the channel did not change: this is what makes a
      // page refresh, or a worker that was evicted and came back, recover the
      // conversation rather than start an empty one.
      fetchHistory(login, generation)
    },

    send(body): void {
      const here = channel
      const text = body.trim()
      if (!here || text.length === 0) return

      void deps.backend.send(here, text).catch((error) => {
        /*
         * Nothing is drawn optimistically.
         *
         * The sender's own copy comes back through the same inbox as everyone
         * else's, so a message that the server declined does not appear for
         * the one person who could not otherwise tell.
         */
        deps.onError?.('roomMessages.send', error)
      })
    },

    snapshot(): RoomMessage[] {
      const live = pruneMessages(messages, now())
      if (live.length !== messages.length) messages = live
      return messages
    },

    reset(): void {
      generation += 1
      close?.()
      close = null
      userId = null
      channel = null
      messages = []
      deps.onChange?.()
    },

    subscribedTo: () => userId,
  }
}
