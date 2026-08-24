/**
 * Mutation check for the analytics foundation.
 *
 *   npm run test:analytics
 *
 * Analytics tests are unusually easy to write in a way that passes whatever
 * the code does. "An event was recorded" is true of almost any implementation;
 * so is "the property is there". What actually matters is the opposite - that
 * the wrong thing is NOT recorded:
 *
 *   - the actor is the session's, not the client's;
 *   - an impression is one glance, not fifty renders;
 *   - a click is not an arrival, and an arrival is not a JOIN's arrival unless
 *     it answers that JOIN;
 *   - a shared watch does not end because a heartbeat was late, and its
 *     duration does not include the grace period;
 *   - the demo build sends nothing at all;
 *   - and a property the contract does not name never reaches the wire.
 *
 * Each of these breaks the code in exactly one of those ways and asserts that
 * a specific test goes red. A rule nothing notices is a rule nobody is keeping.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const CORE = 'src/core/analytics.ts'
const RECORDER = 'src/background/analytics.ts'
const SESSION = 'src/background/analyticsSession.ts'
const ATTRIBUTION = 'src/background/joinAttribution.ts'
const EXPOSURE = 'src/background/exposure.ts'
const TOGETHER = 'src/background/togetherWatch.ts'
const HUB = 'src/background/analyticsHub.ts'
const MIGRATION = 'supabase/migrations/0013_analytics.sql'

const CONTRACT_SUITE = 'tests/extension/analyticsContract.test.ts'
const RECORDER_SUITE = 'tests/extension/analyticsRecorder.test.ts'
const SESSION_SUITE = 'tests/extension/analyticsSession.test.ts'
const ATTRIBUTION_SUITE = 'tests/extension/joinAttribution.test.ts'
const EXPOSURE_SUITE = 'tests/extension/exposureAndTogether.test.ts'
const HUB_SUITE = 'tests/extension/analyticsHub.test.ts'
const DB_SUITE = 'tests/db/analytics.test.ts'
const MIGRATION_15 = 'supabase/migrations/0015_social_discovery.sql'
const VIEWS_16 = 'supabase/migrations/0016_social_discovery_views.sql'
const LIFECYCLE_SUITE = 'tests/extension/socialLifecycle.test.ts'
const WATCH = 'src/background/togetherWatch.ts'
const STORE = 'src/background/togetherStore.ts'
const PRESENCE = 'src/background/presence.ts'
const STORE_SUITE = 'tests/extension/togetherStore.test.ts'

const MUTATIONS = [
  // ------------------------------------------------------------- privacy
  {
    name: 'contract: keep every property a call site passes',
    file: CORE,
    from: "  for (const key of allowed) {\n    if (!Object.hasOwn(properties, key)) continue",
    to: "  for (const key of Object.keys(properties)) {\n    if (!Object.hasOwn(properties, key)) continue",
    expect: 'drops anything the event does not declare',
    suite: CONTRACT_SUITE,
  },
  {
    name: 'contract: allow a property value of any length',
    file: CORE,
    from: '      if (value.length <= MAX_PROPERTY_VALUE_LENGTH) out[key] = value',
    to: '      out[key] = value',
    expect: 'drops a long string even under an allowed key',
    suite: CONTRACT_SUITE,
  },
  {
    name: 'contract: accept a URL as a destination channel',
    file: CORE,
    from: '  return CHANNEL.test(login) ? login : null',
    to: '  return login',
    expect: 'refuses anything that is not one',
    suite: CONTRACT_SUITE,
  },
  {
    name: 'contract: send an event the contract does not know',
    file: CORE,
    from: '  if (!isAnalyticsEventName(request.name)) return null',
    to: '',
    expect: 'refuses an event name the contract does not know',
    suite: CONTRACT_SUITE,
  },
  {
    name: 'server: stop stripping properties to the contract',
    file: MIGRATION,
    from: '    continue when not (v_key = any (p_allowed));',
    to: '',
    expect: 'strips a key the event does not declare',
    suite: DB_SUITE,
  },
  {
    name: 'server: accept any string as a channel',
    file: MIGRATION_15,
    from: "    if v_channel is not null and v_channel !~ '^[a-z0-9_]{1,25}$' then\n      v_channel := null;\n    end if;",
    to: '',
    expect: 'refuses anything that is not one, rather than storing it',
    suite: DB_SUITE,
  },

  // ------------------------------------------------------- authorization
  {
    name: 'server: trust an actor the client supplies',
    file: MIGRATION_15,
    from: "  v_actor    uuid := public.require_actor();",
    to: "  v_actor    uuid := coalesce((p_events -> 0 ->> 'actor_id')::uuid, public.require_actor());",
    expect: 'ignores an actor the client tries to supply',
    suite: DB_SUITE,
  },
  {
    name: 'server: let clients read their own analytics',
    file: MIGRATION,
    from: 'revoke all on public.analytics_events       from anon, authenticated;',
    to: 'grant select on public.analytics_events to authenticated;',
    expect: 'refuses a direct read of the events table',
    suite: DB_SUITE,
  },
  {
    name: 'server: let anyone reset an environment',
    file: MIGRATION,
    from: 'revoke all on function public.analytics_reset_environment(text, text)\n  from public, anon, authenticated;',
    to: 'grant execute on function public.analytics_reset_environment(text, text) to authenticated;',
    expect: 'is not executable by a client at all',
    suite: DB_SUITE,
  },
  {
    name: 'server: reset without a confirmation phrase',
    file: MIGRATION,
    from: '  if p_confirm is distinct from v_expected then',
    to: '  if false then',
    expect: 'refuses without the confirmation phrase',
    suite: DB_SUITE,
  },
  {
    name: 'server: let a reset take every environment with it',
    file: MIGRATION,
    from: '  delete from public.analytics_events where environment = p_environment;',
    to: '  delete from public.analytics_events;',
    expect: 'clears only the environment it was asked to clear',
    suite: DB_SUITE,
  },

  // ---------------------------------------------------------- rate guard
  {
    name: 'server: charge the budget per call rather than per event',
    file: MIGRATION_15,
    from: "  if not public.consume_rate_budget_n(\n       'analytics',\n       least(jsonb_array_length(p_events), 50),",
    to: "  if not public.consume_rate_budget_n(\n       'analytics',\n       1,",
    expect: 'counts events rather than calls, so batching cannot cheat it',
    suite: DB_SUITE,
  },
  {
    name: 'server: accept a batch of any size',
    file: MIGRATION_15,
    from: '    exit when v_seen > 50;',
    to: '',
    expect: 'caps a single batch, so one call cannot be a bulk import',
    suite: DB_SUITE,
  },
  {
    // One shared budget for everybody: one noisy client would silence the rest.
    name: 'server: make the budget global rather than per person',
    file: MIGRATION,
    from: '  v_actor  uuid := public.require_actor();\n  v_writes int;',
    to: '  v_actor  uuid := (select id from public.users order by id limit 1);\n  v_writes int;',
    expect: 'is per person, not global',
    suite: DB_SUITE,
  },

  // ------------------------------------------------ best-effort behaviour
  {
    name: 'recorder: send even when disabled',
    file: RECORDER,
    from: '      // One check, at the top. There is no path past here when disabled.\n      if (!deps.enabled) return',
    to: '',
    expect: 'queues nothing and sends nothing',
    suite: RECORDER_SUITE,
  },
  {
    name: 'recorder: let a failing backend reach the caller',
    file: RECORDER,
    from: '    } catch (error) {\n      deps.onError?.(\'analytics.flush\', error)',
    to: '    } catch (error) {\n      deps.onError?.(\'analytics.flush\', error)\n      throw error',
    expect: 'does not reject when flushed',
    suite: RECORDER_SUITE,
  },
  {
    name: 'recorder: retry immediately rather than backing off',
    file: RECORDER,
    from: '      backoffMs = Math.min(backoffMs === 0 ? flushDelayMs * 2 : backoffMs * 2, MAX_BACKOFF_MS)',
    to: '      backoffMs = 0',
    expect: 'backs off rather than retrying in a storm',
    suite: RECORDER_SUITE,
  },
  {
    name: 'recorder: let the queue grow without bound',
    file: RECORDER,
    from: '      while (queue.length > maxQueue) queue.shift()',
    to: '',
    expect: 'drops the oldest rather than growing without limit',
    suite: RECORDER_SUITE,
  },
  {
    name: 'recorder: drop events instead of holding them until sign-in',
    file: RECORDER,
    from: '    if (!deps.enabled || !deps.canSend()) return',
    to: '    if (!deps.enabled) return\n    if (!deps.canSend()) { queue.length = 0; return }',
    expect: 'holds events until there is somebody to attribute them to',
    suite: RECORDER_SUITE,
  },
  {
    name: 'recorder: exceed the batch the server accepts',
    file: RECORDER,
    from: '    const batch = queue.splice(0, maxBatch)',
    to: '    const batch = queue.splice(0, queue.length)',
    expect: 'never exceeds the batch the server accepts',
    suite: RECORDER_SUITE,
  },

  // ------------------------------------------------------------ sessions
  {
    name: 'session: start a new one on every wake-up',
    file: SESSION,
    from: '      if (existing && at - existing.lastActiveAt < idleMs) {',
    to: '      if (false) {',
    expect: 'resumes the stored session rather than starting a new one',
    suite: SESSION_SUITE,
  },
  {
    name: 'session: never expire',
    file: SESSION,
    from: '      if (existing && at - existing.lastActiveAt < idleMs) {',
    to: '      if (existing) {',
    expect: 'starts a new one once the idle window has passed',
    suite: SESSION_SUITE,
  },
  {
    name: 'session: end an expired session at the moment it was noticed',
    file: SESSION,
    from: 'export function sessionDuration(record: SessionRecord): number {\n  return Math.max(0, record.lastActiveAt - record.startedAt)',
    to: 'export function sessionDuration(record: SessionRecord): number {\n  return Math.max(0, Date.now() - record.startedAt)',
    expect: 'hands back the expired session so its end can be recorded',
    suite: SESSION_SUITE,
  },
  {
    name: 'session: accept whatever storage returns',
    file: 'src/background/storedValue.ts',
    from: '        return isValid(value) ? value : null',
    to: '        return (value ?? null) as T | null',
    expect: 'treats a malformed record as absent',
    suite: SESSION_SUITE,
  },

  // --------------------------------------------------------- attribution
  {
    name: 'attribution: credit an arrival anywhere to the last JOIN',
    file: ATTRIBUTION,
    from: '      if (!channel || channel !== current.channel) return null',
    to: '',
    expect: 'does not claim an arrival somewhere else',
    suite: ATTRIBUTION_SUITE,
  },
  {
    name: 'attribution: never expire a pending click',
    file: ATTRIBUTION,
    from: '      return at - value.clickedAt <= arrivalWindowMs ? value : null',
    to: '      return value',
    expect: 'expires a click that never arrives',
    suite: ATTRIBUTION_SUITE,
  },
  {
    name: 'attribution: answer the same click over and over',
    file: ATTRIBUTION,
    from: "      if (current.state !== 'pending') return null",
    to: '',
    expect: 'answers an arrival only once',
    suite: ATTRIBUTION_SUITE,
  },
  {
    name: 'attribution: credit a shared watch to a click that never arrived',
    file: ATTRIBUTION,
    from: "      if (current.state !== 'arrived') return null",
    to: '',
    expect: 'credits nothing while the click is still pending',
    suite: ATTRIBUTION_SUITE,
  },
  {
    name: 'attribution: keep crediting forever',
    file: ATTRIBUTION,
    from: '    return at - (value.arrivedAt ?? value.clickedAt) <= togetherWindowMs ? value : null',
    to: '    return value',
    expect: 'stops crediting a shared watch once the window has passed',
    suite: ATTRIBUTION_SUITE,
  },

  // ---------------------------------------------------------- impressions
  {
    name: 'exposure: emit an impression on every render',
    file: EXPOSURE,
    from: '        const wasAway = !record.present && at - record.seenAt >= absenceMs',
    to: '        const wasAway = true',
    expect: 'stays silent while it goes on being visible',
    suite: EXPOSURE_SUITE,
  },
  {
    name: 'exposure: treat a momentary blink as a new exposure',
    file: EXPOSURE,
    from: '        const wasAway = !record.present && at - record.seenAt >= absenceMs',
    to: '        const wasAway = !record.present',
    expect: 'is not a new exposure for a blink',
    suite: EXPOSURE_SUITE,
  },
  {
    name: 'exposure: never emit again, however long the panel is open',
    file: EXPOSURE,
    from: '        const windowPassed = at - record.emittedAt >= windowMs',
    to: '        const windowPassed = false',
    expect: 'emits again after the window, for a panel left open all evening',
    suite: EXPOSURE_SUITE,
  },
  {
    name: 'exposure: forget nothing, ever',
    file: EXPOSURE,
    from: '    if (seen.size <= maxKeys) return',
    to: '    return\n    if (seen.size <= maxKeys) return',
    expect: 'does not grow without bound',
    suite: EXPOSURE_SUITE,
  },

  // ----------------------------------------------------- shared watching
  {
    name: 'together: end the moment a heartbeat is late',
    file: TOGETHER,
    from: '        } else if (state.aloneSince === null) {',
    to: '        } else if (false) {',
    expect: 'does not end on a presence flap',
    suite: EXPOSURE_SUITE,
  },
  {
    name: 'together: count the grace period as watching together',
    file: TOGETHER,
    from: '      const effectiveAt = state.aloneSince ?? at',
    to: '      const effectiveAt = at',
    expect: 'ends the shared watch when A actually left, not when B did',
    suite: LIFECYCLE_SUITE,
  },
  {
    name: 'together: report the final count rather than the peak',
    file: TOGETHER,
    from: '          state.otherCountPeak = Math.max(state.otherCountPeak, otherCount)',
    to: '          state.otherCountPeak = otherCount',
    expect: 'reports the most people it ever had, not the last',
    suite: EXPOSURE_SUITE,
  },
  {
    name: 'together: keep the session open after navigating away',
    file: TOGETHER,
    from: "      if (state && state.channel !== channel) {\n        events.push(...closeAll('left_channel', at))",
    to: "      if (false) {\n        events.push(...closeAll('left_channel', at))",
    expect: 'ends at once when the user navigates away',
    suite: EXPOSURE_SUITE,
  },
  {
    name: 'together: start a shared watch when nobody else is there',
    file: TOGETHER,
    from: '      if (otherCount > 0) {\n        state = {',
    to: '      if (true) {\n        state = {',
    expect: 'does not start when watching alone',
    suite: EXPOSURE_SUITE,
  },

  // ------------------------------------------------------------- the hub
  {
    name: 'hub: mint an attribution for a click that goes nowhere',
    file: HUB,
    from: '        const minted = input.navigated\n          ? await attribution.click({',
    to: '        const minted = true\n          ? await attribution.click({',
    expect: 'records a click that goes nowhere without pretending an arrival is coming',
    suite: HUB_SUITE,
  },
  {
    name: 'hub: let a disabled build record everything anyway',
    file: HUB,
    from: '  const off = !deps.enabled',
    to: '  const off = false',
    expect: 'opens no session and writes nothing to storage',
    suite: HUB_SUITE,
  },
  {
    name: 'hub: date an expired session to now instead of when it ended',
    file: HUB,
    from: '            sessionId: outcome.expired.id,\n            occurredAt: outcome.expired.lastActiveAt,',
    to: '            sessionId: outcome.expired.id,',
    expect: 'starts a second session only after the idle window',
    suite: HUB_SUITE,
  },
  {
    name: 'hub: record an event with no session',
    file: HUB,
    from: '    if (session.currentId()) {\n      recorder.track(request)\n      return\n    }',
    to: '    recorder.track(request)\n    if (true) return',
    expect: 'opens one and puts every event in it',
    suite: HUB_SUITE,
  },
  {
    name: 'hub: report an impression for anything, channel or not',
    file: HUB,
    from: '        const channel = normalizeChannel(friend.channel)\n        if (!channel) continue',
    to: '        const channel = friend.channel',
    expect: 'ignores anything that is not a channel',
    suite: HUB_SUITE,
  },
  {
    name: 'hub: keep the previous account events after sign-out',
    file: HUB,
    from: '        await recorder.flush()\n        recorder.clear()',
    to: '        await recorder.flush()',
    expect: 'never sends the previous account events under the next account',
    suite: HUB_SUITE,
  },

  // ------------------------------------------- social discovery semantics
  //
  // The observed bug and its neighbours. Every one of these was true of the
  // code that shipped, and none of them changed a duration by enough for a
  // duration assertion to notice - which is why the tests they point at assert
  // the effective TIME and the REASON as hard as the length.
  {
    name: 'together: date the end of co-viewing to when it was noticed',
    file: HUB,
    from: '          occurredAt: event.effectiveAt,',
    to: '          occurredAt: event.detectedAt,',
    expect: 'dates the end of co-viewing to when it happened, not when it was noticed',
    suite: HUB_SUITE,
  },
  {
    name: 'together: measure the shared watch to the detection instead of the end',
    file: TOGETHER,
    from: '      durationMs: Math.max(0, effectiveAt - open.startedAt),',
    to: '      durationMs: Math.max(0, detectedAt - open.startedAt),',
    expect: 'records the shared watch as ten minutes, not fifty',
    suite: LIFECYCLE_SUITE,
  },
  {
    name: 'together: blame whatever revealed the end rather than what caused it',
    file: TOGETHER,
    from:
      "      out.push(\n        togetherEnded(state.aloneSince !== null ? 'alone_again' : reason, effectiveAt, detectedAt),\n      )",
    to: '      out.push(togetherEnded(reason, effectiveAt, detectedAt))',
    expect: 'says it ended because everyone left, not because B did',
    suite: LIFECYCLE_SUITE,
  },
  {
    name: 'together: throw away the detection lag',
    file: HUB,
    from: '            detection_delay_ms: Math.max(0, event.detectedAt - event.effectiveAt),',
    to: '            detection_delay_ms: 0,',
    expect: 'dates the end of co-viewing to when it happened, not when it was noticed',
    suite: HUB_SUITE,
  },

  // ------------------------------------------------- post-social retention
  {
    name: 'retention: never record the time spent alone afterwards',
    file: TOGETHER,
    from: "      if (state.aloneSince !== null) out.push(postSocialEnded(reason, state.aloneSince, at))",
    to: '',
    expect: 'records the forty minutes B stayed on alone',
    suite: LIFECYCLE_SUITE,
  },
  {
    name: 'retention: start it when the user leaves rather than when the friends did',
    file: TOGETHER,
    from: '      durationMs: Math.max(0, at - from),',
    to: '      durationMs: 0,',
    expect: 'records the forty minutes B stayed on alone',
    suite: LIFECYCLE_SUITE,
  },
  {
    name: 'retention: begin it before the social context has dissolved',
    file: TOGETHER,
    from: '          state.otherCountPeak = Math.max(state.otherCountPeak, otherCount)\n          state.aloneSince = null',
    to: '          state.otherCountPeak = Math.max(state.otherCountPeak, otherCount)',
    expect: 'counts the whole stretch, including the flap, as together',
    suite: LIFECYCLE_SUITE,
  },
  {
    name: 'retention: leave a gap between co-viewing ending and retention starting',
    file: TOGETHER,
    from: '          events.push(togetherEnded(\'alone_again\', state.aloneSince, at))\n          state.socialEndedAt = state.aloneSince',
    to: '          events.push(togetherEnded(\'alone_again\', state.aloneSince, at))\n          state.socialEndedAt = at',
    expect: 'leaves no gap or overlap between the two intervals',
    suite: LIFECYCLE_SUITE,
  },

  // --------------------------------------------- last friend, not any friend
  {
    name: 'together: end as soon as the group starts thinning out',
    file: TOGETHER,
    from: '        if (otherCount > 0) {\n          state.otherCountPeak = Math.max(state.otherCountPeak, otherCount)',
    to: '        if (otherCount >= state.otherCountPeak) {\n          state.otherCountPeak = Math.max(state.otherCountPeak, otherCount)',
    expect: 'keeps the shared watch going while any of them remain',
    suite: LIFECYCLE_SUITE,
  },

  // ------------------------------------------------------ cluster attribution
  {
    name: 'cluster: drop the attribution when friends come back',
    file: TOGETHER,
    from: '            attributionId: state.attributionId,\n            aloneSince: null,\n            socialEndedAt: null,\n          }\n          events.push({',
    to: '            attributionId: null,\n            aloneSince: null,\n            socialEndedAt: null,\n          }\n          events.push({',
    expect: 'closes the retention and opens a new shared watch',
    suite: LIFECYCLE_SUITE,
  },
  {
    name: 'cluster: credit an organic shared watch to a JOIN anyway',
    file: HUB,
    from: "          from_join: event.attributionId !== null,\n          end_reason: event.reason,",
    to: '          from_join: true,\n          end_reason: event.reason,',
    expect: 'claims no JOIN credit for organic co-viewing',
    suite: HUB_SUITE,
  },
  {
    name: 'cluster: record one shared watch per friend rather than per opportunity',
    file: TOGETHER,
    from: '      if (state && state.socialEndedAt !== null) {',
    to: '      if (state && state.socialEndedAt !== null && false) {',
    expect: 'closes the retention and opens a new shared watch',
    suite: LIFECYCLE_SUITE,
  },

  // -------------------------------------------------------- client clocks
  {
    name: 'clock: accept an event dated a day into the future again',
    file: MIGRATION_15,
    from: "       or v_occurred > now() + interval '5 minutes'",
    to: "       or v_occurred > now() + interval '1 day'",
    expect: 'refuses an event dated in the future',
    suite: DB_SUITE,
  },
  {
    name: 'clock: refuse the late-arriving events this whole design depends on',
    file: MIGRATION_15,
    from: "       or v_occurred < now() - interval '1 day' then",
    to: "       or v_occurred < now() - interval '5 minutes' then",
    expect: 'accepts an event dated well in the past, because late detection is real',
    suite: DB_SUITE,
  },

  // ------------------------------------------------------ contract and views
  {
    name: 'contract: forget to register the cluster identity',
    file: MIGRATION_15,
    from: "   array['social_count', 'already_on_twitch', 'already_on_destination', 'navigated',\n         'opportunity_key']),",
    to: "   array['social_count', 'already_on_twitch', 'already_on_destination', 'navigated']),",
    expect: 'round-trips on a join, so Social Gravity needs no contract change',
    suite: DB_SUITE,
  },
  {
    name: 'contract: leave the detection lag out of the event contract',
    file: MIGRATION_15,
    from: "   array['other_count_peak', 'duration_ms', 'end_reason', 'detection_delay_ms']),",
    to: "   array['other_count_peak', 'duration_ms', 'end_reason']),",
    expect: 'reads the LATER definition when a migration revises one',
    suite: CONTRACT_SUITE,
  },
  {
    name: 'views: report every shared watch as retained',
    file: VIEWS_16,
    from: '  p.id is not null              as post_social_retained',
    to: '  true                          as post_social_retained',
    expect: 'reports no retention when the user left first',
    suite: DB_SUITE,
  },
  {
    name: 'views: collapse the effective end into the detection time',
    file: VIEWS_16,
    from: '  e.occurred_at                 as effective_ended_at,',
    to: '  e.occurred_at\n    + make_interval(secs => coalesce((e.properties ->> \'detection_delay_ms\')::bigint, 0) / 1000.0)\n                                as effective_ended_at,',
    expect: 'separates when co-viewing ended from when we noticed',
    suite: DB_SUITE,
  },

  // ------------------------------------------- surviving a worker restart
  //
  // The interval state is in a closure and an MV3 worker is evicted at will,
  // so the intervals most likely to be lost were the long ones - exactly the
  // ones Social Gravity will be judged on. These break each recovery rule in
  // turn.
  {
    name: 'restart: never write the open interval down',
    file: HUB,
    from:
      '        if (together.current()) lifecycleSeenAt = now()\n        await persistLifecycle(now())',
    to: '',
    expect: 'resumes a shared watch that is still going',
    suite: HUB_SUITE,
  },
  {
    name: 'restart: never read it back',
    file: HUB,
    from: '        await ensureLifecycle(login, now())',
    to: '',
    expect: 'resumes a shared watch that is still going',
    suite: HUB_SUITE,
  },
  {
    name: 'restart: emit a second start when resuming',
    file: WATCH,
    from: '      state = { ...restored }\n      pendingAttribution = null',
    to: '      pendingAttribution = null',
    expect: 'does not double-emit across several restarts',
    suite: HUB_SUITE,
  },
  {
    name: 'restart: credit the whole outage as viewing time',
    file: STORE,
    from: "      effectiveAt: stored.lastSeenAt,\n      reason: 'observation_lost',",
    to: "      effectiveAt: world.now,\n      reason: 'observation_lost',",
    expect: 'closes a stale interval at the last moment it could vouch for',
    suite: HUB_SUITE,
  },
  {
    name: 'restart: resume however long the gap was',
    file: STORE,
    from: '  if (isObservationLost(stored.lastSeenAt, world.now, resumeWindowMs)) {',
    to: '  if (false) {',
    expect: 'closes a stale interval at the last moment it could vouch for',
    suite: HUB_SUITE,
  },
  {
    name: 'restart: resume an interval for a channel they are no longer on',
    file: STORE,
    from: '  if (stored.state.channel !== world.channel) {',
    to: '  if (false) {',
    expect: 'closes an interval whose channel changed while nothing was running',
    suite: HUB_SUITE,
  },
  {
    name: 'restart: split every restart into two intervals',
    file: STORE,
    from: "  return { action: 'resume', lifecycle: stored }",
    to: "  return {\n    action: 'close',\n    lifecycle: stored,\n    effectiveAt: stored.lastSeenAt,\n    reason: 'observation_lost',\n  }",
    expect: 'resumes a shared watch that is still going',
    suite: HUB_SUITE,
  },
  {
    name: 'restart: lose the post-social interval across a restart',
    file: HUB,
    from: '    lifecycleSessionId = decision.lifecycle.sessionId\n    together.restore(decision.lifecycle.state)',
    to: '    lifecycleSessionId = decision.lifecycle.sessionId',
    expect: 'carries post-social retention through a restart',
    suite: HUB_SUITE,
  },
  {
    name: 'restart: file the end under whatever session is open now',
    file: HUB,
    from: "        lifecycleSessionId = session.currentId()\n        record({\n          name: 'watching_together_started',",
    to: "        lifecycleSessionId = null\n        record({\n          name: 'watching_together_started',",
    expect: 'pins the interval to the session it began in',
    suite: HUB_SUITE,
  },

  // ---------------------------------------- gaps a living worker woke from
  //
  // The restore path only runs once per worker life, which is right for a
  // worker that died and wrong for one an OS suspend merely froze. These break
  // the tick-time recheck in each of the ways that would let a sleep be
  // counted as viewing.
  {
    name: 'sleep: never doubt an interval the worker is already holding',
    file: HUB,
    // Anchored on the comment: the call itself appears twice, and the first
    // occurrence in the file is the sign-out one.
    from: '         */\n        closeIfObservationLost(now())\n\n        /*',
    to: '         */\n\n        /*',
    expect: 'closes a shared watch at the last moment it could vouch for',
    suite: HUB_SUITE,
  },
  {
    name: 'sleep: close at the moment we noticed rather than the last we saw',
    file: HUB,
    from: "    emitTogether(together.closeAt('observation_lost', lifecycleSeenAt, now))",
    to: "    emitTogether(together.closeAt('observation_lost', now, now))",
    expect: 'closes a shared watch at the last moment it could vouch for',
    suite: HUB_SUITE,
  },
  {
    name: 'sleep: let the tick answer differently from a restart',
    file: HUB,
    from: '    if (!isObservationLost(lifecycleSeenAt, now)) return',
    to: '    if (true) return',
    expect: 'gives the same answer whether the worker survived or not',
    suite: HUB_SUITE,
  },
  {
    name: 'sleep: doubt every interval, however recently seen',
    file: HUB,
    from: '    if (!isObservationLost(lifecycleSeenAt, now)) return',
    to: '    if (false) return',
    expect: 'leaves a short gap alone',
    suite: HUB_SUITE,
  },
  {
    name: 'sleep: stop tracking when we last vouched for the interval',
    file: HUB,
    from: '        if (together.current()) lifecycleSeenAt = now()',
    to: '',
    expect: 'leaves a short gap alone',
    suite: HUB_SUITE,
  },
  {
    name: 'sleep: credit the gap as post-social retention',
    file: HUB,
    from: '  function closeIfObservationLost(now: number): void {\n    if (!together.current()) return',
    to: '  function closeIfObservationLost(now: number): void {\n    if (true) return',
    expect: 'does not credit a sleep as post-social retention',
    suite: HUB_SUITE,
  },
  {
    name: 'sleep: let signing out after one close at the wrong moment',
    file: HUB,
    from: "        closeIfObservationLost(now())\n        emitTogether(together.stop())",
    to: '        emitTogether(together.stop())',
    expect: 'does not credit a sleep when the user signs out on waking',
    suite: HUB_SUITE,
  },
  {
    name: 'sleep: store the write time rather than the tick time',
    file: HUB,
    from: '      lastSeenAt: lifecycleSeenAt,',
    to: '      lastSeenAt: now,',
    expect: 'closes a stale interval at the last moment it could vouch for',
    suite: HUB_SUITE,
    // The two agree whenever a write is not throttled, so this only bites on
    // the alignment the restart tests happen to exercise.
    optional: true,
  },
  {
    name: 'sleep: give the two callers different staleness rules',
    file: STORE,
    from: '  return now - lastSeenAt > resumeWindowMs',
    to: '  return now - lastSeenAt > resumeWindowMs * 100',
    expect: 'rejects anything past it',
    suite: STORE_SUITE,
  },

  // --------------------------------------------------- account and cleanup
  {
    name: 'accounts: resume one person interval under the next',
    file: STORE,
    from: "  if (stored.userId !== world.userId) return { action: 'discard', why: 'other_account' }",
    to: '',
    expect: 'never emits one account interval under the next',
    suite: HUB_SUITE,
  },
  {
    name: 'accounts: keep the stored interval after signing out',
    file: HUB,
    from: '        await deps.lifecycleStore.write(null)\n        persistedJson = null\n        lifecycleSessionId = null',
    to: '        lifecycleSessionId = null',
    expect: 'clears the stored interval on sign-out',
    suite: HUB_SUITE,
  },
  {
    name: 'cleanup: leave the interval in storage once it is over',
    file: HUB,
    from: '    if (!state) {\n      if (persistedJson !== null) {\n        await deps.lifecycleStore.write(null)\n        persistedJson = null\n      }\n      return\n    }',
    to: '    if (!state) return',
    expect: 'stores nothing once the interval is over',
    suite: HUB_SUITE,
  },
  {
    name: 'cleanup: trust whatever shape storage returns',
    file: STORE,
    from: '  if (typeof state.channel !== \'string\' || state.channel === \'\') return false',
    to: '',
    expect: 'rejects anything it does not fully understand',
    suite: STORE_SUITE,
  },
  {
    name: 'cleanup: persist an interval with no owner',
    file: HUB,
    from: '    const userId = deps.selfId()\n    if (!userId) return',
    to: "    const userId = deps.selfId() ?? 'unknown'",
    expect: 'stores nothing while there is nobody to store it for',
    suite: HUB_SUITE,
  },
  {
    name: 'disabled: write the interval to storage anyway',
    file: HUB,
    from: '  const off = !deps.enabled',
    to: '  const off = false',
    expect: 'stores nothing at all when analytics is disabled',
    suite: HUB_SUITE,
  },

  // ------------------------------------------------------ liveness signal
  {
    name: 'liveness: stop refreshing last-seen on the heartbeat',
    file: PRESENCE,
    from: '      deps.onHeartbeat?.()',
    to: '',
    expect: 'ticks on every presence heartbeat, before the write',
    suite: STORE_SUITE,
  },
]

const REPORT = join(tmpdir(), 'kickback-analytics-mutation.json')

function runSuite(suite) {
  rmSync(REPORT, { force: true })

  let crashOutput = null
  try {
    execFileSync('npx', ['vitest', 'run', suite, '--reporter=json', `--outputFile=${REPORT}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    })
  } catch (error) {
    crashOutput = `${error.stdout ?? ''}${error.stderr ?? ''}`
  }

  if (!existsSync(REPORT)) return { failures: [], crashed: crashOutput ?? 'no report written' }

  const report = JSON.parse(readFileSync(REPORT, 'utf8'))
  const failures = []
  for (const file of report.testResults ?? []) {
    for (const assertion of file.assertionResults ?? []) {
      if (assertion.status === 'failed') failures.push(assertion.title)
    }
  }
  if (failures.length === 0 && (report.numTotalTests ?? 0) === 0) {
    return { failures: [], crashed: crashOutput ?? 'suite ran no tests' }
  }
  return { failures, crashed: null }
}

let failed = 0
let optionalMisses = 0

for (const mutation of MUTATIONS) {
  const original = readFileSync(mutation.file, 'utf8')

  if (!original.includes(mutation.from)) {
    console.log(`SKIPPED  ${mutation.name}`)
    console.log(`         anchor no longer present in ${mutation.file} - update this check`)
    failed += 1
    continue
  }

  writeFileSync(mutation.file, original.replace(mutation.from, () => mutation.to))
  let result
  try {
    result = runSuite(mutation.suite)
  } finally {
    writeFileSync(mutation.file, original)
  }

  if (result.crashed) {
    /*
     * A mutation that will not compile is not evidence of anything, in either
     * direction. It is reported rather than counted as a pass, because a check
     * that quietly never runs is worse than no check.
     */
    console.log(`INCONCLUSIVE ${mutation.name}`)
    console.log(`         the mutated source did not run: ${result.crashed.slice(0, 160)}`)
    failed += 1
    continue
  }

  if (result.failures.some((name) => name.includes(mutation.expect))) {
    console.log(`DETECTED ${mutation.name}`)
    console.log(`         caught by: ${mutation.expect}`)
  } else if (result.failures.length > 0) {
    console.log(`MISATTRIBUTED ${mutation.name}`)
    console.log(`         expected: ${mutation.expect}`)
    console.log(`         actual:   ${result.failures.slice(0, 4).join(', ')}`)
    if (mutation.optional) optionalMisses += 1
    else failed += 1
  } else {
    console.log(`UNDETECTED ${mutation.name}`)
    console.log('         no test noticed - the suite does not defend this')
    if (mutation.optional) optionalMisses += 1
    else failed += 1
  }
}

console.log(
  failed === 0
    ? `\nAll ${MUTATIONS.length - optionalMisses} required analytics mutations detected` +
        (optionalMisses > 0 ? ` (${optionalMisses} advisory checks did not bite).` : '.')
    : `\n${failed} of ${MUTATIONS.length} mutations were not properly detected.`,
)

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(failed === 0 ? 0 : 1)
}
