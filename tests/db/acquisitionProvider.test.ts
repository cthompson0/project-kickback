import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createTestDb } from './harness'
import type { TestDb, TestUser } from './harness'

/**
 * 0045: provider metadata on the registry, and acquisition joined to activation.
 *
 * WHAT IS ACTUALLY AT RISK
 *
 * Not that the columns exist. Four things, each of which fails silently:
 *
 *   * A GROUPING KEY THAT CAN BE EDITED. `provider` and `medium` are what a
 *     report groups on across time. If either can be updated, editing one row
 *     retroactively rewrites what every earlier comparison meant, and not one
 *     row looks wrong afterwards. `content` and `term` must stay editable, or a
 *     creative could never be renamed - so this is not "lock everything", it is
 *     a distinction that has to hold in both directions.
 *
 *   * A CLOSED SET THAT IS NOT CLOSED. Free text becomes 'paid_social',
 *     'Paid Social' and 'paid-social' inside a month, and every rollup then
 *     quietly undercounts.
 *
 *   * THE DENOMINATOR. acquisition_activation_v divides by attributed actors
 *     who AUTHENTICATED. If an attributed actor who never signed in leaked into
 *     it they would read as a failure at every stage, and a campaign would look
 *     broken because somebody clicked a link and never came back.
 *
 *   * A READABLE REPORTING VIEW. 0043 was a stop-ship, live in production,
 *     because four migrations in a row forgot to revoke. authorizationSurface
 *     covers this globally; it is asserted here too, next to the thing it is
 *     about.
 *
 * Both directions throughout: valid input SUCCEEDS as well as invalid input
 * refusing. A gate that only ever refuses is a gate that refuses everything.
 */

let db: TestDb
let alice: TestUser
let bob: TestUser
let carol: TestUser
let dave: TestUser

const bind = (user: TestUser, code: string) =>
  db.as<{ bind_acquisition: string }>(user, 'select public.bind_acquisition($1)', [code])

async function seedCampaigns(): Promise<void> {
  await db.root(
    `insert into public.acquisition_campaigns
       (code, source, creator_key, label, active, provider, medium, content, term) values
       ('reddit-a', 'reddit',  null,    'Reddit A', true, 'reddit', 'paid_social', 'creative_a', null),
       ('reddit-b', 'reddit',  null,    'Reddit B', true, 'reddit', 'paid_social', 'creative_b', 'twitch_fans'),
       ('organic-x','x',       null,    'X thread', true, null,     'organic_social', null,      null)`,
  )
}

/** Sign somebody in. The funnel starts here and nowhere else. */
async function authenticate(user: TestUser, appVersion = '0.9.0'): Promise<void> {
  await db.root(
    'insert into public.analytics_actors (user_id) values ($1) on conflict (user_id) do nothing',
    [user.id],
  )
  await db.root(
    `insert into public.analytics_events (actor_id, environment, event_name, occurred_at, app_version)
     values ($1, 'private_beta', 'authenticated_session_started', now(), $2)`,
    [user.id, appVersion],
  )
}

interface ActivationRow {
  campaign_code: string
  provider: string | null
  medium: string | null
  content: string | null
  term: string | null
  authenticated_actors: number
  cold_start_actors: number
  friended_actors: number
  gravity_actors: number
  social_join_actors: number
  returned_actors: number
  cold_start_rate: string | null
  friended_rate: string | null
  rates_reportable: boolean
}

const activation = () =>
  db.root<ActivationRow>('select * from public.acquisition_activation_v order by campaign_code')

beforeAll(async () => {
  db = await createTestDb()
}, 90_000)

afterAll(async () => {
  await db.close()
})

beforeEach(async () => {
  await db.reset()
  alice = await db.createUser({ login: 'alice', displayName: 'Alice' })
  bob = await db.createUser({ login: 'bob', displayName: 'Bob' })
  carol = await db.createUser({ login: 'carol', displayName: 'Carol' })
  dave = await db.createUser({ login: 'dave', displayName: 'Dave' })
  await seedCampaigns()
})

// ------------------------------------------------------------- the vocabulary

describe('provider and medium are closed sets', () => {
  it('accepts every provider the vocabulary names', async () => {
    for (const provider of ['reddit', 'google', 'meta', 'tiktok', 'x', 'producthunt', 'hackernews']) {
      await expect(
        db.root(
          `insert into public.acquisition_campaigns (code, source, label, provider)
           values ($1, 'other', 'p', $2)`,
          [`p-${provider}`, provider],
        ),
      ).resolves.toBeDefined()
    }
  })

  it('accepts every medium the vocabulary names', async () => {
    for (const medium of [
      'paid_social',
      'organic_social',
      'launch',
      'referral',
      'organic_search',
      'press',
      'creator',
    ]) {
      await expect(
        db.root(
          `insert into public.acquisition_campaigns (code, source, label, medium)
           values ($1, 'other', 'm', $2)`,
          [`m-${medium.replace(/_/g, '-')}`, medium],
        ),
      ).resolves.toBeDefined()
    }
  })

  it('refuses a provider nobody agreed to', async () => {
    await expect(
      db.root(
        `insert into public.acquisition_campaigns (code, source, label, provider)
         values ('bad-provider', 'other', 'x', 'linkedin')`,
      ),
    ).rejects.toThrow()
  })

  it('refuses a medium nobody agreed to', async () => {
    await expect(
      db.root(
        `insert into public.acquisition_campaigns (code, source, label, medium)
         values ('bad-medium', 'other', 'x', 'Paid Social')`,
      ),
    ).rejects.toThrow()
  })

  /*
   * NULL is the honest value for an unpaid campaign, and it must stay legal.
   * The alternative somebody reaches for is a 'direct' or 'none' provider, and
   * 0040 refused exactly that: a bucket invented to avoid a null is a fact
   * invented about people.
   */
  it('allows no provider at all, because most campaigns have none', async () => {
    const rows = await db.root<{ provider: string | null; medium: string | null }>(
      "select provider, medium from public.acquisition_campaigns where code = 'organic-x'",
    )
    expect(rows[0].provider).toBeNull()
    expect(rows[0].medium).toBe('organic_social')
  })

  it('refuses content and term that are not UTM-safe', async () => {
    for (const bad of ['Creative A', 'creative a', 'créatif', '-leading']) {
      await expect(
        db.root(
          `insert into public.acquisition_campaigns (code, source, label, content)
           values ($1, 'other', 'x', $2)`,
          [`c-${Math.random().toString(36).slice(2, 8)}`, bad],
        ),
        bad,
      ).rejects.toThrow()
    }
  })
})

// -------------------------------------------------------------- immutability

describe('grouping keys are immutable; labels are not', () => {
  it('refuses to change a provider', async () => {
    await expect(
      db.root("update public.acquisition_campaigns set provider = 'google' where code = 'reddit-a'"),
    ).rejects.toThrow(/provider is immutable/)
  })

  it('refuses to change a medium', async () => {
    await expect(
      db.root("update public.acquisition_campaigns set medium = 'launch' where code = 'reddit-a'"),
    ).rejects.toThrow(/medium is immutable/)
  })

  it('refuses to add a provider to a campaign that had none', async () => {
    await expect(
      db.root("update public.acquisition_campaigns set provider = 'meta' where code = 'organic-x'"),
    ).rejects.toThrow(/provider is immutable/)
  })

  /* The 0038 rules still hold. Replacing the trigger must not have relaxed one. */
  it('still refuses to change source, code or creator', async () => {
    await expect(
      db.root("update public.acquisition_campaigns set source = 'meta' where code = 'reddit-a'"),
    ).rejects.toThrow(/source is immutable/)
    await expect(
      db.root("update public.acquisition_campaigns set code = 'reddit-z' where code = 'reddit-a'"),
    ).rejects.toThrow(/code is immutable/)
    await expect(
      db.root("update public.acquisition_campaigns set creator_key = 'x' where code = 'reddit-a'"),
    ).rejects.toThrow(/creator is immutable/)
  })

  /*
   * The other direction, and it matters as much. A creative has to be
   * renameable without minting a new code, because the code is already in a
   * published ad.
   */
  it('allows a creative to be renamed', async () => {
    await db.root(
      "update public.acquisition_campaigns set content = 'friends_gathering' where code = 'reddit-a'",
    )
    const rows = await db.root<{ content: string }>(
      "select content from public.acquisition_campaigns where code = 'reddit-a'",
    )
    expect(rows[0].content).toBe('friends_gathering')
  })

  it('allows targeting and label to be changed', async () => {
    await db.root(
      "update public.acquisition_campaigns set term = 'esports', label = 'Renamed' where code = 'reddit-a'",
    )
    const rows = await db.root<{ term: string; label: string }>(
      "select term, label from public.acquisition_campaigns where code = 'reddit-a'",
    )
    expect(rows[0].term).toBe('esports')
    expect(rows[0].label).toBe('Renamed')
  })
})

// ------------------------------------------------------ acquisition_activation_v

describe('acquisition_activation_v bridges campaign to activation', () => {
  it('is empty before anybody is attributed', async () => {
    expect(await activation()).toEqual([])
  })

  it('carries the registry dimensions rather than copying them into rows', async () => {
    await authenticate(alice)
    await bind(alice, 'reddit-a')

    const [row] = await activation()
    expect(row.campaign_code).toBe('reddit-a')
    expect(row.provider).toBe('reddit')
    expect(row.medium).toBe('paid_social')
    expect(row.content).toBe('creative_a')
    expect(row.term).toBeNull()

    /* Renaming the creative changes the view, because it reads the registry. */
    await db.root(
      "update public.acquisition_campaigns set content = 'renamed_creative' where code = 'reddit-a'",
    )
    expect((await activation())[0].content).toBe('renamed_creative')
  })

  /*
   * THE DENOMINATOR. An attributed actor who never authenticated has no
   * activation story, and counting them would make every campaign look like it
   * fails at the first stage.
   */
  it('counts only attributed actors who authenticated', async () => {
    await authenticate(alice)
    await bind(alice, 'reddit-a')

    /*
     * Bob is attributed AND known to analytics, but has never emitted
     * `authenticated_session_started`.
     *
     * That combination is the whole point, and getting it wrong made this test
     * vacuous the first time: an actor who is simply absent from
     * `analytics_actors` never reaches `acquisition_actor_v` either, so the
     * join being inner or outer makes no difference and the test passes without
     * exercising anything. Bob has to be visible to acquisition and invisible
     * to activation - which is exactly the real case, because `bind_acquisition`
     * emits an event server-side whether or not anybody ever signed in.
     *
     * With a LEFT join he arrives as a row of nulls that every stage counts as
     * a failure, and the campaign looks broken because somebody clicked a link
     * and never came back.
     */
    await db.root(
      'insert into public.analytics_actors (user_id) values ($1) on conflict (user_id) do nothing',
      [bob.id],
    )
    await bind(bob, 'reddit-a')

    /*
     * ONE ROW, and this is the assertion that actually bites.
     *
     * A LEFT join does not inflate alice's count - it adds a SEPARATE group,
     * because bob's `environment` and `first_app_version` are null and both are
     * in the grain. So checking `authenticated_actors` on the first row passes
     * happily while the view has quietly grown a phantom cohort of one, with
     * every stage at zero, that any campaign report would render as a failure.
     *
     * The honest statement is that an attributed actor who never authenticated
     * does not appear here AT ALL.
     */
    const rows = await activation()
    expect(rows).toHaveLength(1)
    expect(rows[0].authenticated_actors).toBe(1)
  })

  it('counts cold start as the population that never made a friend', async () => {
    for (const user of [alice, bob, carol]) {
      await authenticate(user)
      await bind(user, 'reddit-a')
    }

    const [row] = await activation()
    expect(row.authenticated_actors).toBe(3)
    expect(row.cold_start_actors).toBe(3)
    expect(row.friended_actors).toBe(0)
    expect(row.cold_start_rate).toBe('1.0000')
  })

  it('moves an actor out of cold start when a real friendship forms', async () => {
    for (const user of [alice, bob, carol]) {
      await authenticate(user)
      await bind(user, 'reddit-a')
    }
    await db.root('select public.create_friendship($1, $2)', [alice.id, bob.id])

    const [row] = await activation()
    expect(row.friended_actors).toBe(2)
    expect(row.cold_start_actors).toBe(1)
    expect(row.friended_rate).toBe('0.6667')
  })

  it('separates campaigns rather than pooling them', async () => {
    await authenticate(alice)
    await bind(alice, 'reddit-a')
    await authenticate(bob)
    await bind(bob, 'reddit-b')

    const rows = await activation()
    expect(rows.map((row) => row.campaign_code)).toEqual(['reddit-a', 'reddit-b'])
    expect(rows.every((row) => row.authenticated_actors === 1)).toBe(true)
  })
})

// ----------------------------------------------------------- the safety rails

describe('the reporting discipline is inherited, not re-decided', () => {
  it('suppresses every rate below three actors, as NULL rather than zero', async () => {
    await authenticate(alice)
    await bind(alice, 'reddit-a')
    await authenticate(bob)
    await bind(bob, 'reddit-a')

    const [row] = await activation()
    expect(row.authenticated_actors).toBe(2)
    expect(row.rates_reportable).toBe(false)
    // NULL, never 0: a suppressed rate and a genuinely zero rate must not look
    // alike, or an absent number reads as a bad one.
    expect(row.cold_start_rate).toBeNull()
    expect(row.friended_rate).toBeNull()
  })

  it('reports rates once the cohort reaches three', async () => {
    for (const user of [alice, bob, carol]) {
      await authenticate(user)
      await bind(user, 'reddit-a')
    }
    const [row] = await activation()
    expect(row.rates_reportable).toBe(true)
    expect(row.cold_start_rate).not.toBeNull()
  })

  it('excludes internal actors, because we click our own links constantly', async () => {
    for (const user of [alice, bob, carol, dave]) {
      await authenticate(user)
      await bind(user, 'reddit-a')
    }
    expect((await activation())[0].authenticated_actors).toBe(4)

    await db.root('update public.analytics_actors set is_internal = true where user_id = $1', [
      dave.id,
    ])
    expect((await activation())[0].authenticated_actors).toBe(3)
  })

  it('drops an actor entirely when their account is deleted', async () => {
    await authenticate(alice)
    await bind(alice, 'reddit-a')
    expect(await activation()).toHaveLength(1)

    await db.root('delete from public.users where id = $1', [alice.id])
    expect(await activation()).toEqual([])
  })
})

// ------------------------------------------------------------- authorization

describe('the new reporting view is not client-readable', () => {
  /*
   * 0043 was a stop-ship found in the v0.9 RC pass and already live in
   * production: four migrations in a row created reporting views and Supabase's
   * default grants made every one of them readable by anybody holding the
   * publishable key that ships inside the extension.
   *
   * authorizationSurface.test.ts enforces this across the whole schema. It is
   * asserted here as well, beside the migration that could break it.
   */
  for (const role of ['anon', 'authenticated']) {
    it(`grants nothing on acquisition_activation_v to ${role}`, async () => {
      const rows = await db.root<{ count: number }>(
        `select count(*)::int as count
           from information_schema.role_table_grants
          where table_schema = 'public'
            and table_name = 'acquisition_activation_v'
            and grantee = $1`,
        [role],
      )
      expect(rows[0].count).toBe(0)
    })

    it(`grants nothing on acquisition_campaign_v to ${role} after 0045 replaced it`, async () => {
      const rows = await db.root<{ count: number }>(
        `select count(*)::int as count
           from information_schema.role_table_grants
          where table_schema = 'public'
            and table_name = 'acquisition_campaign_v'
            and grantee = $1`,
        [role],
      )
      expect(rows[0].count).toBe(0)
    })
  }
})
