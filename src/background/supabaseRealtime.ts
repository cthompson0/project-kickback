import type { SupabaseClient } from '@supabase/supabase-js'
import type { SocialChannel, SocialChannelHandlers } from './socialSync'
import type { PresenceChannel, PresenceChannelHandlers } from './presenceSync'
import { toPresence } from './supabaseBackend'
import type { MessageRow } from './supabaseBackend'
import type { GroupChannel, GroupChannelHandlers } from './groupSync'

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
const GROUP_PREFIX = 'kickback-groups'

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

/**
 * Group chat and membership.
 *
 * One binding per group, filtered `group_id=eq.<id>`. RLS still decides
 * delivery, which is what makes removal take effect on an already-open
 * subscription: the moment membership ends, the server stops sending. The
 * filter is belt and braces on top of that, and closes the DELETE gap.
 *
 * Membership and invite changes are invalidation only - they carry no payload
 * we act on, they just mean "re-read the group list".
 */
export function createSupabaseGroupChannel(supabase: SupabaseClient): GroupChannel {
  return {
    async open(groupIds: string[], userId: string, handlers: GroupChannelHandlers) {
      const { data } = await supabase.auth.getSession()
      const accessToken = data.session?.access_token
      if (accessToken) {
        await supabase.realtime.setAuth(accessToken)
      }

      const channel = supabase.channel(`${GROUP_PREFIX}:${userId}:${groupIds.length}`)

      for (const groupId of groupIds) {
        channel.on(
          'postgres_changes',
          {
            event: 'INSERT',
            schema: 'public',
            table: 'group_messages',
            filter: `group_id=eq.${groupId}`,
          },
          (payload: { new?: unknown }) => {
            const row = payload.new as MessageRow | undefined
            if (!row || typeof row.message_id !== 'string') {
              // The realtime row is the raw table shape, not the RPC shape:
              // it has `id`, and no display name. Re-read handles the rest.
              const raw = payload.new as
                | { id?: string; group_id?: string; user_id?: string; body?: string; created_at?: string }
                | undefined
              if (!raw?.id || !raw.group_id) return
              handlers.onRawMessage({
                id: raw.id,
                groupId: raw.group_id,
                userId: raw.user_id ?? '',
                body: raw.body ?? '',
                createdAt: raw.created_at ?? new Date().toISOString(),
              })
              return
            }
            handlers.onRawMessage({
              id: row.message_id,
              groupId: row.group_id,
              userId: row.user_id,
              body: row.body,
              createdAt: row.created_at,
            })
          },
        )
      }

      // Membership and invitations: re-read rather than interpret.
      channel.on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'group_members', filter: `user_id=eq.${userId}` },
        () => handlers.onMembershipChanged(),
      )
      channel.on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'group_invites', filter: `to_user=eq.${userId}` },
        () => handlers.onMembershipChanged(),
      )

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
