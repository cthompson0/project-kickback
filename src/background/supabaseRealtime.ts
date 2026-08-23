import type { SupabaseClient } from '@supabase/supabase-js'
import type { SocialChannel, SocialChannelHandlers } from './socialSync'
import type { PresenceChannel, PresenceChannelHandlers } from './presenceSync'
import { toPresence } from './supabaseBackend'

/**
 * Supabase Realtime, used narrowly for social-graph invalidation.
 *
 * Two safeguards worth spelling out:
 *
 * 1. Every subscription carries a server-side `filter` pinning rows to this
 *    user. RLS already restricts what a client may *read*, but Supabase does
 *    not apply RLS to DELETE events - a delete only carries primary-key
 *    columns. Without these filters a client would receive the key pairs of
 *    other people's friendship deletions. The filters mean the server never
 *    sends them in the first place.
 *
 * 2. Payloads are discarded. The handler is a bare "something changed" signal;
 *    the actual data is re-read through the authorized RPCs.
 */

const CHANNEL_PREFIX = 'kickback-social'
const PRESENCE_PREFIX = 'kickback-presence'

export function createSupabaseSocialChannel(supabase: SupabaseClient): SocialChannel {
  return {
    async open(userId: string, handlers: SocialChannelHandlers): Promise<() => void> {
      // The socket must carry this user's JWT or RLS will reject the
      // subscription. Set it before subscribing, not after.
      const { data } = await supabase.auth.getSession()
      const accessToken = data.session?.access_token
      if (accessToken) {
        await supabase.realtime.setAuth(accessToken)
      }

      const channel = supabase.channel(`${CHANNEL_PREFIX}:${userId}`)
      const bump = () => handlers.onEvent()

      channel
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'friendships', filter: `user_id=eq.${userId}` },
          bump,
        )
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'friend_requests', filter: `to_user=eq.${userId}` },
          bump,
        )
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'friend_requests',
            filter: `from_user=eq.${userId}`,
          },
          bump,
        )
        .subscribe((status) => {
          switch (status) {
            case 'SUBSCRIBED':
              handlers.onStatus('connected')
              break
            case 'CHANNEL_ERROR':
            case 'TIMED_OUT':
              handlers.onStatus('error')
              break
            default:
              // CLOSED and anything new: treat as not connected but not fatal.
              break
          }
        })

      return () => {
        void supabase.removeChannel(channel)
      }
    },
  }
}

/**
 * Friends' presence.
 *
 * One binding per friend, each pinned with `user_id=eq.<friend>`. That is what
 * makes it safe to use the payloads directly instead of re-reading: the server
 * only sends rows this user is entitled to, including for deletes, which
 * Supabase does not run RLS against.
 */
export function createSupabasePresenceChannel(supabase: SupabaseClient): PresenceChannel {
  return {
    async open(friendIds: string[], handlers: PresenceChannelHandlers): Promise<() => void> {
      const { data } = await supabase.auth.getSession()
      const accessToken = data.session?.access_token
      if (accessToken) {
        await supabase.realtime.setAuth(accessToken)
      }

      const channel = supabase.channel(`${PRESENCE_PREFIX}:${friendIds.length}:${friendIds[0]}`)

      for (const friendId of friendIds) {
        channel.on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'presence', filter: `user_id=eq.${friendId}` },
          (payload: { eventType?: string; new?: unknown; old?: unknown }) => {
            if (payload.eventType === 'DELETE') {
              handlers.onPresenceGone(friendId)
              return
            }
            const row = payload.new as Parameters<typeof toPresence>[0] | undefined
            if (!row || typeof row.user_id !== 'string') return
            handlers.onPresence(toPresence(row))
          },
        )
      }

      channel.subscribe((status) => {
        switch (status) {
          case 'SUBSCRIBED':
            handlers.onStatus('connected')
            break
          case 'CHANNEL_ERROR':
          case 'TIMED_OUT':
            handlers.onStatus('error')
            break
          default:
            break
        }
      })

      return () => {
        void supabase.removeChannel(channel)
      }
    },
  }
}
