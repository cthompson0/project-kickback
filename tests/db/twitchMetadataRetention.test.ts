import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestDb } from './harness'
import type { TestDb } from './harness'

/**
 * The twenty-four hour retention cap, held without depending on traffic.
 *
 * WHAT THIS IS FOR
 *
 * Schedule 1 §C of the Twitch Developer Services Agreement permits storing
 * copies of Twitch Content only if you "cache such information for only a
 * twenty-four hour time period". `twitch_metadata_cache` holds display names,
 * avatar URLs, live state, categories, titles and viewer counts - Twitch
 * Content by any reading.
 *
 * G7 found that the sweep 0017 wrote was never called, and the remediation was
 * to call it on the metadata write path. That was necessary and insufficient:
 * a write-path sweep is driven by user traffic, so a quiet period lets rows sit
 * past the cap. The clause speaks to how long content is STORED, not to what is
 * served - and nothing stale is served either way, because the read path skips
 * anything older than two minutes.
 *
 * 0044 schedules the same function hourly so the guarantee holds at zero
 * traffic.
 *
 * WHAT CAN AND CANNOT BE PROVEN HERE
 *
 * PGlite has no pg_cron, so the SCHEDULE cannot execute in a test - 0044 skips
 * itself here by design, and that skip is itself asserted below. What is proven
 * here is everything the schedule depends on: that the function it will call
 * deletes what it should, keeps what it should, cannot reach another table, and
 * is safe to run repeatedly. The schedule's own correctness is asserted against
 * the migration text, and its existence in production is a verification step in
 * the G7 report rather than something a test can know.
 */

const MIGRATION = readFileSync(
  join(process.cwd(), 'supabase', 'migrations', '0044_twitch_metadata_retention_schedule.sql'),
  'utf8',
)

/** How old a row must be before the scheduled job removes it. */
const THRESHOLD_HOURS = 12
/** How often the job runs, so worst-case retention is threshold + cadence. */
const CADENCE_HOURS = 1
const CONTRACT_CAP_HOURS = 24

describe('the scheduled sweep is aimed at exactly one thing', () => {
  it('runs only sweep_twitch_metadata_cache, and nothing else', () => {
    const command = /\$job\$([\s\S]*?)\$job\$/.exec(MIGRATION)
    expect(command, 'the migration should schedule a command').not.toBeNull()

    const sql = command![1].trim()
    expect(sql).toBe("select public.sweep_twitch_metadata_cache(interval '12 hours')")

    // Nothing else may ride along in the scheduled command.
    expect(sql).not.toMatch(/;/)
    expect(sql.toLowerCase()).not.toMatch(/\b(delete|drop|truncate|update|insert|alter|grant)\b/)
  })

  it('keeps worst-case retention comfortably inside the contractual cap', () => {
    /*
     * The arithmetic the cadence was chosen by, asserted rather than described.
     * A threshold at the cap would make compliance depend on the scheduler
     * firing exactly on time, which is the margin-free design that produced the
     * original finding.
     */
    const worstCase = THRESHOLD_HOURS + CADENCE_HOURS
    expect(worstCase).toBeLessThan(CONTRACT_CAP_HOURS)
    expect(worstCase).toBeLessThanOrEqual(CONTRACT_CAP_HOURS / 2 + 1)

    expect(MIGRATION).toContain("interval '12 hours'")
    // Hourly, and deliberately not on the hour.
    expect(MIGRATION).toContain("'7 * * * *'")
  })

  it('is idempotent by construction: unschedule precedes schedule', () => {
    const unscheduleAt = MIGRATION.indexOf('cron.unschedule')
    const scheduleAt = MIGRATION.indexOf('cron.schedule')
    expect(unscheduleAt).toBeGreaterThan(-1)
    expect(scheduleAt).toBeGreaterThan(unscheduleAt)
  })

  it('skips itself where there is no scheduler, rather than failing the suite', () => {
    // The guard that lets 616 database tests keep running under PGlite.
    expect(MIGRATION).toContain('pg_available_extensions')
    expect(MIGRATION).toMatch(/name = 'pg_cron'/)
  })

  it('says out loud that applying it is not evidence the job exists', () => {
    /*
     * A conditional migration that no-ops silently is the exact failure mode
     * G7 was created by. The migration has to carry that warning, because the
     * next reader will otherwise take a clean apply as proof.
     */
    // Comment prefixes out first, so the sentence can be asserted as prose
    // rather than as whatever line it happens to wrap on.
    const prose = MIGRATION.replace(/^\s*--\s?/gm, '').replace(/\s+/g, ' ')
    expect(prose).toMatch(/applying successfully is therefore NOT evidence/i)
  })
})

describe('the function the schedule calls', () => {
  let db: TestDb

  const insert = (login: string, ageHours: number) =>
    db.root(
      `insert into public.twitch_metadata_cache (login, payload, fetched_at)
       values ($1, '{"login":"x"}'::jsonb, now() - make_interval(hours => $2))`,
      [login, ageHours],
    )

  const logins = async () =>
    (
      await db.root<{ login: string }>(
        'select login from public.twitch_metadata_cache order by login',
      )
    ).map((row) => row.login)

  const sweep = async (interval = '12 hours') =>
    (
      await db.root<{ sweep_twitch_metadata_cache: number }>(
        `select public.sweep_twitch_metadata_cache(interval '${interval}')`,
      )
    )[0].sweep_twitch_metadata_cache

  beforeAll(async () => {
    db = await createTestDb()
  }, 120_000)

  afterAll(async () => {
    await db.close()
  })

  it('deletes rows older than the threshold', async () => {
    await db.root('delete from public.twitch_metadata_cache')
    await insert('ancient', 400)
    await insert('old', 25)
    await insert('past_threshold', 13)

    expect(await sweep()).toBe(3)
    expect(await logins()).toEqual([])
  })

  it('keeps recent rows', async () => {
    await db.root('delete from public.twitch_metadata_cache')
    await insert('fresh', 0)
    await insert('recent', 2)
    await insert('inside', 11)
    await insert('outside', 13)

    expect(await sweep()).toBe(1)
    expect(await logins()).toEqual(['fresh', 'inside', 'recent'])
  })

  it('leaves nothing older than the contractual cap once it has run', async () => {
    /*
     * The invariant itself, stated as the thing a reader actually cares about:
     * after a sweep, no stored Twitch Content is older than 24 hours.
     */
    await db.root('delete from public.twitch_metadata_cache')
    for (const age of [0, 1, 5, 12, 13, 23, 24, 25, 100, 1000]) {
      await insert(`age_${age}`, age)
    }
    await sweep()

    const [{ over }] = await db.root<{ over: number }>(
      `select count(*)::int as over from public.twitch_metadata_cache
        where fetched_at < now() - interval '24 hours'`,
    )
    expect(over).toBe(0)

    // And in fact nothing older than the threshold either.
    const [{ beyond }] = await db.root<{ beyond: number }>(
      `select count(*)::int as beyond from public.twitch_metadata_cache
        where fetched_at < now() - interval '12 hours'`,
    )
    expect(beyond).toBe(0)
  })

  it('is safe to run repeatedly', async () => {
    await db.root('delete from public.twitch_metadata_cache')
    await insert('keep', 1)
    await insert('go', 20)

    expect(await sweep()).toBe(1)
    // Every subsequent run deletes nothing and changes nothing.
    for (let i = 0; i < 4; i += 1) expect(await sweep()).toBe(0)
    expect(await logins()).toEqual(['keep'])
  })

  it('cannot affect any table but the cache', async () => {
    /*
     * Proven two ways. The function body is a single DELETE against one table -
     * asserted from the catalog rather than from the migration file, so it is
     * the definition that actually exists which is checked - and a populated
     * neighbouring table is counted across a sweep.
     */
    const [{ body }] = await db.root<{ body: string }>(
      `select pg_get_functiondef(p.oid) as body
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'sweep_twitch_metadata_cache'`,
    )
    const deletes = [...body.matchAll(/delete\s+from\s+([a-z_.]+)/gi)].map((m) => m[1])
    expect(deletes).toEqual(['public.twitch_metadata_cache'])
    expect(body.toLowerCase()).not.toMatch(/\b(truncate|drop|update|insert)\b/)

    const actor = await db.createUser({ login: 'retention_probe' })
    await db.root(
      `insert into public.creator_relationship_observations (actor_id, broadcaster_login, observed_at)
       values ($1, 'somechannel', now() - interval '400 days')`,
      [actor.id],
    )
    const before = await db.root<{ n: number }>(
      'select count(*)::int as n from public.creator_relationship_observations',
    )
    await insert('sweepme', 999)
    await sweep()
    const after = await db.root<{ n: number }>(
      'select count(*)::int as n from public.creator_relationship_observations',
    )

    // Deliberately an ancient row: if the sweep were keyed on time rather than
    // on the table, this is the row it would have taken.
    expect(after[0].n).toBe(before[0].n)
  })
})

describe('the authorization surface is unchanged by scheduling', () => {
  let db: TestDb

  beforeAll(async () => {
    db = await createTestDb()
  }, 120_000)

  afterAll(async () => {
    await db.close()
  })

  it('still lets no client execute the sweep', async () => {
    for (const role of ['anon', 'authenticated']) {
      const [{ granted }] = await db.root<{ granted: boolean }>(
        `select has_function_privilege($1, p.oid, 'EXECUTE') as granted
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = 'sweep_twitch_metadata_cache'`,
        [role],
      )
      expect(granted, `${role} must not execute the sweep`).toBe(false)
    }
  })

  it('still lets no client read the cache', async () => {
    for (const role of ['anon', 'authenticated']) {
      const [{ granted }] = await db.root<{ granted: boolean }>(
        `select has_table_privilege($1, 'public.twitch_metadata_cache', 'SELECT') as granted`,
        [role],
      )
      expect(granted, `${role} must not read the cache`).toBe(false)
    }
  })

  it('adds no object to the public schema', () => {
    /*
     * 0044 schedules an existing function. Anything it created in `public`
     * would be a new authorization surface arriving through a migration whose
     * stated purpose is retention, which is how surfaces get missed.
     */
    const created = [...MIGRATION.matchAll(/create\s+(table|view|policy|type|index)\b/gi)]
    expect(created.map((m) => m[1])).toEqual([])
  })

  it('reports the advanced schema version', async () => {
    const [{ v }] = await db.root<{ v: number }>('select public.analytics_schema_version() as v')
    expect(v).toBe(44)
  })
})
