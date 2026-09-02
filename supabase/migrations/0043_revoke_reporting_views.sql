-- ===========================================================================
-- 0043 — Reporting views were readable by every client. They must not be.
--
-- STOP-SHIP, FOUND IN THE v0.9 RC SECURITY PASS, AND LIVE IN PRODUCTION NOW.
--
-- Supabase grants SELECT on anything newly created in `public` to `anon` and
-- `authenticated` by default. Every earlier reporting view knows this and
-- revokes explicitly - 0014's `analytics_*`, 0034/0035/0036's `m3d_*`, and
-- `feedback_v` all do. Four migrations did not:
--
--   0038  acquisition_actor_v, acquisition_campaign_v, acquisition_downstream_v
--   0039  ops_client_failures_v, ops_health_v
--   0040  acquisition_coverage_v, acquisition_touch_outcomes_v
--   0042  activation_actor_v, activation_funnel_v
--
-- WHY THIS IS SERIOUS RATHER THAN UNTIDY
--
-- A view runs with its OWNER's privileges, so the careful `revoke all on
-- public.users from anon, authenticated` in 0002 does not protect a view built
-- on top of it. These views are per-ACTOR: `acquisition_actor_v` carries every
-- user's acquisition campaign, first-touch time, JOIN clicks, arrivals, gravity
-- impressions, observed dwell and friend count; `activation_actor_v` carries
-- when each account formed its first friendship.
--
-- The publishable key ships inside the extension and is public by design, so
-- `anon` is not a hypothetical role - it is anybody who reads the bundle. These
-- views were reachable over PostgREST with that key.
--
-- Proved rather than reasoned about: a signed-in role SELECTed
-- `activation_actor_v` successfully in the harness, which models Supabase's
-- default grants deliberately.
--
-- WHAT THIS DOES NOT CHANGE
--
-- Nothing a client is supposed to reach. No RPC, no policy, no table grant, no
-- product behaviour. Every one of these views is for the owner reading the
-- database; no released client selects from any of them, which
-- verify:released confirms by listing the RPCs each build actually calls.
--
-- The two trigger functions are revoked in the same spirit. A trigger function
-- called directly raises "trigger functions can only be called as triggers", so
-- this is consistency rather than a hole - but a default grant nobody chose is
-- exactly what produced the problem above.
-- ===========================================================================

begin;

-- --------------------------------------------------------- 0038, M5C
revoke all on public.acquisition_actor_v         from public, anon, authenticated;
revoke all on public.acquisition_campaign_v      from public, anon, authenticated;
revoke all on public.acquisition_downstream_v    from public, anon, authenticated;

-- --------------------------------------------------------- 0039, M6B
revoke all on public.ops_client_failures_v       from public, anon, authenticated;
revoke all on public.ops_health_v                from public, anon, authenticated;

-- --------------------------------------------------------- 0040, coverage
revoke all on public.acquisition_coverage_v      from public, anon, authenticated;
revoke all on public.acquisition_touch_outcomes_v from public, anon, authenticated;

-- --------------------------------------------------------- 0042, activation
revoke all on public.activation_actor_v          from public, anon, authenticated;
revoke all on public.activation_funnel_v         from public, anon, authenticated;

-- --------------------------------------------- 0038's immutability triggers
revoke all on function public.acquisition_first_touch_immutable() from public, anon, authenticated;
revoke all on function public.acquisition_campaign_immutable()    from public, anon, authenticated;

-- ===========================================================================
-- The contract version.
-- ===========================================================================

create or replace function public.analytics_schema_version()
returns int
language sql
immutable
set search_path = public, pg_temp
as $$ select 43; $$;

revoke all on function public.analytics_schema_version() from public, anon, authenticated;

commit;
