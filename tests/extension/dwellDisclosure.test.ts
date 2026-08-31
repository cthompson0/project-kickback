import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  ANALYTICS_EVENT_NAMES,
  EVENT_DATA_CATEGORY,
  EVENT_PROPERTIES,
} from '../../src/core/analytics'
import { GECKO_DATA_COLLECTION } from '../../scripts/manifest.mjs'

/**
 * The measurement and the disclosure, pinned to each other.
 *
 * WHAT THIS PROTECTS
 *
 * `channel_dwell_ended` is the first event Watchside has ever recorded that
 * says how long somebody watched something. The privacy policy was changed to
 * say so plainly, in its own section, rather than folding it into the existing
 * "we record channel names" sentence - because they are not the same claim.
 *
 * Nothing structural stopped a future edit from deleting that section while
 * the event kept firing. These tests do.
 *
 * They also pin the Firefox classification, because the F6 decision - Firefox
 * transmits no `technicalAndInteraction` data at all - only holds if new
 * events keep landing in the categories that are actually declared.
 */

const POLICY = readFileSync('docs/PRIVACY.md', 'utf8')

/**
 * The policy with line wrapping collapsed.
 *
 * Markdown is hard-wrapped at 80 columns, so a sentence the policy genuinely
 * makes can be split across two lines and a literal match fails for a reason
 * that has nothing to do with the disclosure. Matching on the collapsed text
 * asserts what the policy SAYS rather than how it happens to be laid out.
 */
const SAID = POLICY.replace(/\s+/g, ' ')

describe('channel dwell is disclosed', () => {
  it('exists as an event with the properties the policy describes', () => {
    expect(ANALYTICS_EVENT_NAMES).toContain('channel_dwell_ended')
    expect([...EVENT_PROPERTIES.channel_dwell_ended].sort()).toEqual([
      'background_duration_ms',
      'duration_ms',
      'end_reason',
      'focused_duration_ms',
      'from_join',
      'had_social',
    ])
  })

  /**
   * Stated plainly, and the exact sentence matters.
   *
   * "Watchside records how long you watch a live Twitch channel" is the
   * un-euphemised version. A policy that only said "we record usage data"
   * would technically be true and would not tell anybody what changed.
   */
  it('says in plain words that viewing time is recorded', () => {
    expect(POLICY).toContain('Watchside records how long you watch a live Twitch channel')
    expect(POLICY).toContain('### Viewing time')
  })

  /** Each limit the implementation actually enforces is claimed in the policy. */
  it('describes the limits the code enforces', () => {
    for (const claim of [
      // Concurrent streams are measured, and the policy says so plainly.
      'more than one stream open',
      // The live-stream rule.
      'Not offline channels',
      // Conservative observation: a gap is never counted as viewing.
      'Not time we did not observe',
      // Nothing about the stream itself.
      'Not the video, the title, the category, the viewer count',
      // Only the open interval is on the device, and only while it is open.
      'deleted as soon as it ends',
    ]) {
      expect(SAID, `the policy no longer says: ${claim}`).toContain(claim)
    }
  })

  it('tells the reader why it is collected', () => {
    // A disclosure that says what but never why is not much of a disclosure.
    expect(POLICY).toMatch(/\*\*Why\.\*\*/)
  })
})

describe('the Firefox boundary still holds', () => {
  /**
   * Dwell is a record of what a person did on a website, not a report about
   * our software's health - so it is browsingActivity, which is already
   * declared REQUIRED. If it ever drifted into technicalAndInteraction it
   * would be silently dropped on Firefox, and the denominator would be missing
   * for every Firefox user without anybody noticing.
   */
  it('classifies channel dwell as already-declared browsing activity', () => {
    expect(EVENT_DATA_CATEGORY.channel_dwell_ended).toBe('browsingActivity')
    expect(GECKO_DATA_COLLECTION.required).toContain('browsingActivity')
  })

  it('adds no new required data category', () => {
    // M3A/M3C must not change what Firefox asks the user to consent to. A new
    // REQUIRED category changes the install prompt for every existing user.
    expect([...GECKO_DATA_COLLECTION.required].sort()).toEqual([
      'authenticationInfo',
      'browsingActivity',
      'personalCommunications',
      'websiteActivity',
    ])
  })

  /**
   * M3D/M3E-a territory, explicitly not this checkpoint.
   *
   * financialAndPaymentInfo is the category subscription state may require -
   * see the M3B report §17. Asserting its absence here makes adding it a
   * deliberate act with a failing test to acknowledge, rather than a quiet
   * line in a manifest diff.
   */
  it('declares no financial or payment category', () => {
    const declared = [
      ...GECKO_DATA_COLLECTION.required,
      ...(GECKO_DATA_COLLECTION.optional ?? []),
    ]
    expect(declared).not.toContain('financialAndPaymentInfo')
    expect(declared).not.toContain('technicalAndInteraction')
  })
})

describe('no Twitch relationship data is collected here', () => {
  /**
   * The M3A/M3C hard boundary (brief part F).
   *
   * following_at_join and subscribed_at_join belong to M3D/M3E-a, after the
   * DSA legal read and the AMO category question. If one of them appears in
   * the contract without those gates having been passed, this fails.
   */
  it('registers no follow or subscription property', () => {
    const every = ANALYTICS_EVENT_NAMES.flatMap((name) => [...EVENT_PROPERTIES[name]])
    for (const forbidden of [
      'following_at_join',
      'subscribed_at_join',
      'tier',
      'is_gift',
      'gifter_login',
    ]) {
      expect(every, `${forbidden} is M3D/M3E-a work, not M3A/M3C`).not.toContain(forbidden)
    }
    expect(ANALYTICS_EVENT_NAMES).not.toContain('creator_followed')
  })

  /**
   * TURNED OFF DELIBERATELY, AT THE GATE IT WAS WRITTEN FOR.
   *
   * This used to assert the policy made NO claim about follows, because
   * describing collection we do not perform is as wrong as the reverse. Slice D
   * makes the follow check real, so the same principle now demands the opposite
   * assertion: the policy must describe it, and must still describe nothing
   * else.
   *
   * The subscription half is unchanged and always will be.
   */
  it('describes the follow check it now performs, and nothing beyond it', () => {
    // The collection, in the policy, in plain words.
    expect(POLICY).toContain('Did this person already follow this creator?')
    expect(POLICY).toContain('user:read:follows')

    // Still no claim about subscriptions - Watchside has nothing to do with
    // them, and naming them would invite the reader to wonder why.
    expect(POLICY).not.toContain('subscription')

    // And still no claim to read the follow LIST, which is the overclaim this
    // whole design exists to avoid: one creator is asked about, not a list.
    expect(POLICY).not.toContain('channels you follow')
    expect(POLICY).toContain('does **not** read the list of creators you follow')
  })

  /** The claims that would be untrue, or that overstate what is measured. */
  it('claims no causal or forward-looking follow measurement', () => {
    expect(POLICY).toContain('does **not** watch whether you follow someone afterwards')
    expect(POLICY).toContain('claim that Watchside caused any follow')
    expect(POLICY).toContain('does **not** go back over JOINs you made in the past')
  })

  /**
   * The deletion asymmetry, stated where a user can find it.
   *
   * Twitch-derived answers go when the Twitch connection goes; Watchside's own
   * record of its own product does not. Getting this backwards in either
   * direction would be a false promise.
   */
  it('states the deletion asymmetry between Twitch-derived and Watchside-owned data', () => {
    expect(POLICY).toContain('disconnect Watchside on Twitch and they are deleted')
    expect(POLICY).toContain('is not\ndeleted by disconnecting Twitch')
  })
})
