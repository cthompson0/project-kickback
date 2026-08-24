import type { SimActivity, SimUser, SimVisibility, SimWorld } from './world'

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

function world(users: SimUser[], observerChannel: string | null = null): SimWorld {
  return {
    observer: { ...OBSERVER, channel: observerChannel },
    users,
    clockOffsetMs: 0,
  }
}

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
