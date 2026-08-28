-- ===========================================================================
-- 0024 — Failure telemetry
--
-- Three event names, and nothing else. No table, no policy, no function beyond
-- the version marker: this migration exists because the event-name registry is
-- the server's independent copy of what the client may send, and a name that is
-- not in it is discarded on arrival.
--
-- WHY THIS IS THE FIRST THING AFTER THE FIRST BETA ROUND
--
-- Round one produced ten findings. Nine were diagnosable from the source. The
-- tenth - a tester who could see a group but not participate in it - was not,
-- because every failure in the extension went to console.warn and stopped
-- there. The whole server-side hypothesis space had to be eliminated by
-- re-executing the schema against a reconstructed topology, and the actual
-- cause is still unknown. See
-- docs/reports/friends-beta-investigation-2026-08-27.md §2 and §17.
--
-- The architecture review then asked for this specifically, and asked for it
-- BEFORE the multi-destination presence work, so that change lands into a
-- system that can report its own failures. See
-- docs/reports/multi-stream-room-architecture-2026-08-27.md §16.
--
-- WHY AN ERROR EVENT DOES NOT BREAK THE PRIVACY MODEL
--
-- Because it carries no error. Every property here is a member of a fixed
-- array declared in src/core/failures.ts: a call site from a known list, a
-- failure shape from a known list, a subscription name from a known list.
-- Nothing is derived from an exception message, a response body, or anything a
-- person typed. An unrecognised value becomes 'unknown', which is a real
-- signal rather than a hole.
--
-- The 64-character value cap and the allowed_properties whitelist below apply
-- to these exactly as they apply to every other event, so even a modified
-- extension cannot smuggle text through them: an unknown key is stripped, and
-- an over-long value is dropped.
--
-- WHAT IS DELIBERATELY NOT HERE
--
-- No stack traces. No exception messages. No request or response bodies. No
-- channel names on client_error - a failure to fetch history is interesting;
-- which streamer it was is not, and it would turn an error log into a viewing
-- record. No user ids, here as everywhere: actor_id is already the only
-- identity in this table and it is set by the server.
-- ===========================================================================

begin;

insert into public.analytics_event_names (name, description, allowed_properties) values
  ('client_error',
   'Something in the extension failed. Carries a call site and a failure shape, both from fixed lists; never a message.',
   array['context', 'code']),
  ('realtime_status_changed',
   'A realtime subscription connected, failed, or came back. Connections are recorded too, so a silent channel can be told from an absent one.',
   array['surface', 'status']),
  ('group_message_send_failed',
   'A group message was refused. Answers "did they send and never see it, or never send at all". The body is never recorded.',
   array['code'])
on conflict (name) do update
  set description        = excluded.description,
      allowed_properties = excluded.allowed_properties;

/*
 * The applied marker, as 0016 asks: the newest analytics-touching migration
 * owns it, because everything else these files change is revoked from clients
 * and so is invisible to verify:analytics.
 */
create or replace function public.analytics_schema_version()
returns int
language sql
immutable
set search_path = public, pg_temp
as $fn$ select 24 $fn$;

revoke all on function public.analytics_schema_version() from public, anon, authenticated;

commit;
