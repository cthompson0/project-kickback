import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createTestDb } from './harness'
import type { TestDb, TestUser } from './harness'

/**
 * Feedback, against real Postgres.
 *
 * Feedback is the only table in Watchside that holds prose somebody typed, which
 * makes it the only one where "who can read this" is a question about people
 * rather than about metadata. So most of what is asserted here is refusal: no
 * client may read any of it, edit it, delete it, or submit it as somebody else.
 *
 * The other half is the context whitelist. The service worker assembles the
 * diagnostics, but the server is what decides which of them are diagnostics -
 * a client that starts attaching something it should not must write nothing
 * rather than write it.
 */

let db: TestDb

/** A single-quoted SQL literal; see tests/db/roomMessages.test.ts for why. */
function lit(value: string): string {
  return `'${value.split("'").join("''")}'`
}

async function submit(
  user: TestUser,
  category: string,
  body: string,
  context = '{}',
): Promise<void> {
  await db.as(
    user,
    `select public.submit_feedback(${lit(category)}, ${lit(body)}, ${lit(context)}::jsonb)`,
  )
}

async function rows(): Promise<
  Array<{ user_id: string; category: string; body: string; context: Record<string, unknown> }>
> {
  return db.root(`select user_id, category, body, context from public.feedback order by created_at`)
}

async function refusal(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
    return ''
  } catch (error) {
    return (error as Error).message
  }
}

let alice: TestUser
let bob: TestUser

beforeAll(async () => {
  db = await createTestDb()
}, 60_000)

afterAll(async () => {
  await db?.close()
})

beforeEach(async () => {
  await db.reset()
  await db.root('truncate public.feedback, public.rate_limits')
  alice = await db.createUser({ login: 'alice' })
  bob = await db.createUser({ login: 'bob' })
})

// ------------------------------------------------------------- submitting

describe('sending feedback', () => {
  it('stores what was written, against the person who wrote it', async () => {
    await submit(alice, 'bug', 'my friend did not appear')

    const stored = await rows()
    expect(stored).toHaveLength(1)
    expect(stored[0].user_id).toBe(alice.id)
    expect(stored[0].category).toBe('bug')
    expect(stored[0].body).toBe('my friend did not appear')
  })

  it('accepts each of the four categories and nothing else', async () => {
    for (const category of ['bug', 'confusing', 'idea', 'other']) {
      await db.root('truncate public.feedback, public.rate_limits')
      await submit(alice, category, 'something')
      expect((await rows())[0].category).toBe(category)
    }

    await db.root('truncate public.feedback, public.rate_limits')
    const message = await refusal(() => submit(alice, 'complaint', 'something'))
    expect(message).toContain('unknown feedback category')
    expect(await rows()).toEqual([])
  })

  it('refuses an empty body, however it is spelled', async () => {
    for (const body of ['', '   ', '\n\n']) {
      expect(await refusal(() => submit(alice, 'idea', body))).toContain('feedback is empty')
    }
    expect(await rows()).toEqual([])
  })

  it('trims, rather than storing the whitespace somebody happened to leave', async () => {
    await submit(alice, 'idea', '  spaces around it  ')
    expect((await rows())[0].body).toBe('spaces around it')
  })

  it('refuses a body past the limit', async () => {
    await submit(alice, 'other', 'x'.repeat(2000))
    expect((await rows())[0].body).toHaveLength(2000)

    await db.root('truncate public.feedback, public.rate_limits')
    expect(await refusal(() => submit(alice, 'other', 'x'.repeat(2001)))).toContain(
      'feedback is too long',
    )
    expect(await rows()).toEqual([])
  })

  it('stops somebody submitting the same thing over and over', async () => {
    /*
     * Generous enough that nobody hits it while actually reporting something,
     * tight enough that a stuck retry loop cannot fill the table.
     */
    for (let index = 0; index < 5; index += 1) {
      await submit(alice, 'other', `report ${index}`)
    }
    expect(await refusal(() => submit(alice, 'other', 'one too many'))).toContain('too quickly')
    expect(await rows()).toHaveLength(5)

    // And the limit is per person, not global - one noisy tester must not
    // silence the rest of the cohort.
    await submit(bob, 'other', 'from bob')
    expect(await rows()).toHaveLength(6)
  })
})

// ---------------------------------------------------------- the whitelist

describe('the diagnostic context', () => {
  const CONTEXT = JSON.stringify({
    app_version: '0.4.0',
    environment: 'private_beta',
    browser: 'Chrome 141',
    surface: 'friends',
    collapsed: false,
    channel: 'lirik',
    on_channel: true,
    friend_count: 4,
    session_available: true,
    social_sync: 'connected',
    presence_sync: 'connected',
  })

  it('keeps every field the worker is meant to send', async () => {
    await submit(alice, 'bug', 'my friend did not appear', CONTEXT)

    const context = (await rows())[0].context
    expect(context).toEqual({
      app_version: '0.4.0',
      environment: 'private_beta',
      browser: 'Chrome 141',
      surface: 'friends',
      collapsed: false,
      channel: 'lirik',
      on_channel: true,
      friend_count: 4,
      session_available: true,
      social_sync: 'connected',
      presence_sync: 'connected',
    })
  })

  it('drops anything it was not asked for', async () => {
    /*
     * The whole point of the whitelist. A future client that starts attaching
     * a token, a roster or somebody's message must write nothing rather than
     * write it - the server decides what a diagnostic is.
     */
    await submit(
      alice,
      'bug',
      'something',
      JSON.stringify({
        app_version: '0.4.0',
        access_token: 'eyJhbGciOi.eyJzdWIi.signature',
        provider_token: 'twitch-oauth-token',
        message_bodies: ['hello', 'there'],
        muted_user_ids: ['u-1', 'u-2'],
        blocked_user_ids: ['u-3'],
        friend_ids: ['u-4', 'u-5'],
        composer_text: 'half-typed message',
      }),
    )

    const context = (await rows())[0].context
    expect(context).toEqual({ app_version: '0.4.0' })
    expect(JSON.stringify(context)).not.toContain('eyJ')
    expect(JSON.stringify(context)).not.toContain('twitch-oauth-token')
  })

  it('will not let prose ride in through a field meant for a login', async () => {
    // Bounded per key, so a channel slot cannot become a second body.
    await submit(
      alice,
      'other',
      'something',
      JSON.stringify({ channel: 'x'.repeat(500), browser: 'y'.repeat(500) }),
    )

    const context = (await rows())[0].context as Record<string, string>
    expect(context.channel).toHaveLength(64)
    expect(context.browser).toHaveLength(64)
  })

  it('is happy with no context at all', async () => {
    await submit(alice, 'idea', 'just a thought')
    expect((await rows())[0].context).toEqual({})
  })
})

// ------------------------------------------------- what a client cannot do

describe('what a client cannot do', () => {
  it('cannot read anybody else feedback', async () => {
    await submit(bob, 'bug', 'bob wrote this')
    expect(await refusal(() => db.as(alice, 'select body from public.feedback'))).toBeTruthy()
  })

  it('cannot read its own either', async () => {
    /*
     * Deliberate. A submission is a message to us, not a document you own, and
     * a read path that returned your own rows would be one policy change away
     * from returning everybody's.
     */
    await submit(alice, 'bug', 'alice wrote this')
    expect(await refusal(() => db.as(alice, 'select body from public.feedback'))).toBeTruthy()
  })

  it('cannot read the developer view', async () => {
    await submit(alice, 'bug', 'alice wrote this')
    expect(await refusal(() => db.as(alice, 'select body from public.feedback_v'))).toBeTruthy()
  })

  it('cannot write a row directly', async () => {
    const message = await refusal(() =>
      db.as(
        alice,
        `insert into public.feedback (user_id, category, body)
         values (${lit(alice.id)}::uuid, 'bug', 'direct')`,
      ),
    )
    expect(message).toBeTruthy()
    expect(await rows()).toEqual([])
  })

  it('cannot edit or delete what it said', async () => {
    await submit(alice, 'bug', 'the original')

    expect(
      await refusal(() => db.as(alice, "update public.feedback set body = 'rewritten'")),
    ).toBeTruthy()
    expect(await refusal(() => db.as(alice, 'delete from public.feedback'))).toBeTruthy()

    const stored = await rows()
    expect(stored).toHaveLength(1)
    expect(stored[0].body).toBe('the original')
  })

  it('cannot submit on somebody else behalf', async () => {
    // There is no actor parameter to pass, which is the point - the identity
    // comes from auth.uid() and nothing on the wire can change it.
    await submit(alice, 'bug', 'from alice')
    expect((await rows())[0].user_id).toBe(alice.id)
  })
})
