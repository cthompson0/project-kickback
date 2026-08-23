import type { SupabaseClient } from '@supabase/supabase-js'
import type { SocialChannel, SocialChannelHandlers } from './socialSync'

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
