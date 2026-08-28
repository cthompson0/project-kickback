import type { SupabaseClient } from '@supabase/supabase-js'
import type { SocialChannel, SocialChannelHandlers } from './socialSync'
import type { PresenceChannel, PresenceChannelHandlers } from './presenceSync'
import { toPresence } from './supabaseBackend'
import type { ReactionChannel, ReactionChannelHandlers } from './togetherReactions'
import type { RoomMessageChannel, RoomMessageChannelHandlers } from './roomMessages'
import type { MessageRow } from './supabaseBackend'
import type { GroupChannel, GroupChannelHandlers } from './groupSync'
import { createTopicGate, topicFor } from './realtimeTopics'

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
const TOGETHER_PREFIX = 'kickback-together'
const ROOM_PREFIX = 'kickback-room'

/*
 * One gate for every channel this module opens.
 *
 * Module scope rather than per-factory, because the thing being serialised is
 * the supabase-js channel registry, and there is one of those. Two subscription
 * managers that happen to name the same topic must queue behind each other even
 * though neither knows the other exists.
 *
 * See realtimeTopics.ts for why this is needed at all.
 */
const gate = createTopicGate()

/**
 * Subscribe, and remember how to unsubscribe.
 *
 * Every channel in this file goes through here so that the two rules are
 * applied in one place rather than five: wait for any pending teardown of the
 * same topic before asking for it, and hand back a close that a later open can
 * actually wait for.
 */
async function openChannel(
  supabase: SupabaseClient,
  topic: string,
  bind: (channel: ReturnType<SupabaseClient['channel']>) => void,
  onStatus: (status: 'connected' | 'error') => void,
): Promise<() => void> {
  // The socket must carry this user's JWT or RLS will reject the
  // subscription. Set it before subscribing, not after.
  const { data } = await supabase.auth.getSession()
  const accessToken = data.session?.access_token
  if (accessToken) {
    await supabase.realtime.setAuth(accessToken)
  }

  return gate.enter(topic, async () => {
    const channel = supabase.channel(topic)
    bind(channel)
    channel.subscribe((status: string) => {
      switch (status) {
        case 'SUBSCRIBED':
          onStatus('connected')
          break
        case 'CHANNEL_ERROR':
        case 'TIMED_OUT':
          onStatus('error')
          break
        default:
          // CLOSED and anything new: not connected, but not fatal either.
          break
      }
    })

    return () => {
      // Registered with the gate rather than fired and forgotten, so the next
      // open of this topic waits for the registry slot to be free.
      void gate.leave(topic, Promise.resolve(supabase.removeChannel(channel)))
    }
  })
}

export function createSupabaseSocialChannel(supabase: SupabaseClient): SocialChannel {
  return {
    async open(userId: string, handlers: SocialChannelHandlers): Promise<() => void> {
      const bump = () => handlers.onEvent()

      return openChannel(supabase, `${CHANNEL_PREFIX}:${userId}`, (channel) => {
        channel
          .on(
          'postgres_changes',
            { event: '*', schema: 'public', table: 'friendships', filter: `user_id=eq.${userId}` },
            bump,
          )
          .on(
            'postgres_changes',
            {
              event: '*',
              schema: 'public',
              table: 'friend_requests',
              filter: `to_user=eq.${userId}`,
            },
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
      }, handlers.onStatus)
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
      /*
       * The topic names the SET, not its size.
       *
       * It used to be `<count>:<first id>`, so two different friend sets of
       * equal size that happened to share a first member collided on one
       * topic - and supabase-js keys its registry by topic. See
       * realtimeTopics.ts.
       */
      return openChannel(
        supabase,
        topicFor(PRESENCE_PREFIX, 'friends', friendIds),
        (channel) => {
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
        },
        handlers.onStatus,
      )
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
/**
 * The viewer's reaction inbox.
 *
 * ONE ROW, ONE SUBSCRIBER - which is the whole of the one-way reaction fix.
 *
 * 0019 gave every viewer on a stream the SAME topic and the SAME filter, so a
 * single inserted row matched MANY subscriptions. That is the exact condition
 * for a documented hosted-only Supabase defect where only the most recently
 * created subscription receives the row: whoever subscribed last got
 * reactions, and the other side got nothing.
 *
 * Presence never hit it because it binds one subscription per friend, so every
 * presence row has exactly one interested subscriber. This now has the same
 * property - the server writes one row per recipient (0020) and each viewer
 * subscribes only to their own, on a topic named after themselves, matching
 * every other realtime topic in this file.
 *
 * Authorization moved with it: the row policy is `recipient_id = auth.uid()`,
 * because who may see a reaction was decided when it was written.
 *
 * Inserts only. There is no history to load and no update to apply.
 */
export function createSupabaseTogetherChannel(supabase: SupabaseClient): ReactionChannel {
  return {
    async open(userId: string, handlers: ReactionChannelHandlers): Promise<() => void> {
      return openChannel(
        supabase,
        `${TOGETHER_PREFIX}:${userId}`,
        (channel) => {
          channel.on(
            'postgres_changes',
            {
              event: 'INSERT',
              schema: 'public',
              table: 'together_reactions',
              filter: `recipient_id=eq.${userId}`,
            },
            (payload: { new?: unknown }) => {
              if (payload.new) handlers.onReaction(payload.new)
            },
          )
        },
        handlers.onStatus,
      )
    },
  }
}

/**
 * Ephemeral room messages, on the same per-user shape as reactions.
 *
 * A separate channel rather than a second listener on the together one, so
 * that a room with no conversation in it costs nothing extra and a failure
 * in one does not take the other down. Both filter on this user's own id,
 * which is what gives every row exactly one interested subscriber.
 *
 * The payload IS used here, unlike the social channel: authorization already
 * happened when the row was written, so there is nothing to re-read through
 * an RPC and a round trip per message would be latency on a conversation.
 * It is still parsed rather than trusted - see core/roomMessages.ts.
 */
export function createSupabaseRoomMessageChannel(supabase: SupabaseClient): RoomMessageChannel {
  return {
    async open(userId: string, handlers: RoomMessageChannelHandlers): Promise<() => void> {
      return openChannel(
        supabase,
        `${ROOM_PREFIX}:${userId}`,
        (channel) => {
          channel.on(
            'postgres_changes',
            {
              event: 'INSERT',
              schema: 'public',
              table: 'room_messages',
              filter: `recipient_id=eq.${userId}`,
            },
            (payload: { new?: unknown }) => {
              if (payload.new) handlers.onMessage(payload.new)
            },
          )
        },
        handlers.onStatus,
      )
    },
  }
}
export function createSupabaseGroupChannel(supabase: SupabaseClient): GroupChannel {
  return {
    async open(groupIds: string[], userId: string, handlers: GroupChannelHandlers) {
      /*
       * The topic names the SET of groups, not how many there are.
       *
       * It used to be `<user>:<count>`, which meant every one-group state
       * shared a topic - so leaving one group and joining another asked
       * supabase-js for a name it still had registered, and a retry after
       * CHANNEL_ERROR asked for the one it was mid-way through removing. The
       * gate in openChannel closes the second half of that; this closes the
       * first. See realtimeTopics.ts.
       *
       * This is hardening on its own merits. It is NOT a claimed fix for the
       * unresolved group participation incident - see
       * docs/reports/friends-beta-investigation-2026-08-27.md §2.
       */
      return openChannel(
        supabase,
        topicFor(GROUP_PREFIX, userId, groupIds),
        (channel) => {
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
                    | {
                        id?: string
                        group_id?: string
                        user_id?: string
                        body?: string
                        created_at?: string
                      }
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
            {
              event: '*',
              schema: 'public',
              table: 'group_members',
              filter: `user_id=eq.${userId}`,
            },
            () => handlers.onMembershipChanged(),
          )
          channel.on(
            'postgres_changes',
            {
              event: '*',
              schema: 'public',
              table: 'group_invites',
              filter: `to_user=eq.${userId}`,
            },
            () => handlers.onMembershipChanged(),
          )
        },
        handlers.onStatus,
      )
    },
  }
}
