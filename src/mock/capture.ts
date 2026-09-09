import { isTwitchImageUrl } from '../core/twitchMetadata'
import type { ChannelMetadata, LiveState } from '../core/twitchMetadata'

/**
 * The capture seam: how a marketing run tells the demo build what to show.
 *
 * WHY THIS EXISTS AT ALL
 *
 * The demo build has no backend, so it has no Twitch metadata - `channelMetadata`
 * stays `{}` and every Social Gravity card falls back to the plain card: a
 * letter avatar, a lowercase login, a count. That is correct behaviour (metadata
 * is enrichment and never a dependency) and it is the wrong picture for
 * marketing, because the enrichment is a large part of what the product
 * actually looks like now.
 *
 * The alternative was to hard-code some plausible-looking metadata into the
 * fixtures. That would have been fabrication: a screenshot claiming a channel is
 * LIVE with 4,000 viewers watching a particular game, invented by us. So instead
 * the capture script fetches the REAL current records from Helix through the
 * same two endpoints and the same `buildMetadata` parser the Edge Function uses,
 * and hands them in here.
 *
 * WHAT IS MOCK AND WHAT IS REAL, STATED ONCE
 *
 *   mock   the friends, their names, their avatars, who is watching what
 *   real   every Twitch fact: display casing, avatar, live state, category,
 *          title, viewer count - fetched at capture time, not stored here
 *
 * WHERE THIS CANNOT REACH
 *
 * `src/mock/` is absent from production builds by construction - demo mode is a
 * dynamic import behind a build-time constant - and
 * `tests/extension/bundle.test.ts` asserts the production bundle contains no
 * mock module and none of the mock people. This file inherits that, and adds
 * nothing that could be reached from a production artifact.
 *
 * WHY localStorage RATHER THAN A GLOBAL
 *
 * The content script runs in an isolated world, so a `window.__something__` set
 * by the driver in the main world is invisible to it. localStorage is shared
 * per-origin across both worlds, and the panel already uses it for layout - so
 * this is the mechanism that is already known to work rather than a second one.
 */

/** Where the driver leaves it, on the twitch.tv origin. */
export const CAPTURE_KEY = 'watchside:capture'

/** Which channel plays which part in the fixture story. */
export interface CaptureChannels {
  /** Where the friends have gathered. The JOIN destination. */
  gathering: string
  /** Where the viewer already is, so a JOIN is a real choice. */
  elsewhere: string
  /** Somewhere else again, so "everyone is in one place" is visibly a thing. */
  third: string
}

export interface CaptureOverride {
  channels?: Partial<CaptureChannels>
  /** Real records, fetched at capture time. Keyed by login downstream. */
  metadata?: ChannelMetadata[]
  /**
   * Freeze the drift.
   *
   * The demo deliberately wanders - two roamers change channel every twenty to
   * thirty-five seconds, and one friend walks onto whatever the viewer opens -
   * because a prototype that never moves is a prototype nobody notices is
   * broken. A capture run wants the opposite: the shot taken at 40s and the
   * shot taken at 90s must be the same shot, and the friend counts on a card
   * must still be the counts the run reported.
   *
   * Only ever true when a driver set it. Local demo use is untouched.
   */
  steady?: boolean
}

/** The same login grammar the rest of the product enforces. */
const LOGIN = /^[a-z0-9_]{1,25}$/

const LIVE_STATES: ReadonlySet<string> = new Set<LiveState>(['live', 'offline', 'unknown'])

const str = (value: unknown, max: number): string | null => {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 && trimmed.length <= max ? trimmed : null
}

/**
 * One record, revalidated on arrival.
 *
 * The driver built these with the Edge Function's own parser, so they are
 * already well-formed - but this reads from localStorage, which anybody with a
 * console can write, and a demo build that renders whatever it finds there is a
 * demo build that can be made to say anything. Every field is checked again,
 * and a record that fails any check is dropped whole rather than patched: a
 * half-trusted record is the one that ends up in a screenshot.
 */
function readMetadata(value: unknown): ChannelMetadata | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>

  const login = typeof raw.login === 'string' ? raw.login.toLowerCase() : ''
  if (!LOGIN.test(login)) return null

  const live = typeof raw.live === 'string' && LIVE_STATES.has(raw.live) ? (raw.live as LiveState) : null
  if (!live) return null

  const displayName = str(raw.displayName, 64)
  const viewerCount =
    typeof raw.viewerCount === 'number' && Number.isFinite(raw.viewerCount) && raw.viewerCount >= 0
      ? Math.floor(raw.viewerCount)
      : null
  const startedAt =
    typeof raw.startedAt === 'number' && Number.isFinite(raw.startedAt) ? raw.startedAt : null
  const fetchedAt =
    typeof raw.fetchedAt === 'number' && Number.isFinite(raw.fetchedAt) ? raw.fetchedAt : Date.now()

  return {
    login,
    userId: typeof raw.userId === 'string' && /^\d{1,20}$/.test(raw.userId) ? raw.userId : null,
    // Casing only, exactly as buildMetadata rules it. A display name that is a
    // different word is a rename, and identity never comes from display text.
    displayName: displayName && displayName.toLowerCase() === login ? displayName : null,
    // Host-checked with the product's own predicate, so a capture cannot point
    // the panel's avatar at an arbitrary origin.
    profileImageUrl: isTwitchImageUrl(raw.profileImageUrl) ? raw.profileImageUrl : null,
    live,
    gameName: live === 'live' ? str(raw.gameName, 64) : null,
    title: live === 'live' ? str(raw.title, 140) : null,
    viewerCount: live === 'live' ? viewerCount : null,
    startedAt: live === 'live' ? startedAt : null,
    fetchedAt,
  }
}

function readChannels(value: unknown): Partial<CaptureChannels> | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as Record<string, unknown>
  const out: Partial<CaptureChannels> = {}
  for (const role of ['gathering', 'elsewhere', 'third'] as const) {
    const login = typeof raw[role] === 'string' ? (raw[role] as string).toLowerCase() : ''
    if (LOGIN.test(login)) out[role] = login
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * What the driver left, or nothing at all.
 *
 * Never throws and never partially applies: an unreadable, absent or malformed
 * value produces `{}`, and the demo behaves exactly as it did before this file
 * existed. That matters because `npm run screenshots:store` and every developer
 * running the demo locally take this path on every load.
 */
export function readCaptureOverride(): CaptureOverride {
  try {
    const stored = globalThis.localStorage?.getItem(CAPTURE_KEY)
    if (!stored) return {}

    const parsed: unknown = JSON.parse(stored)
    if (!parsed || typeof parsed !== 'object') return {}
    const raw = parsed as Record<string, unknown>

    const channels = readChannels(raw.channels)
    const metadata = Array.isArray(raw.metadata)
      ? raw.metadata.map(readMetadata).filter((record): record is ChannelMetadata => record !== null)
      : []

    return {
      ...(channels ? { channels } : {}),
      ...(metadata.length > 0 ? { metadata } : {}),
      ...(raw.steady === true ? { steady: true } : {}),
    }
  } catch {
    // A capture override we cannot read is a capture override we do not have.
    // Never fatal: this runs on every demo load, including ones nobody staged.
    return {}
  }
}

/** The metadata map the panel wants, from the list the driver handed over. */
export function captureMetadataMap(
  override: CaptureOverride,
): Record<string, ChannelMetadata> {
  const map: Record<string, ChannelMetadata> = {}
  for (const record of override.metadata ?? []) map[record.login] = record
  return map
}
