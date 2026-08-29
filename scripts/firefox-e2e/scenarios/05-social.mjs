import { createProfile, launch, seedProfile } from '../harness.mjs'

/*
 * Where each actor starts.
 *
 * They must start APART. If both actors opened the same channel the room would
 * form on its own and JOIN would never be exercised - the scenario would still
 * go green while the single most important social affordance in the product sat
 * untested. So B settles on MEET, A waits on HOME, and the only thing that can
 * bring A to MEET is clicking the JOIN that B's presence caused to appear.
 *
 * Both are long-lived real channels. A made-up channel would publish a
 * destination that does not exist, which is exactly the synthetic contamination
 * this suite is forbidden from creating.
 */
const HOME = 'twitch'
const MEET = 'lirik'

/** Wait for the panel to satisfy a predicate, and hand back the snapshot. */
function panelWhen(driver, path, predicate, label, timeout = 60_000) {
  return driver.waitFor(
    async () => {
      const panel = await driver.page(path, 'panel')
      return predicate(panel) ? panel : null
    },
    { label, timeout },
  )
}

/** The last state this tab was broadcast in which the actor was signed in. */
function identityWhen(driver, path, label) {
  return driver.waitFor(
    async () => {
      const s = await driver.page(path, 'state')
      return [...(s.states || [])].reverse().find((x) => x.signedIn) ?? null
    },
    { label, timeout: 60_000 },
  )
}

async function openSession(driver, path) {
  await driver.page(path, 'expand').catch(() => {})
  await panelWhen(
    driver,
    path,
    (p) => p.present && p.tabs.some((t) => t.session),
    'the stream room tab to appear',
  )
  await driver.page(path, 'click', { selector: '.kb-tab-session' })
  await panelWhen(driver, path, (p) => p.session !== null, 'the stream room to open')

  // The roster is one row until it is tapped, so who is here has to be asked
  // for before it can be asserted.
  await driver.page(path, 'click', { selector: '.kb-session-people' })
  return panelWhen(driver, path, (p) => p.session && p.session.roster, 'the roster to open')
}

/** Has this actor's room log got a message whose body is exactly `body`? */
const sees = (body) => (panel) =>
  Boolean(panel.session && panel.session.messages.some((m) => m.body === body))

export default {
  name: 'Two-actor social chain',
  why: 'presence, gravity, JOIN, the stream room and messages both ways, between two real signed-in accounts',
  requires: ['A', 'B'],

  async run({ assert }) {
    /*
     * Every message this run writes is stamped, so anything it leaves behind is
     * identifiable as ours forever after. The accounts are the owner's real
     * ones: their history is not a scratch buffer, and an unlabelled "hello"
     * from an automated run would be indistinguishable from something they said.
     */
    const runId = Date.now().toString(36)
    const A_TO_B = `[Watchside E2E] ${runId} A→B`
    const B_TO_A = `[Watchside E2E] ${runId} B→A`

    const a = await launch({
      profile: createProfile({ name: 'social-a', seed: seedProfile('A').path }),
      startUrl: `https://www.twitch.tv/${HOME}`,
      label: 'social-a',
    })

    let b = null
    try {
      b = await launch({
        profile: createProfile({ name: 'social-b', seed: seedProfile('B').path }),
        startUrl: `https://www.twitch.tv/${MEET}`,
        label: 'social-b',
        // The second browser boots on a machine already running the first, so it
        // gets a longer grace period than a lone actor needs.
        timeoutMs: 120_000,
      })

      // ------------------------------------------------- two real identities
      const idA = await identityWhen(a, HOME, 'Actor A to restore its session')
      const idB = await identityWhen(b, MEET, 'Actor B to restore its session')

      assert('Actor A is signed in', Boolean(idA.userId), `@${idA.twitchLogin}`)
      assert('Actor B is signed in', Boolean(idB.userId), `@${idB.twitchLogin}`)
      assert(
        'the two actors are different accounts',
        idA.userId !== idB.userId,
        `${idA.twitchLogin} vs ${idB.twitchLogin}`,
      )

      /*
       * The friendship is REUSED, never created. These are the owner's own
       * accounts and they were already friends before this suite existed;
       * tearing that down and rebuilding it to prove the harness can would be
       * destroying real social state to test a test.
       */
      const friendsBefore = idA.friendLogins ?? []
      assert(
        'the actors are already friends, so nothing has to be created',
        friendsBefore.includes(idB.twitchLogin.toLowerCase()),
        `A's friends: ${friendsBefore.join(', ')}`,
      )

      // ------------------------------------------------------- B's presence
      const published = await b.waitFor(
        async () => {
          const d = await b.bg('destinations')
          return d.available && d.value.published.includes(MEET) ? d.value : null
        },
        { label: `Actor B's presence on ${MEET} to reach the server`, timeout: 60_000 },
      )
      assert(
        'Actor B publishes the channel it is watching',
        published.published.includes(MEET),
        published.published.join(),
      )

      // -------------------------------------- A sees B, on a card A can act on
      /*
       * Asserted against the RENDERED CARD rather than the gravity state.
       *
       * State says the client believes B is somewhere. A card says the owner
       * would have seen it and had somewhere to click. Only the second one is
       * the product.
       */
      const withCard = await panelWhen(
        a,
        HOME,
        (p) => p.present && p.cards.some((c) => (c.channel || '').toLowerCase() === MEET),
        `Actor A's panel to show a friend on ${MEET}`,
      )
      const card = withCard.cards.find((c) => (c.channel || '').toLowerCase() === MEET)
      assert('Actor A sees a card for the channel Actor B is on', Boolean(card), MEET)
      assert('the card offers a JOIN', card.join === true, JSON.stringify(card))
      assert(
        'and A is not already there, so the JOIN is a real destination',
        card.here === false,
        `A is on /${HOME}`,
      )
      /*
       * NOT asserted: the flame. `isGravity` needs GRAVITY_THRESHOLD (2)
       * friends on one channel and there is exactly one other account, so the
       * strong styling is unreachable with two actors and is left to the unit
       * tests rather than faked here.
       */

      // ---------------------------------------------------------------- JOIN
      const joined = await a.page(HOME, 'join', { channel: card.channel })
      assert('the JOIN control accepted the click', joined.clicked, JSON.stringify(joined))

      const arrived = await a.waitFor(
        async () => {
          const dom = await a.page(MEET, 'dom')
          return dom.url.includes(MEET) ? dom : null
        },
        { label: `Actor A to arrive on /${MEET}`, timeout: 60_000 },
      )
      assert('JOIN navigated Actor A to the channel', arrived.url.includes(MEET), arrived.url)
      assert('and the panel survived the navigation', arrived.panelCount === 1, String(arrived.panelCount))

      // ------------------------------- does B notice the arrival at all?
      /*
       * Measured on B's HERE card, before either room is opened.
       *
       * Not on a friend ROW: once the viewer is on the same channel the friend
       * stops being listed separately and is counted inside the card instead,
       * so a row probe finds nothing and would read as "B never noticed" when
       * B noticed immediately. That mistake is recorded because it looked
       * exactly like a presence defect for two runs.
       *
       * The point of timing it here is the comparison. The card is fed by
       * PRESENCE; the room roster below is fed by a membership query the
       * client only re-asks when it believes co-presence changed. Two
       * timestamps tell those apart - one number cannot.
       */
      const noticedAt = Date.now()
      const hereCard = (p) =>
        p.cards.some((c) => (c.channel || '').toLowerCase() === MEET && c.here)
      const noticed = await panelWhen(b, MEET, hereCard, `B to see ${MEET} as HERE`, 150_000)
      const noticedIn = ((Date.now() - noticedAt) / 1000).toFixed(1)
      assert(
        'B sees A arrive: its own card for the channel turns HERE',
        hereCard(noticed),
        `after ${noticedIn}s — ${JSON.stringify(noticed.cards)}`,
      )

      // --------------------------------------------------------- the room
      const roomA = await openSession(a, MEET)
      const roomB = await openSession(b, MEET)

      assert(
        'the room A opened is the channel both are on',
        (roomA.session.channel || '').toLowerCase() === MEET,
        roomA.session.channel,
      )
      assert(
        'B sees the same room',
        (roomB.session.channel || '').toLowerCase() === MEET,
        roomB.session.channel,
      )

      // ------------------------------------------------------ messages, both ways
      const sentAtoB = await a.page(MEET, 'compose', { body: A_TO_B, send: true })
      assert('A can send into the room', sentAtoB.sent, JSON.stringify(sentAtoB))

      const atB = await panelWhen(b, MEET, sees(A_TO_B), 'B to receive A’s message')
      const fromA = atB.session.messages.find((m) => m.body === A_TO_B)
      assert("B received A's message", Boolean(fromA), A_TO_B)
      assert(
        'and it is attributed to A, not to B',
        fromA.self === false && fromA.who.toLowerCase() === idA.displayName.toLowerCase(),
        JSON.stringify(fromA),
      )

      const sentBtoA = await b.page(MEET, 'compose', { body: B_TO_A, send: true })
      assert('B can send into the room', sentBtoA.sent, JSON.stringify(sentBtoA))

      const back = await panelWhen(a, MEET, sees(B_TO_A), 'A to receive B’s message')
      const fromB = back.session.messages.find((m) => m.body === B_TO_A)
      assert("A received B's message", Boolean(fromB), B_TO_A)
      assert(
        'and it is attributed to B',
        fromB.self === false && fromB.who.toLowerCase() === idB.displayName.toLowerCase(),
        JSON.stringify(fromB),
      )

      const mine = back.session.messages.find((m) => m.body === A_TO_B)
      assert('A’s own message is attributed to A', mine && mine.self === true, JSON.stringify(mine))

      // -------------------------------------------------- who the room says is here
      /*
       * The roster, asserted on BOTH sides and timed.
       *
       * Two different answers to "who is in this room" feed this:
       *
       *   roomPeers   - derived from PRESENCE, and always fast.
       *   roomMembers - the server's membership query, cached for 90s and
       *                 re-asked when co-presence changes. This is what the
       *                 rendered roster lists.
       *
       * WS-F5-01 lived in the gap. The actor who NAVIGATED was always correct,
       * because arriving re-asks; the actor already watching kept a pre-arrival
       * answer for 122s, 132s and >150s across runs, while its own HERE card
       * showed the arrival in about two seconds. The cause was that three of
       * the four writers of the presence index never invalidated the room, so
       * nothing re-asked until the cache happened to lapse.
       *
       * So the window here is the assertion, not decoration. It is set well
       * BELOW the 90s refresh interval on purpose: a fix that merely shortened
       * the cache, or one that regressed to waiting for it, cannot pass. Only
       * event-driven convergence can.
       */
      const CONVERGE_MS = 45_000

      const rosterLists = async (driver, who) => {
        const at = Date.now()
        const panel = await panelWhen(
          driver,
          MEET,
          (p) => p.session && p.session.people.some((n) => n.toLowerCase() === who.toLowerCase()),
          `the roster to list ${who} within ${CONVERGE_MS / 1000}s`,
          CONVERGE_MS,
        )
        return { panel, seconds: ((Date.now() - at) / 1000).toFixed(1) }
      }

      const listsB = await rosterLists(a, idB.displayName)
      assert(
        "the arriving actor's room lists the other by name",
        listsB.panel.session.people.some((p) => p.toLowerCase() === idB.displayName.toLowerCase()),
        `${listsB.panel.session.people.join(', ')} after ${listsB.seconds}s`,
      )

      const listsA = await rosterLists(b, idA.displayName)
      assert(
        "the already-watching actor's room lists the arriver by name (WS-F5-01)",
        listsA.panel.session.people.some((p) => p.toLowerCase() === idA.displayName.toLowerCase()),
        `${listsA.panel.session.people.join(', ')} after ${listsA.seconds}s`,
      )
      assert(
        'and it converged on the arrival, not on the 90s cache expiring',
        Number(listsA.seconds) < 90,
        `${listsA.seconds}s`,
      )

      /*
       * The client half of the same claim, kept because it is what tells a
       * broken ROOM apart from broken PRESENCE if this ever fails again.
       */
      const peers = await b.waitFor(
        async () => {
          const s = await b.page(MEET, 'state')
          const last = [...(s.states || [])].reverse().find((x) => x.signedIn)
          return last && (last.roomPeers?.[MEET] ?? 0) >= 1 ? last : null
        },
        { label: `B to count a peer on ${MEET}`, timeout: 60_000 },
      )
      assert.equal("B's room counts one peer - the actor who joined", peers.roomPeers[MEET], 1)
      assert.equal(
        "and the server's membership answer agrees with it",
        (peers.roomMembers?.[MEET] ?? 0) >= 1,
        true,
      )

      // ------------------------------------------------ nobody else was touched
      /*
       * The safety assertion. The owner's other friends are real people, and
       * the one thing this suite must never do is change anything about them.
       * Their roster is compared before and after: a run that created,
       * destroyed or reshaped a friendship shows up here as a diff.
       */
      const afterA = await identityWhen(a, MEET, "Actor A's roster after the run")
      assert.equal(
        'A’s friend list is unchanged by the run',
        (afterA.friendLogins ?? []).join(),
        friendsBefore.join(),
      )
      const roster = back.session.people.map((p) => p.toLowerCase())
      assert(
        'the room contains only the two actors - no unrelated user was pulled in',
        roster.length === 2 && roster.includes('you') && roster.includes(idB.displayName.toLowerCase()),
        back.session.people.join(', '),
      )

      const errors = await Promise.all([a.bg('errors'), b.bg('errors')])
      assert.equal(
        'neither worker errored during the exchange',
        errors.reduce((n, e) => n + e.errors.length, 0),
        0,
      )

      return {}
    } catch (error) {
      error.diagnostics = await collect(a, b).catch(() => null)
      throw error
    } finally {
      if (b) await b.close().catch(() => {})
      await a.close().catch(() => {})
    }
  },
}

async function collect(a, b) {
  const of = async (driver, path) => {
    if (!driver) return null
    const safe = (p) => p.catch((e) => ({ error: String(e.message) }))
    const [errors, panel, dest, gravity] = await Promise.all([
      safe(driver.bg('errors')),
      safe(driver.page(path, 'panel')),
      safe(driver.bg('destinations')),
      safe(driver.bg('gravity')),
    ])
    return { errors, panel, destinations: dest, gravity }
  }
  return { A: await of(a, ''), B: await of(b, '') }
}
