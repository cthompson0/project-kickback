import type { SimActivity, SimChannelMeta, SimUser, SimVisibility, SimWorld } from './world'

/**
 * Deterministic starting worlds.
 *
 * A preset configures PEOPLE. It never reaches past the presence row, so
 * "5-Friend Gravity" is a claim about who is watching what, not a claim about
 * what the panel will draw - the panel's answer is production's to give, and
 * the point of clicking the preset is to find out whether it agrees.
 *
 * Everything here is a pure function of nothing, so the same button always
 * produces the same world and a bug is reproducible by name.
 */

/** Convenient labels for local simulation. No Twitch API is ever called. */
export const CHANNELS = ['LIRIK', 'xQc', 'LVNDMARK', 'summit1g', 'shroud']

const ROSTER = [
  ['b', 'lirik_fan_b', 'Bianca'],
  ['c', 'chuck_c', 'Chuck'],
  ['d', 'dana_d', 'Dana'],
  ['e', 'eli_e', 'Eli'],
  ['f', 'faye_f', 'Faye'],
  ['g', 'gus_g', 'Gus'],
  ['h', 'hana_h', 'Hana'],
  ['i', 'ivo_i', 'Ivo'],
  ['j', 'jun_j', 'Jun'],
  ['k', 'kit_k', 'Kit'],
] as const

export const OBSERVER = {
  id: 'observer-a',
  login: 'anoteros_a',
  displayName: 'Anoteros (you)',
  channel: null,
  visibility: 'visible' as SimVisibility,
}

interface PersonOptions {
  activity?: SimActivity
  channel?: string
  visibility?: SimVisibility
  relationship?: SimUser['relationship']
  staleForMs?: number
  activeForMs?: number
}

/** One simulated person. Defaults to a friend who is around but not watching. */
export function person(index: number, options: PersonOptions = {}): SimUser {
  const [id, login, displayName] = ROSTER[index % ROSTER.length]
  return {
    id: `sim-${id}`,
    login,
    displayName,
    relationship: options.relationship ?? 'friend',
    activity: options.activity ?? 'around',
    channel: options.channel ?? '',
    visibility: options.visibility ?? 'visible',
    staleForMs: options.staleForMs ?? 0,
    // A couple of minutes in, so "watching for 2m" reads like a real session
    // rather than everyone having arrived on the same millisecond.
    activeForMs: options.activeForMs ?? 2 * 60_000,
  }
}

/** N friends all watching the same channel - the Gravity shape. */
function crowd(count: number, channel: string, from = 0): SimUser[] {
  return Array.from({ length: count }, (_, index) =>
    person(from + index, { activity: 'watching', channel }),
  )
}

function world(
  users: SimUser[],
  observerChannel: string | null = null,
  metadata?: Record<string, SimChannelMeta>,
  edges?: Array<[string, string]>,
): SimWorld {
  return {
    observer: { ...OBSERVER, channel: observerChannel },
    users,
    metadata,
    edges,
    clockOffsetMs: 0,
  }
}

/**
 * A person who is on the channel but NOT the observer's friend.
 *
 * The whole point of a connected component: they can still be in the room, if
 * a real social path reaches them. Presence for them never arrives - they are
 * a stranger as far as presence is concerned - so the roster names them from
 * room membership alone, which is exactly the production situation.
 */
const distant = (index: number, channel: string): SimUser =>
  person(index, { activity: 'watching', channel, relationship: 'stranger' })

/** The simulated roster's ids, so edges can be written readably. */
const ID = ROSTER.map(([id]) => `sim-${id}`)

/** A plausible live stream, so metadata presets read like the real thing. */
const LIVE: SimChannelMeta = {
  live: 'live',
  displayName: 'LIRIK',
  gameName: 'Escape from Tarkov',
  title: 'late night wipe grind - !discord !settings',
  viewerCount: 18_412,
}

/*
 * LIRIK is streaming.
 *
 * Every room preset carries this, because an automatic Stream Room requires a
 * live stream - see core/socialViewing.ts. Before that rule existed the
 * presets said nothing about metadata and rooms formed anyway, which is
 * exactly the bug: presence alone was taken as watching.
 */
const LIVE_LIRIK: Record<string, SimChannelMeta> = { lirik: LIVE }

export interface Preset {
  id: string
  label: string
  /** One line on what this is for, shown beside the button. */
  hint: string
  build: () => SimWorld
}

export const PRESETS: Preset[] = [
  {
    id: 'empty',
    label: 'Empty',
    hint: 'No friends at all - the first-run panel.',
    build: () => world([]),
  },
  {
    id: 'one',
    label: '1 friend watching',
    hint: 'A destination with no gathering: a card, no flame.',
    build: () => world(crowd(1, 'LIRIK')),
  },
  {
    id: 'two',
    label: '2-friend Gravity',
    hint: 'The threshold. Flame and the heavier card appear here.',
    build: () => world(crowd(2, 'LIRIK')),
  },
  {
    id: 'three',
    label: '3-friend Gravity',
    hint: 'A gathering that is clearly a gathering.',
    build: () => world(crowd(3, 'LIRIK')),
  },
  {
    id: 'five',
    label: '5-friend Gravity',
    hint: 'Where the people row starts having to wrap.',
    build: () => world(crowd(5, 'LIRIK')),
  },
  {
    id: 'ten',
    label: '10-friend stress',
    hint: 'Every simulated person on one channel. Watch the narrow panel.',
    build: () => world(crowd(10, 'LIRIK')),
  },
  {
    id: 'competing',
    label: 'Two competing clusters',
    hint: 'LIRIK 3 / xQc 2. Ranking should put the bigger one first.',
    build: () => world([...crowd(3, 'LIRIK'), ...crowd(2, 'xQc', 3)]),
  },
  {
    id: 'here',
    label: 'Watching with you',
    hint: 'You are on LIRIK with three friends: HERE, no JOIN, you uncounted.',
    build: () => world(crowd(3, 'LIRIK'), 'LIRIK'),
  },
  {
    id: 'privacy',
    label: 'Privacy mix',
    hint: 'Same channel, three settings. Only the visible one may name it.',
    build: () =>
      world([
        person(0, { activity: 'watching', channel: 'LIRIK' }),
        person(1, { activity: 'watching', channel: 'LIRIK', visibility: 'hide_activity' }),
        person(2, { activity: 'watching', channel: 'LIRIK', visibility: 'invisible' }),
      ]),
  },
  {
    id: 'quiet',
    label: 'Around + offline mix',
    hint: 'The quiet sections, plus one destination to rank above them.',
    build: () =>
      world([
        person(0, { activity: 'watching', channel: 'LIRIK' }),
        person(1, { activity: 'around' }),
        person(2, { activity: 'around' }),
        person(3, { activity: 'offline' }),
        person(4, { activity: 'offline' }),
      ]),
  },
  {
    id: 'split',
    label: 'Cluster split / reform',
    hint: 'Three on LIRIK. Move one to xQc and back, and watch it re-form.',
    build: () => world([...crowd(3, 'LIRIK'), ...crowd(2, 'xQc', 3)]),
  },
  {
    id: 'casing',
    label: 'Casing mix',
    hint: 'LVNDMARK and lvndmark: one cluster of two, drawn in Twitch casing.',
    build: () =>
      world([
        person(0, { activity: 'watching', channel: 'LVNDMARK' }),
        person(1, { activity: 'watching', channel: 'lvndmark' }),
        person(2, { activity: 'watching', channel: 'xQc' }),
      ]),
  },
  {
    id: 'stale',
    label: 'Stale heartbeat',
    hint: 'Two on LIRIK, one already 2 minutes silent. Advance time to drop them.',
    build: () =>
      world([
        person(0, { activity: 'watching', channel: 'LIRIK' }),
        person(1, { activity: 'watching', channel: 'LIRIK', staleForMs: 120_000 }),
      ]),
  },
  // ------------------------------------------------------ metadata states
  {
    id: 'meta-live',
    label: 'Live creator',
    hint: 'Avatar, category, title, LIVE badge and viewers on a 3-friend card.',
    build: () => world(crowd(3, 'LIRIK'), null, { lirik: LIVE }),
  },
  {
    id: 'meta-offline',
    label: 'Offline creator',
    hint: 'Twitch says the stream ended. The card stays, marked, and sinks.',
    build: () =>
      world([...crowd(3, 'LIRIK'), ...crowd(1, 'xQc', 3)], null, {
        lirik: { live: 'offline', displayName: 'LIRIK' },
        xqc: { live: 'live', displayName: 'xQc', gameName: 'Just Chatting', viewerCount: 40_120 },
      }),
  },
  {
    id: 'meta-unavailable',
    label: 'Metadata unavailable',
    hint: 'Backend down, or nothing asked yet. Must look exactly like no metadata.',
    build: () => world(crowd(3, 'LIRIK'), null, { lirik: { live: 'unavailable' } }),
  },
  {
    id: 'meta-long',
    label: 'Long title + category',
    hint: 'Both must clamp to one line and never push JOIN off the card.',
    build: () =>
      world(crowd(2, 'LIRIK'), null, {
        lirik: {
          ...LIVE,
          gameName: 'Dungeons and Dragons Online: Stormreach Anniversary Edition',
          title:
            'day 412 of asking chat to stop backseating while I attempt the impossible ' +
            'no-hit run with viewer-chosen handicaps !commands !socials !merch',
        },
      }),
  },
  {
    id: 'meta-no-avatar',
    label: 'Missing avatar',
    hint: 'No image at all, and a broken one. Both must leave the head intact.',
    build: () =>
      world([...crowd(2, 'LIRIK'), ...crowd(1, 'xQc', 2)], null, {
        lirik: { ...LIVE, avatar: 'missing' },
        xqc: { live: 'live', displayName: 'xQc', avatar: 'broken', gameName: 'Just Chatting' },
      }),
  },
  {
    id: 'meta-mixed',
    label: 'Mixed live / offline',
    hint: 'Live, offline and unknown together. Only the offline one is demoted.',
    build: () =>
      world([...crowd(4, 'LIRIK'), ...crowd(2, 'xQc', 4), ...crowd(1, 'shroud', 6)], null, {
        lirik: { live: 'offline', displayName: 'LIRIK' },
        xqc: { live: 'live', displayName: 'xQc', gameName: 'Just Chatting', viewerCount: 40_120 },
        // shroud deliberately has no entry: an unknown destination must rank
        // with the live ones, not with the offline one.
      }),
  },
  {
    id: 'meta-casing',
    label: 'Authoritative casing',
    hint: 'Nobody here has opened LVNDMARK. Only metadata can spell it.',
    build: () =>
      world([...crowd(2, 'lvndmark')], null, {
        lvndmark: { live: 'live', displayName: 'LVNDMARK', gameName: 'Escape from Tarkov' },
      }),
  },
  {
    id: 'meta-here',
    label: 'HERE, stream ended',
    hint: 'You are on it, three friends with you, and Twitch says it stopped.',
    build: () =>
      world(crowd(3, 'LIRIK'), 'LIRIK', { lirik: { live: 'offline', displayName: 'LIRIK' } }),
  },

  // ------------------------------------------------ connected-component rooms
  //
  // The graphs two Twitch accounts cannot build. Every one of these is a claim
  // about who is in the ROOM, which production computes from the friendship
  // graph and presence - the lab supplies both and never the answer.
  {
    id: 'room-ab',
    label: 'Room · A↔B',
    hint: 'You and one direct friend. The smallest room there is.',
    build: () => world(crowd(1, 'LIRIK'), 'LIRIK', LIVE_LIRIK),
  },
  {
    id: 'room-abc',
    label: 'Room · A↔B↔C',
    hint: 'C is Bianca\'s friend, not yours. You should still see them.',
    build: () =>
      world([person(0, { activity: 'watching', channel: 'LIRIK' }), distant(1, 'LIRIK')], 'LIRIK', LIVE_LIRIK, [
        [ID[0], ID[1]],
      ]),
  },
  {
    id: 'room-abcd',
    label: 'Room · A↔B↔C↔D',
    hint: 'Three hops. D is at the limit and reachable; nobody is beyond it.',
    build: () =>
      world(
        [
          person(0, { activity: 'watching', channel: 'LIRIK' }),
          distant(1, 'LIRIK'),
          distant(2, 'LIRIK'),
        ],
        'LIRIK',
        LIVE_LIRIK,
        [
          [ID[0], ID[1]],
          [ID[1], ID[2]],
        ],
      ),
  },
  {
    id: 'room-split-graphs',
    label: 'Room · two clusters',
    hint: 'You+Bianca, and Dana↔Eli who know neither of you. Two rooms; you see one.',
    build: () =>
      world(
        [
          person(0, { activity: 'watching', channel: 'LIRIK' }),
          distant(2, 'LIRIK'),
          distant(3, 'LIRIK'),
        ],
        'LIRIK',
        LIVE_LIRIK,
        [[ID[2], ID[3]]],
      ),
  },
  {
    id: 'room-bridge-gone',
    label: 'Room · bridge left',
    hint: 'A↔B↔C↔D with B gone. You are alone; C and D are still each other\'s.',
    build: () =>
      world(
        [
          // Bianca (the bridge) has moved to another stream.
          person(0, { activity: 'watching', channel: 'xQc' }),
          distant(1, 'LIRIK'),
          distant(2, 'LIRIK'),
        ],
        'LIRIK',
        LIVE_LIRIK,
        [
          [ID[0], ID[1]],
          [ID[1], ID[2]],
        ],
      ),
  },
  {
    id: 'room-merged',
    label: 'Room · clusters merged',
    hint: 'The same two clusters, now bridged by Bianca↔Dana. One room of four.',
    build: () =>
      world(
        [
          person(0, { activity: 'watching', channel: 'LIRIK' }),
          distant(2, 'LIRIK'),
          distant(3, 'LIRIK'),
        ],
        'LIRIK',
        LIVE_LIRIK,
        [
          [ID[2], ID[3]],
          // The bridge that merges them.
          [ID[0], ID[2]],
        ],
      ),
  },
  {
    id: 'room-stranger',
    label: 'Room · unrelated stranger',
    hint: 'Faye is on LIRIK and connected to nobody. Invisible to the room.',
    build: () =>
      world([person(0, { activity: 'watching', channel: 'LIRIK' }), distant(4, 'LIRIK')], 'LIRIK', LIVE_LIRIK),
  },
  {
    id: 'room-fof-left',
    label: 'Room · friend-of-friend left',
    hint: 'C moved to xQc. Contextual visibility of them disappears.',
    build: () =>
      world(
        [person(0, { activity: 'watching', channel: 'LIRIK' }), distant(1, 'xQc')],
        'LIRIK',
        LIVE_LIRIK,
        [[ID[0], ID[1]]],
      ),
  },
  {
    id: 'room-ten',
    label: 'Room · 10 people',
    hint: 'A chain of ten. Only three hops are reachable, by design.',
    build: () =>
      world(
        Array.from({ length: 9 }, (_, index) =>
          index === 0
            ? person(0, { activity: 'watching', channel: 'LIRIK' })
            : distant(index, 'LIRIK'),
        ),
        'LIRIK',
        LIVE_LIRIK,
        Array.from({ length: 8 }, (_, index) => [ID[index], ID[index + 1]] as [string, string]),
      ),
  },

  // ------------------------------------------- rooms need a live stream
  //
  // The bug this checkpoint began with: two accounts on twitch.tv/lirik with
  // no stream running, and Watchside saying HERE · OFFLINE · 1 friend watching
  // with you - with a room, reactions and an open watching-together interval
  // behind it. These three presets are the same world with three different
  // answers from Twitch, so the difference is visible in one click.
  {
    id: 'room-offline',
    label: 'Room · stream ended',
    hint: 'You and a friend on LIRIK, which is offline. Presence yes; room no.',
    build: () =>
      world(crowd(1, 'LIRIK'), 'LIRIK', {
        lirik: { live: 'offline', displayName: 'LIRIK' },
      }),
  },
  {
    id: 'room-unknown',
    label: 'Room · Twitch has not answered',
    hint: 'Metadata unavailable. Uncertain is not live: no room forms.',
    build: () =>
      world(crowd(1, 'LIRIK'), 'LIRIK', { lirik: { live: 'unavailable' } }),
  },
  {
    id: 'room-went-live',
    label: 'Room · just went live',
    hint: 'The same people, now with a stream. Compare against the two above.',
    build: () => world(crowd(1, 'LIRIK'), 'LIRIK', LIVE_LIRIK),
  },

  // ---------------------------------------------------- automatic together
  {
    id: 'together-1',
    label: 'Together · 1 friend',
    hint: 'You and one friend on LIRIK. The smallest Together there is.',
    build: () => world(crowd(1, 'LIRIK'), 'LIRIK', LIVE_LIRIK),
  },
  {
    id: 'together-2',
    label: 'Together · 2 friends',
    hint: 'You and two. Enough for a reaction to become a combo.',
    build: () => world(crowd(2, 'LIRIK'), 'LIRIK', LIVE_LIRIK),
  },
  {
    id: 'together-5',
    label: 'Together · 5 friends',
    hint: 'Where the people row wraps and the reaction bar must still fit.',
    build: () => world(crowd(5, 'LIRIK'), 'LIRIK', LIVE_LIRIK),
  },
  {
    id: 'together-10',
    label: 'Together · 10 friends',
    hint: 'Every simulated person, with you. Watch the narrow panel.',
    build: () => world(crowd(10, 'LIRIK'), 'LIRIK', LIVE_LIRIK),
  },
  {
    id: 'together-live',
    label: 'Together · live metadata',
    hint: 'The full card: avatar, category, LIVE, viewers, people, reactions.',
    build: () => world(crowd(3, 'LIRIK'), 'LIRIK', { lirik: LIVE }),
  },
  {
    id: 'together-alone',
    label: 'Together · nobody yet',
    hint: 'You are on LIRIK; your friends are elsewhere. No Together at all.',
    build: () => world([...crowd(2, 'xQc'), ...crowd(1, 'shroud', 2)], 'LIRIK'),
  },
  {
    id: 'together-graphs',
    label: 'Together · competing graphs',
    hint: 'Two of your friends are on LIRIK; the strangers there are invisible.',
    build: () =>
      world(
        [
          ...crowd(2, 'LIRIK'),
          // Not your friends. Same channel, different social graph - they must
          // not appear, and their reactions must never arrive.
          person(2, { activity: 'watching', channel: 'LIRIK', relationship: 'stranger' }),
          person(3, { activity: 'watching', channel: 'LIRIK', relationship: 'stranger' }),
        ],
        'LIRIK',
      ),
  },
  {
    id: 'together-privacy',
    label: 'Together · privacy mix',
    hint: 'One visible, one hiding, one invisible - all on your channel.',
    build: () =>
      world(
        [
          person(0, { activity: 'watching', channel: 'LIRIK' }),
          person(1, { activity: 'watching', channel: 'LIRIK', visibility: 'hide_activity' }),
          person(2, { activity: 'watching', channel: 'LIRIK', visibility: 'invisible' }),
        ],
        'LIRIK',
      ),
  },
  {
    id: 'together-stale',
    label: 'Together · stale friend',
    hint: 'One friend went quiet two minutes ago. Advance time to lose them.',
    build: () =>
      world(
        [
          person(0, { activity: 'watching', channel: 'LIRIK' }),
          person(1, { activity: 'watching', channel: 'LIRIK', staleForMs: 120_000 }),
        ],
        'LIRIK',
      ),
  },

  {
    id: 'requests',
    label: 'Requests + strangers',
    hint: 'Someone asking, someone asked, and someone who is neither.',
    build: () =>
      world([
        person(0, { activity: 'watching', channel: 'LIRIK' }),
        person(1, { relationship: 'incoming_request' }),
        person(2, { relationship: 'outgoing_request' }),
        person(3, { relationship: 'stranger', activity: 'watching', channel: 'LIRIK' }),
      ]),
  },
]

export function preset(id: string): Preset {
  const found = PRESETS.find((entry) => entry.id === id)
  if (!found) throw new Error(`test lab: no preset "${id}"`)
  return found
}
