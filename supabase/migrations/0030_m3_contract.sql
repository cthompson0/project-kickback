-- ===========================================================================
-- 0030 — M3A/M3C analytics contract
--
-- DATA, NOT DDL. No table, column, index, policy or grant changes anywhere in
-- this file. Registering an event is one row in analytics_event_names and
-- widening an event's property list is one array - which is the whole reason
-- adding a measurement to Watchside is cheap.
--
-- Two changes:
--
--   channel_dwell_ended                  a new event (M3C)
--   authenticated_session_started        gains experiment_arm (M3A slice 5)
--
-- THE SERVER MUST NOT TRUST THE CLIENT. src/core/analytics.ts states the same
-- contract in TypeScript and strips unknown keys before sending, but a
-- modified extension can send anything, so analytics_track re-applies this
-- list server-side. tests/extension/analyticsContract.test.ts reads THIS FILE
-- and asserts the two agree, so the duplication cannot drift.
-- ===========================================================================

begin;

insert into public.analytics_event_names (name, description, allowed_properties) values
  /*
   * The denominator every other viewing number needed.
   *
   * watching_together and post_social_retention both measure socially selected
   * slices of viewing, so neither can say what SHARE of somebody's watching
   * Watchside touched - and a future holdout would have nothing to compare,
   * because a control arm produces no shared watches at all.
   *
   * FOCUSED TAB ONLY, LIVE ONLY. One interval at a time, on the same eligible
   * live channel that drives the shared watch. Three open tabs are one
   * interval, not three; an offline channel is none. See
   * src/background/channelDwell.ts.
   *
   * The channel is on the envelope (destination_channel), as for every other
   * destination-bearing event. No title, no category, no viewer count - the
   * duration and the channel are the whole of it.
   */
  ('channel_dwell_ended',
   'How long Watchside observed the user watching one live channel. Focused tab only, live streams only, one interval at a time. Carries duration, whether a JOIN attribution covered it, and whether a shared watch occurred during it.',
   array['duration_ms', 'from_join', 'had_social', 'end_reason']),

  /*
   * The arm, added to the session that already carries the graph size.
   *
   * Present ONLY when the assignment is a real randomisation. Outside
   * production every user is forced into `gravity`, and the client does not
   * send the property there - recording a constant as an experiment result is
   * how a fake causal claim reaches a deck. Absent means "not randomised",
   * never "unknown arm".
   *
   * Registering it does not start an experiment and changes no treatment.
   */
  ('authenticated_session_started',
   'A signed-in session began. Carries the social graph size at that moment, and the experiment arm when - and only when - the assignment is a real production randomisation.',
   array['friend_count', 'group_count', 'experiment_arm'])
on conflict (name) do update
  set description        = excluded.description,
      allowed_properties = excluded.allowed_properties;

/*
 * The applied marker moves to the newest analytics-touching migration.
 *
 * Everything 0029 and 0030 change is a view or a contract row, and both are
 * revoked from every client role - so without this, verify:analytics could not
 * tell a database that stopped at 0028 from one fully up to date. It would
 * report a half-applied schema as healthy, which is precisely the failure that
 * script exists to prevent.
 */
create or replace function public.analytics_schema_version()
returns int
language sql
immutable
set search_path = public, pg_temp
as $$ select 30; $$;

revoke all on function public.analytics_schema_version() from public, anon, authenticated;

commit;
