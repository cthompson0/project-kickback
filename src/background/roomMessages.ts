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
  /** Every realtime transition, not only failures. See core/failures.ts. */
  onStatus?: (status: 'connected' | 'error') => void
  /** A message arrived, for unread and analytics. Includes the viewer's own. */
  onMessage?: (message: RoomMessage, mine: boolean) => void
  now?: () => number
  onError?: (context: string, error: unknown) => void
}

export interface RoomMessages {
  /** Who the inbox belongs to, or null when signed out. Idempotent. */
  setUser(userId: string | null): void
  /**
   * Every destination the viewer currently has open.
   *
   * A SET rather than a channel, because a person with two streams open is in
   * two conversations at once and neither may clear the other. Every message
   * already carries its own channel, so the buffer needs no partitioning - what
   * changed is that it is no longer emptied when the viewer looks elsewhere.
   *
   * Messages for a destination that has closed are dropped, since nothing can
   * render them any more. Everything else is kept and ages out on the same
   * thirty-minute retention clock it always did.
   *
   * A destination that is present again - a refresh, a worker eviction and
   * restore - is re-fetched, which is what makes a conversation come back
   * rather than start empty.
   */
  setChannels(channels: readonly string[]): void
  /** The destinations currently followed, for tests and diagnostics. */
  channels(): readonly string[]
  /** Send one, naming the room. Fire-and-forget; failure is logged. */
  send(channel: string | null, body: string): void
  /** Everything still worth showing, oldest first. */
  snapshot(): RoomMessage[]
  reset(): void
  /** For tests and diagnostics. */
  subscribedTo(): string | null
}

export function createRoomMessages(deps: RoomMessagesDeps): RoomMessages {
  const now = deps.now ?? (() => Date.now())

  let userId: string | null = null
  let channels: string[] = []
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
    if (!channels.includes(message.channel)) return

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
        if (mine !== generation || !channels.includes(forChannel)) return
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
            if (mine !== generation) return
            deps.onStatus?.(status)
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
          // delivered live and folded in by id rather than missed. Every open
          // destination, because the viewer may already have several.
          for (const login of channels) fetchHistory(login, mine)
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

    setChannels(next): void {
      const wanted = [...new Set(next.map((entry) => entry.trim().toLowerCase()))].filter(
        (entry) => entry.length > 0,
      )
      const previous = channels
      channels = wanted

      /*
       * Drop only what has genuinely gone.
       *
       * This is the whole of the multi-room change on the read side: closing a
       * stream forgets its conversation, and looking at a different one does
       * not. Before, ANY change emptied the buffer, so switching tabs threw
       * away a conversation the server was still perfectly willing to serve.
       */
      const live = new Set(wanted)
      const kept = messages.filter((message) => live.has(message.channel))
      if (kept.length !== messages.length) {
        messages = kept
        deps.onChange?.()
      } else if (previous.length !== wanted.length) {
        deps.onChange?.()
      }

      if (!userId) return
      /*
       * Re-fetched for every live destination, not only the new ones.
       *
       * A page refresh and a worker restore both arrive here, and both need
       * the conversation back rather than an empty one. The fetch merges by
       * row id, so asking again for something already held costs one request
       * and changes nothing on screen.
       */
      for (const login of wanted) fetchHistory(login, generation)
    },

    channels: () => channels,

    send(channel, body): void {
      // The caller names the room. With several open, "the current channel" is
      // not a question the worker can answer for one particular tab.
      const here = channel ? channel.trim().toLowerCase() : null
      const text = body.trim()
      if (!here || text.length === 0) return
      // Only somewhere the viewer actually has open. The server checks this too
      // and is the authority; refusing here saves a round trip.
      if (!channels.includes(here)) return

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
      channels = []
      messages = []
      deps.onChange?.()
    },

    subscribedTo: () => userId,
  }
}
