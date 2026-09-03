-- 0044 — a retention guarantee that does not depend on traffic
--
-- WHY THIS EXISTS
--
-- 0017 created `sweep_twitch_metadata_cache` and said, in its own comment,
-- "Called by the Edge Function opportunistically rather than on a schedule, so
-- it needs no pg_cron and no extension." G7 then found that nothing called it
-- at all, and the fix was to call it on the metadata write path.
--
-- That was necessary and it is not sufficient. A write-path sweep is driven by
-- user traffic, so a quiet period - overnight, a lull between beta cohorts, an
-- outage upstream - lets rows sit in `twitch_metadata_cache` past the
-- twenty-four hours Schedule 1 §C of the Twitch Developer Services Agreement
-- permits for copies of Twitch Content. Nothing stale is ever SERVED (the
-- serving TTL is two minutes), but the clause speaks to how long content may be
-- stored, not to what is shown. So the guarantee has to hold with zero traffic.
--
-- WHAT THIS CHANGES, AND WHAT IT DELIBERATELY DOES NOT
--
-- It schedules the EXISTING function. It does not redefine the sweep, does not
-- touch the two-minute serving TTL, does not alter the cache's shape, and adds
-- no new table, column, view, policy or grant in `public`. The authorization
-- surface of `public` is byte-identical before and after.
--
-- CADENCE: hourly, sweeping rows older than twelve hours.
--
-- Twelve rather than twenty-four so the steady state sits at half the limit,
-- and hourly so scheduler granularity adds at most another hour: worst-case
-- retention is thirteen hours against a twenty-four hour cap. Choosing the
-- threshold at the limit would have made the cap depend on the scheduler
-- firing exactly on time, which is the kind of margin-free design that produced
-- the original finding.
--
-- Nothing functional depends on rows older than two minutes - the read path
-- skips them and refetches - so a shorter retention costs no Twitch API calls
-- and changes no behaviour. Twelve hours is chosen for margin, not for use.
--
-- Minute 7 rather than 0: there is no reason to join every other hourly job on
-- the hour.
--
-- WHY IT IS CONDITIONAL
--
-- The database test suite builds this schema in PGlite, which has no pg_cron
-- and no way to obtain it. An unconditional `create extension` would fail there
-- and take all 616 database tests and the authorization gate with it.
--
-- The guard is `pg_available_extensions`, which is the right discriminator:
-- Supabase lists pg_cron as available whether or not it has been enabled, and
-- PGlite does not list it at all. So this schedules for real in production and
-- correctly no-ops where there is no scheduler to configure.
--
-- THE PRICE OF THAT, STATED PLAINLY: a silent skip is exactly the failure mode
-- G7 was created by. This migration applying successfully is therefore NOT
-- evidence that the job exists. The verification query in the G7 report is the
-- evidence, and it must be run after applying.

begin;

do $mig$
declare
  v_available boolean;
begin
  select exists (select 1 from pg_available_extensions where name = 'pg_cron')
    into v_available;

  if not v_available then
    raise notice
      'pg_cron is not available here; skipping the retention schedule. This is expected under PGlite. In production this means the job was NOT created - verify with the query in docs/reports/g7-twitch-legal-release-gate-2026-09-02.md.';
    return;
  end if;

  create extension if not exists pg_cron;

  /*
   * Unschedule first, so re-running this migration is safe.
   *
   * cron.unschedule raises when the job does not exist, which is the common
   * case on a first apply, so the exception is caught rather than guarded with
   * a lookup - the catalog table's name has moved between pg_cron versions and
   * a hard-coded probe would be the more fragile of the two.
   */
  begin
    perform cron.unschedule('sweep-twitch-metadata-cache');
  exception
    when others then null;
  end;

  perform cron.schedule(
    'sweep-twitch-metadata-cache',
    '7 * * * *',
    $job$select public.sweep_twitch_metadata_cache(interval '12 hours')$job$
  );

  /*
   * The scheduler's own bookkeeping is not a client surface.
   *
   * cron.job and cron.job_run_details record what runs and when. Nothing
   * sensitive to Watchside is in there, but this project's rule is that a
   * client sees a table because somebody decided it should, and no such
   * decision has been made about these. Belt and braces, in the same shape
   * 0017 used on the cache itself.
   */
  begin
    revoke all on all tables in schema cron from public, anon, authenticated;
  exception
    when others then null;
  end;
end
$mig$;

/*
 * The hosted-schema marker.
 *
 * See tests/db/bundle.test.ts, which is the single place that pins it. 0044
 * takes it because "did the retention schedule reach production" is precisely
 * the sort of question that must have an answer independent of reading a table
 * clients cannot see.
 */
create or replace function public.analytics_schema_version()
returns int
language sql
immutable
set search_path = public, pg_temp
as $$ select 44; $$;

revoke all on function public.analytics_schema_version() from public, anon, authenticated;

commit;
