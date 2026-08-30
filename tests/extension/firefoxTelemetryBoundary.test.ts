import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createAnalyticsRecorder } from '../../src/background/analytics'
import type { AnalyticsEvent } from '../../src/core/analytics'
import {
  ANALYTICS_EVENT_NAMES,
  EVENT_DATA_CATEGORY,
  TECHNICAL_AND_INTERACTION_EVENTS,
  isTechnicalAndInteraction,
} from '../../src/core/analytics'

/**
 * Firefox collects no Mozilla `technicalAndInteraction` data. Ever.
 *
 * THE DECISION THIS PROTECTS
 *
 * Mozilla permits that category only as an OPTIONAL data permission, which
 * means a second consent prompt at install and a user choice to honour
 * afterwards. Watchside's owner decided not to make that trade: rather than ask
 * for diagnostic telemetry, Firefox simply does not collect it. So there is no
 * consent UI, no toggle, and no optional declaration in the manifest - and the
 * only thing standing between that promise and a leak is the boundary below.
 *
 * WHAT MUST NOT HAPPEN INSTEAD
 *
 * The far worse failure than a missing error report is a suppressed FUNNEL.
 * Gravity exposure, JOIN and its source, arrival, shared watches, post-social
 * linger and the growth loop are the product's measurement thesis, and every
 * one of them is a record of what a person did rather than a report about our
 * software. They stay on both engines, and these tests fail if the boundary
 * ever creeps over them.
 */

const FIREFOX = { collectTechnical: false }
const CHROMIUM = {}

/** A recorder whose backend we can read, with time under our control. */
function recorder(over: { collectTechnical?: boolean }) {
  const sent: AnalyticsEvent[][] = []
  const instance = createAnalyticsRecorder({
    backend: {
      async send(events) {
        sent.push(events)
        return events.length
      },
    },
    environment: 'development',
    appVersion: '0.0.0-test',
    enabled: true,
    sessionId: () => 'session-1',
    canSend: () => true,
    now: () => 1_700_000_000_000,
    ...over,
  })
  return { instance, sent, names: () => sent.flat().map((e) => e.event_name) }
}

// ------------------------------------------------------- the classification

describe('every analytics event is classified', () => {
  /**
   * The property that makes the boundary safe rather than merely present.
   *
   * `EVENT_DATA_CATEGORY` is a Record over `AnalyticsEventName`, so TypeScript
   * refuses a new event that nobody classified. This asserts the same thing at
   * runtime, because a `Record` cannot catch a name added by a cast.
   */
  it('leaves no event without a Mozilla category', () => {
    for (const name of ANALYTICS_EVENT_NAMES) {
      expect(EVENT_DATA_CATEGORY[name], name).toBeDefined()
    }
    expect(Object.keys(EVENT_DATA_CATEGORY).sort()).toEqual([...ANALYTICS_EVENT_NAMES].sort())
  })

  /**
   * The boundary itself, written out. Changing it has to be a deliberate edit
   * here as well as in the classification - which is the point, because both
   * directions are dangerous: adding a product event silently stops it
   * reaching Firefox, and removing a diagnostic one silently starts sending it.
   */
  it('puts exactly three diagnostic events in technicalAndInteraction', () => {
    expect([...TECHNICAL_AND_INTERACTION_EVENTS].sort()).toEqual([
      'client_error',
      'group_message_send_failed',
      'realtime_status_changed',
    ])
  })

  /**
   * Watchside collects no device or browser information anywhere, which is a
   * third of what technicalAndInteraction covers and the reason the boundary is
   * as small as it is. The envelope carries a build version and an environment
   * label - properties of the BUILD - and nothing about the machine.
   */
  it('never collects device or browser information', () => {
    const source = readFileSync('src/core/analytics.ts', 'utf8')
    for (const forbidden of ['navigator.', 'userAgent', 'platform:', 'screen.', 'deviceMemory']) {
      expect(source, forbidden).not.toContain(forbidden)
    }
  })
})

// -------------------------------------------------------- A, B, C: Firefox

describe('on Firefox', () => {
  it('does not send client_error', async () => {
    const r = recorder(FIREFOX)
    r.instance.track({ name: 'client_error', properties: { context: 'unknown', code: 'refused' } })

    expect(r.instance.pending()).toBe(0)
    await r.instance.flush()
    expect(r.sent).toEqual([])
  })

  it('does not send any technicalAndInteraction event', async () => {
    const r = recorder(FIREFOX)
    for (const name of TECHNICAL_AND_INTERACTION_EVENTS) {
      r.instance.track({ name } as Parameters<typeof r.instance.track>[0])
    }

    expect(r.instance.pending()).toBe(0)
    await r.instance.flush()
    expect(r.names()).toEqual([])
  })

  /**
   * FAILS CLOSED, and this is the assertion that says so.
   *
   * The drop happens before the queue, so a suppressed event cannot be revived
   * by a later flush, by a retry after a failed batch, or by anything that
   * inspects the queue. There is nothing holding it.
   */
  it('drops diagnostics before the queue, so nothing can flush them later', async () => {
    const r = recorder(FIREFOX)
    r.instance.track({ name: 'client_error', properties: { context: 'unknown', code: 'refused' } })
    r.instance.track({ name: 'join_clicked', channel: 'lirik' })

    expect(r.instance.pending()).toBe(1)
    await r.instance.flush()
    await r.instance.flush()
    expect(r.names()).toEqual(['join_clicked'])
  })

  /** D: the funnel is untouched by the diagnostic boundary. */
  it('still sends every product and funnel event', async () => {
    const product = ANALYTICS_EVENT_NAMES.filter((name) => !isTechnicalAndInteraction(name))
    const r = recorder(FIREFOX)
    for (const name of product) {
      r.instance.track({ name } as Parameters<typeof r.instance.track>[0])
    }
    await r.instance.flush()
    expect(r.names().sort()).toEqual([...product].sort())
  })

  /**
   * The measurements the product thesis rests on, named individually.
   *
   * The test above would pass if somebody reclassified JOIN as technical and
   * updated the expectation with it. This one would not.
   */
  it('still sends Gravity, JOIN, arrival, shared watch, linger and growth', async () => {
    const strategic = [
      'gravity_cluster_impression',
      'gathering_impression',
      'friend_presence_impression',
      'join_clicked',
      'join_arrived',
      'watching_together_started',
      'watching_together_ended',
      'post_social_retention_ended',
      'extension_session_started',
      'extension_session_ended',
      'friend_suggestion_impression',
      'invite_claimed',
      'referral_succeeded',
    ] as const

    for (const name of strategic) expect(isTechnicalAndInteraction(name), name).toBe(false)

    const r = recorder(FIREFOX)
    for (const name of strategic) r.instance.track({ name, channel: 'lirik' })
    await r.instance.flush()
    expect(r.names().sort()).toEqual([...strategic].sort())
  })
})

// ------------------------------------------------------------ E, F: Chromium

describe('on Chromium', () => {
  it('sends client_error exactly as it always did', async () => {
    const r = recorder(CHROMIUM)
    r.instance.track({ name: 'client_error', properties: { context: 'unknown', code: 'refused' } })

    expect(r.instance.pending()).toBe(1)
    await r.instance.flush()
    expect(r.names()).toEqual(['client_error'])
  })

  it('sends every event, diagnostics included', async () => {
    const r = recorder(CHROMIUM)
    for (const name of ANALYTICS_EVENT_NAMES) {
      r.instance.track({ name } as Parameters<typeof r.instance.track>[0])
    }
    await r.instance.flush()
    expect(r.names().sort()).toEqual([...ANALYTICS_EVENT_NAMES].sort())
  })

  /** The default is unchanged behaviour: only an explicit `false` suppresses. */
  it('is unaffected when the flag is absent or true', async () => {
    for (const over of [{}, { collectTechnical: true }]) {
      const r = recorder(over)
      r.instance.track({ name: 'client_error', properties: { context: 'unknown', code: 'refused' } })
      await r.instance.flush()
      expect(r.names()).toEqual(['client_error'])
    }
  })
})

// ------------------------------------------------- G, H: the shipped package

describe('the built Firefox package', () => {
  const PACKAGE = 'dist-firefox/package'
  const built = existsSync(`${PACKAGE}/manifest.json`)

  it.runIf(built)('declares no optional data collection at all', () => {
    const manifest = JSON.parse(readFileSync(`${PACKAGE}/manifest.json`, 'utf8'))
    const declared = manifest.browser_specific_settings.gecko.data_collection_permissions

    expect(declared.optional).toBeUndefined()
    expect(JSON.stringify(declared)).not.toContain('technicalAndInteraction')
    // And the required declaration is still the F6 one.
    expect(declared.required).toEqual([
      'authenticationInfo',
      'browsingActivity',
      'personalCommunications',
      'websiteActivity',
    ])
  })

  /**
   * H: nothing asks for the permission at runtime either.
   *
   * A manifest with no optional declaration and code that calls
   * `permissions.request({ data_collection: [...] })` would be a prompt the
   * owner explicitly ruled out, so the built bundle is checked rather than the
   * manifest alone.
   */
  it.runIf(built)('never requests a data-collection permission at runtime', () => {
    /*
     * `data_collection` is the key the permissions API uses for this - in
     * `permissions.request({ data_collection: [...] })` and in what
     * `getAll()` returns. Its absence from both bundles is what says no code
     * path can raise a second prompt or read a consent state.
     *
     * NOT asserted: that the string `technicalAndInteraction` is absent. It is
     * present, and should be - it is the classification literal in
     * EVENT_DATA_CATEGORY, which is exactly the thing doing the suppressing.
     * Asserting on the word rather than the API would have failed for the one
     * reason that means everything is working.
     */
    for (const file of ['kickback-background.js', 'kickback-content.js']) {
      const bundle = readFileSync(`${PACKAGE}/${file}`, 'utf8')
      expect(bundle, file).not.toContain('data_collection')
      expect(bundle, file).not.toContain('permissions.request')
    }
  })

  /**
   * I: the classification and the wiring cannot drift apart.
   *
   * The unit tests above prove the recorder suppresses when told to. This is
   * the other half - that the Gecko build is what tells it, from the single
   * place allowed to know which engine this is. A build-time constant folds
   * away under minification, so it is asserted at the source.
   */
  it('wires the boundary to the engine in exactly one place', () => {
    const worker = readFileSync('src/background/index.ts', 'utf8')
    expect(worker).toContain('collectTechnical: !IS_GECKO')

    /*
     * The engine is named in exactly two places, and both are listed here.
     *
     * Feedback is the second: it attached the user agent, which is "device and
     * browser info" - the first thing Mozilla lists under the category Firefox
     * does not collect - so that one field is omitted on Gecko. It is a
     * deliberate exception, not a leak of engine-awareness into product code,
     * and naming it means a THIRD use fails this test and has to be justified.
     */
    expect(worker).toContain('...(IS_GECKO ? {} : { browser: browserName() })')
    expect(worker.match(/IS_GECKO/g)).toHaveLength(3) // the import, and the two uses

    // The recorder consults the classification rather than a hand-kept list.
    const recorderSource = readFileSync('src/background/analytics.ts', 'utf8')
    expect(recorderSource).toContain('isTechnicalAndInteraction(request.name)')
  })
})
