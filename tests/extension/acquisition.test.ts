import { describe, expect, it } from 'vitest'
import {
  ATTRIBUTION_WINDOW_MS,
  CAMPAIGN_PARAM,
  CAMPAIGN_PATH,
  campaignFromUrl,
  campaignLinkFor,
  isCampaignCode,
  isWithinAttributionWindow,
  nextPendingTouch,
  normalizeCampaignCode,
  touchIsBindable,
} from '../../src/core/acquisition'
import { INVITE_PARAM, isInviteCode } from '../../src/core/invites'

/**
 * The client half of acquisition attribution.
 *
 * The server owns what a campaign MEANS; this owns which touch survives to be
 * offered to it, and for how long. Both halves have to be right - a perfect
 * registry cannot fix a client that binds a two-month-old code, and an
 * immutable first-touch column cannot fix a client that overwrote the touch
 * before it ever arrived.
 *
 * THE WINDOW IS ENFORCED HERE ON PURPOSE. The server cannot know when a link
 * was clicked, only when a bind arrived, so an age sent to it would be a client
 * assertion wearing a server check's clothes. That makes these tests the only
 * thing standing between a stale touch and a wrong attribution.
 */

const DAY = 24 * 60 * 60 * 1000
const NOW = 1_800_000_000_000

describe('a campaign code is a durable identity', () => {
  it.each(['tiktok-launch', 'lirik-oct', 'x1', 'a-b-c-d', 'launch2026'])(
    'accepts %s',
    (code) => {
      expect(isCampaignCode(code)).toBe(true)
    },
  )

  it.each([
    ['empty', ''],
    ['one character', 'a'],
    ['uppercase', 'TikTok'],
    ['a space', 'tiktok launch'],
    ['an underscore', 'tiktok_launch'],
    ['a leading hyphen', '-tiktok'],
    ['a trailing hyphen', 'tiktok-'],
    ['a slash', 'tiktok/launch'],
    ['a dot', 'tiktok.launch'],
    ['too long', 'a'.repeat(33)],
    ['a URL', 'https://evil.example.com'],
    ['a traversal', '../../etc/passwd'],
  ])('refuses %s', (_label, code) => {
    expect(isCampaignCode(code)).toBe(false)
  })

  it('cannot be confused with a friend referral code as either is issued', () => {
    const invite = 'ABCDEFGHJKMNPQRSTVWXYZ'.slice(0, 22)
    expect(isInviteCode(invite)).toBe(true)
    expect(isCampaignCode(invite)).toBe(false)

    expect(isCampaignCode('tiktok-launch')).toBe(true)
    expect(isInviteCode('tiktok-launch')).toBe(false)
    expect(isInviteCode('TIKTOK-LAUNCH')).toBe(false)
  })

  it('does not rely on the alphabets being disjoint, because they are not', () => {
    /*
     * WORTH BEING PRECISE ABOUT, because the comfortable assumption is wrong.
     *
     * An invite code is 22 characters from an uppercase alphabet. Lower-cased,
     * it is also a syntactically valid campaign code - the campaign pattern
     * allows any lowercase letters and digits. So shape alone does NOT keep the
     * two apart.
     *
     * What keeps them apart is three things that do not depend on shape: a
     * different path prefix (/i/ vs /c/), a different wire parameter, and a
     * registry lookup. A lowercased invite code offered as a campaign resolves
     * to nothing and binds nothing - proved server-side in tests/db, where an
     * unknown code writes no row at all.
     *
     * Asserting disjoint alphabets here would have been a comforting test of
     * something untrue, and it would have failed the moment somebody widened
     * either pattern for an unrelated reason.
     */
    const invite = 'ABCDEFGHJKMNPQRSTVWXYZ'.slice(0, 22)
    expect(isCampaignCode(invite.toLowerCase())).toBe(true)
    expect(CAMPAIGN_PATH).not.toBe('/i/')
    expect(CAMPAIGN_PARAM).not.toBe(INVITE_PARAM)
  })

  it('uses a different wire parameter from the invite', () => {
    expect(CAMPAIGN_PARAM).not.toBe(INVITE_PARAM)
    // The invite's name is a compatibility contract with released clients and
    // must not drift; asserted here so a rename of either is a failing test.
    expect(INVITE_PARAM).toBe('kickback_invite')
    expect(CAMPAIGN_PARAM).toBe('watchside_campaign')
  })

  it('uses a different path prefix from the invite', () => {
    expect(CAMPAIGN_PATH).toBe('/c/')
    expect(campaignLinkFor('lirik-oct')).toBe('https://watchside.app/c/lirik-oct')
  })
})

describe('reading a code out of a URL', () => {
  it('reads the campaign parameter from the Twitch hop', () => {
    expect(campaignFromUrl(`https://www.twitch.tv/?${CAMPAIGN_PARAM}=lirik-oct`)).toBe('lirik-oct')
  })

  it('lower-cases what it finds', () => {
    expect(campaignFromUrl(`https://www.twitch.tv/?${CAMPAIGN_PARAM}=LIRIK-OCT`)).toBe('lirik-oct')
  })

  it('reads nothing from an invite URL', () => {
    // The two parameters coexist on the same host and must never be confused.
    expect(campaignFromUrl(`https://www.twitch.tv/?${INVITE_PARAM}=ABCDEFGHJKMNPQRSTVWXYZ`)).toBeNull()
  })

  it('reads the campaign even when an invite is present too', () => {
    const url = `https://www.twitch.tv/?${INVITE_PARAM}=ABCDEFGHJKMNPQRSTVWXYZ&${CAMPAIGN_PARAM}=x-thread`
    expect(campaignFromUrl(url)).toBe('x-thread')
  })

  it.each([
    ['a malformed code', `https://www.twitch.tv/?${CAMPAIGN_PARAM}=NOT A CODE`],
    ['an absolute URL', `https://www.twitch.tv/?${CAMPAIGN_PARAM}=https%3A%2F%2Fevil.example.com`],
    ['a traversal', `https://www.twitch.tv/?${CAMPAIGN_PARAM}=..%2F..%2Fevil`],
    ['no parameter', 'https://www.twitch.tv/somechannel'],
    ['not a URL at all', 'lirik-oct'],
  ])('reads nothing from %s', (_label, url) => {
    expect(campaignFromUrl(url)).toBeNull()
  })

  it('reads a code out of a pasted canonical link', () => {
    expect(normalizeCampaignCode('https://watchside.app/c/lirik-oct')).toBe('lirik-oct')
    expect(normalizeCampaignCode('https://watchside.app/c/lirik-oct/')).toBe('lirik-oct')
  })

  it('refuses a trailing segment that is not under /c/', () => {
    /*
     * Any path has a last segment. Taking one would attribute somebody to a
     * campaign that never existed, off a channel name or an article slug.
     */
    expect(normalizeCampaignCode('https://www.twitch.tv/lirik-oct')).toBeNull()
    expect(normalizeCampaignCode('https://example.com/blog/tiktok-launch')).toBeNull()
  })

  it('accepts a bare code somebody typed', () => {
    expect(normalizeCampaignCode('  LIRIK-OCT  ')).toBe('lirik-oct')
  })
})

// ------------------------------------------------------------------ window

describe('the attribution window', () => {
  it('is seven days, deliberately and not by accident', () => {
    expect(ATTRIBUTION_WINDOW_MS).toBe(7 * DAY)
  })

  it('accepts a touch from moments ago', () => {
    expect(isWithinAttributionWindow(NOW - 60_000, NOW)).toBe(true)
  })

  it('accepts a touch exactly on the boundary', () => {
    // Stated because a boundary nobody wrote down is one two tests disagree on.
    expect(isWithinAttributionWindow(NOW - ATTRIBUTION_WINDOW_MS, NOW)).toBe(true)
  })

  it('refuses a touch one millisecond past it', () => {
    expect(isWithinAttributionWindow(NOW - ATTRIBUTION_WINDOW_MS - 1, NOW)).toBe(false)
  })

  it('refuses a touch from the future', () => {
    // A machine whose clock is a year ahead would otherwise hold a code that
    // never expires.
    expect(isWithinAttributionWindow(NOW + 1, NOW)).toBe(false)
  })

  it('refuses nonsense timestamps rather than treating them as fresh', () => {
    expect(isWithinAttributionWindow(Number.NaN, NOW)).toBe(false)
    expect(isWithinAttributionWindow(NOW, Number.NaN)).toBe(false)
    expect(isWithinAttributionWindow(Number.POSITIVE_INFINITY, NOW)).toBe(false)
  })
})

// ------------------------------------------------------------- first touch

describe('which pre-auth touch survives', () => {
  const touch = (code: string, capturedAt: number) => ({ code, capturedAt })

  it('keeps the first one when a second arrives inside the window', () => {
    /*
     * Somebody acquired by a streamer who later clicks a TikTok link was
     * acquired by the streamer. Overwriting would make every report agree that
     * whichever link was posted most recently performs best.
     */
    const held = touch('lirik-oct', NOW - 2 * DAY)
    const arriving = touch('tiktok-launch', NOW)
    expect(nextPendingTouch(held, arriving, NOW)).toEqual(held)
  })

  it('keeps the first one even when the same code arrives again', () => {
    const held = touch('lirik-oct', NOW - DAY)
    expect(nextPendingTouch(held, touch('lirik-oct', NOW), NOW)).toEqual(held)
  })

  it('takes the new one when nothing is held', () => {
    const arriving = touch('tiktok-launch', NOW)
    expect(nextPendingTouch(null, arriving, NOW)).toEqual(arriving)
  })

  it('replaces a held touch that has expired', () => {
    // It can no longer bind, so holding it would block one that can.
    const stale = touch('lirik-oct', NOW - ATTRIBUTION_WINDOW_MS - 1)
    const arriving = touch('tiktok-launch', NOW)
    expect(nextPendingTouch(stale, arriving, NOW)).toEqual(arriving)
  })
})

describe('what may still be offered to the server', () => {
  it('offers a fresh, well-formed touch', () => {
    expect(touchIsBindable({ code: 'lirik-oct', capturedAt: NOW - DAY }, NOW)).toBe(true)
  })

  it('refuses nothing held', () => {
    expect(touchIsBindable(null, NOW)).toBe(false)
  })

  it('refuses an expired touch', () => {
    expect(
      touchIsBindable({ code: 'lirik-oct', capturedAt: NOW - ATTRIBUTION_WINDOW_MS - 1 }, NOW),
    ).toBe(false)
  })

  it('refuses a malformed code that reached storage somehow', () => {
    /*
     * Storage is not a trusted input. A value edited by hand, or written by an
     * older build, must not become an attribution.
     */
    expect(touchIsBindable({ code: 'NOT A CODE', capturedAt: NOW }, NOW)).toBe(false)
    expect(touchIsBindable({ code: 'https://evil.example.com', capturedAt: NOW }, NOW)).toBe(false)
  })
})
