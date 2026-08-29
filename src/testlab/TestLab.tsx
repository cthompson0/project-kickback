import { useEffect, useMemo, useState } from 'react'
import { KickbackPanel } from '../ui/KickbackPanel'
import { setJoinNavigator } from '../platforms/twitch/join'
import { createTestLabClient } from './client'
import type { LabRecord } from './client'
import { CHANNELS, PRESETS, person, preset } from './presets'
import { REACTIONS } from '../core/together'
import { advance, canonicalChannel, updateUser } from './world'
import type { SimChannelMeta, SimUser, SimWorld } from './world'

/**
 * The Test Lab surface.
 *
 * Left: the world. Right: the real Watchside panel, rendered from that world
 * through production code. Nothing on the left draws anything social - it only
 * describes people - so if the right-hand side is wrong, production is wrong.
 *
 * Two details that look cosmetic and are not:
 *
 *   - The observer's channel is written into the page URL. `useKickbackState`
 *     reads the local user's channel from `getCurrentChannel()`, which parses
 *     `window.location.pathname`, so this is how HERE, "watching with you" and
 *     the JOIN-to-where-you-already-are guard get exercised for real instead
 *     of being told the answer.
 *   - The panel is mounted in a full-viewport `.kb-root` layer, exactly as the
 *     content script mounts it, so its own layout and drag logic behave as
 *     they do on Twitch rather than inside some lab-shaped box.
 */

const STALE_MS = 120_000

interface LabState {
  world: SimWorld
  presetId: string
}

/** Push the observer's channel into the URL, where production reads it from. */
function syncObserverUrl(channel: string | null): void {
  const path = channel ? `/${canonicalChannel(channel)}` : '/'
  if (window.location.pathname === path) return
  window.history.replaceState(null, '', path)
  // watchChannel polls, but also listens; this makes the panel react at once.
  window.dispatchEvent(new PopStateEvent('popstate'))
}

export function TestLab() {
  const [{ world, presetId }, setLab] = useState<LabState>(() => ({
    world: preset('two').build(),
    presetId: 'two',
  }))
  const [records, setRecords] = useState<LabRecord[]>([])
  const [blocked, setBlocked] = useState<string[]>([])

  const handle = useMemo(() => {
    const created = createTestLabClient({
      world,
      appVersion: __KICKBACK_VERSION__,
      onWorldChange: (next) => setLab((lab) => ({ ...lab, world: next })),
    })
    return created
    // Created once. The world is pushed in below rather than rebuilding the
    // client, so analytics sessions and exposure windows survive every edit -
    // which is the whole point of being able to cross them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => handle.subscribeRecords(setRecords), [handle])

  useEffect(() => {
    if (handle.getWorld() !== world) handle.setWorld(world)
    syncObserverUrl(world.observer.channel)
  }, [handle, world])

  // The real JOIN runs; only the browser's final navigation is intercepted.
  useEffect(() => {
    setJoinNavigator((url) => {
      window.dispatchEvent(new CustomEvent('kb-lab-join', { detail: url }))
    })
    return () => setJoinNavigator(null)
  }, [])

  useEffect(() => {
    const onJoin = (event: Event) => {
      const url = String((event as CustomEvent).detail)
      setBlocked((current) => [`JOIN → ${url}`, ...current].slice(0, 20))
      // The click is recorded by the real analytics path; flush so the
      // inspector shows it now rather than in five seconds.
      void handle.flush()
    }
    window.addEventListener('kb-lab-join', onJoin)
    return () => window.removeEventListener('kb-lab-join', onJoin)
  }, [handle])

  // Keep the inspector close to live without changing production's own timing.
  useEffect(() => {
    const id = window.setInterval(() => void handle.flush(), 1_000)
    return () => window.clearInterval(id)
  }, [handle])

  const setWorld = (next: SimWorld) => setLab((lab) => ({ ...lab, world: next }))
  const patch = (id: string, changes: Partial<SimUser>) => setWorld(updateUser(world, id, changes))

  /** Every canonical channel currently on the map, in a stable order. */
  const destinations = [
    ...new Set(
      world.users
        .filter((user) => user.activity === 'watching' && user.channel.trim())
        .map((user) => canonicalChannel(user.channel)),
    ),
  ].sort()

  /** The room the panel is showing, so the lab can react as its members. */
  const state = handle.client.getState()
  // One channel in the lab, so one entry - read by the observer's own channel
  // exactly as a real panel reads by its own tab's channel.
  const roster = Object.values(state.roomMembers)[0] ?? []

  /** Friends on the observer's channel: exactly who a Together is with. */
  const together = world.observer.channel
    ? world.users.filter(
        (user) =>
          user.relationship === 'friend' &&
          user.activity === 'watching' &&
          user.visibility === 'visible' &&
          canonicalChannel(user.channel) === canonicalChannel(world.observer.channel ?? ''),
      )
    : []

  const setMeta = (login: string, changes: Partial<SimChannelMeta>) =>
    setWorld({
      ...world,
      metadata: {
        ...world.metadata,
        [login]: { live: 'unavailable', ...world.metadata?.[login], ...changes },
      },
    })

  return (
    <div className="lab">
      <aside className="lab-controls">
        <header className="lab-head">
          <h1>Watchside Test Lab</h1>
          <p className="lab-sub">
            Simulated people in. Real presence, clustering, ranking, privacy and UI out.
          </p>
        </header>

        <section>
          <h2>Observer</h2>
          <div className="lab-row">
            <span className="lab-name">{world.observer.displayName}</span>
            <ChannelField
              value={world.observer.channel ?? ''}
              onChange={(channel) =>
                setWorld({ ...world, observer: { ...world.observer, channel: channel || null } })
              }
              placeholder="not watching"
            />
            <select
              value={world.observer.visibility}
              onChange={(event) =>
                setWorld({
                  ...world,
                  observer: {
                    ...world.observer,
                    visibility: event.target.value as SimUser['visibility'],
                  },
                })
              }
            >
              <option value="visible">visible</option>
              <option value="hide_activity">hide activity</option>
              <option value="invisible">invisible</option>
            </select>
          </div>
          <p className="lab-note">
            The observer&apos;s channel is written to the address bar, because that is where
            production reads it from.
          </p>
        </section>

        <section>
          <h2>Simulated users</h2>
          <div className="lab-users">
            {world.users.map((user) => (
              <div className="lab-row" key={user.id}>
                <span className="lab-name" title={user.login}>
                  {user.displayName}
                </span>

                <select
                  value={user.relationship}
                  onChange={(event) =>
                    patch(user.id, { relationship: event.target.value as SimUser['relationship'] })
                  }
                >
                  <option value="friend">friend</option>
                  <option value="incoming_request">asked you</option>
                  <option value="outgoing_request">you asked</option>
                  <option value="stranger">stranger</option>
                </select>

                <select
                  value={user.activity}
                  onChange={(event) =>
                    patch(user.id, { activity: event.target.value as SimUser['activity'] })
                  }
                >
                  <option value="watching">watching</option>
                  <option value="around">around</option>
                  <option value="offline">offline</option>
                </select>

                <ChannelField
                  value={user.channel}
                  onChange={(channel) => patch(user.id, { channel })}
                  placeholder="channel"
                  disabled={user.activity !== 'watching'}
                />

                <select
                  value={user.visibility}
                  onChange={(event) =>
                    patch(user.id, { visibility: event.target.value as SimUser['visibility'] })
                  }
                >
                  <option value="visible">visible</option>
                  <option value="hide_activity">hide activity</option>
                  <option value="invisible">invisible</option>
                </select>

                <label className="lab-check" title="Stop this client's heartbeat">
                  <input
                    type="checkbox"
                    checked={user.staleForMs > 0}
                    onChange={(event) =>
                      patch(user.id, { staleForMs: event.target.checked ? STALE_MS : 0 })
                    }
                  />
                  silent
                </label>

                <button
                  type="button"
                  className="lab-x"
                  title={`Remove ${user.displayName} from the world`}
                  onClick={() =>
                    setWorld({ ...world, users: world.users.filter((u) => u.id !== user.id) })
                  }
                >
                  ×
                </button>
              </div>
            ))}
          </div>

          <button
            type="button"
            disabled={world.users.length >= 10}
            onClick={() =>
              setWorld({
                ...world,
                users: [
                  ...world.users,
                  person(world.users.length, { activity: 'watching', channel: CHANNELS[0] }),
                ],
              })
            }
          >
            + Add user {world.users.length >= 10 ? '(10 max)' : ''}
          </button>
        </section>

        <section>
          <h2>Metadata</h2>
          <div className="lab-users">
            {destinations.length === 0 && (
              <p className="lab-note">No destinations yet - put someone on a channel.</p>
            )}
            {destinations.map((login) => (
              <div className="lab-row" key={login}>
                <span className="lab-name">{login}</span>
                <select
                  value={world.metadata?.[login]?.live ?? 'unavailable'}
                  onChange={(event) =>
                    setMeta(login, { live: event.target.value as SimChannelMeta['live'] })
                  }
                >
                  <option value="live">live</option>
                  <option value="offline">offline</option>
                  <option value="unavailable">unavailable</option>
                </select>
                <select
                  value={world.metadata?.[login]?.avatar ?? 'twitch'}
                  onChange={(event) =>
                    setMeta(login, { avatar: event.target.value as SimChannelMeta['avatar'] })
                  }
                >
                  <option value="twitch">avatar</option>
                  <option value="missing">no avatar</option>
                  <option value="broken">broken avatar</option>
                </select>
                <input
                  className="lab-channel"
                  placeholder="category"
                  value={world.metadata?.[login]?.gameName ?? ''}
                  onChange={(event) => setMeta(login, { gameName: event.target.value })}
                />
              </div>
            ))}
          </div>
          <p className="lab-note">
            &quot;unavailable&quot; is absence, not a state: a backend outage, a cold cache and a
            channel nobody has asked about all reach the panel the same way, and all three must
            draw the plain card.
          </p>
        </section>

        <section>
          <h2>Stream Room</h2>
          {!world.observer.channel && (
            <p className="lab-note">
              Put the observer on a channel - Together only exists where you are.
            </p>
          )}
          {world.observer.channel && (
            <>
              <div className="lab-users">
                {together.length === 0 && (
                  <p className="lab-note">
                    Nobody connected on {canonicalChannel(world.observer.channel)} yet. Room holds{" "}
                    {roster.length}.
                  </p>
                )}
                {together.map((user) => (
                  <div className="lab-row" key={user.id}>
                    <span className="lab-name">{user.displayName}</span>
                    {REACTIONS.map((reaction) => (
                      <button
                        key={reaction}
                        type="button"
                        className="lab-x"
                        title={`${user.displayName} reacts ${reaction}`}
                        onClick={() => handle.react(user.id, reaction)}
                      >
                        {reaction}
                      </button>
                    ))}
                    {/*
                      * Make them SAY something.
                      *
                      * The lab supplies the event and never the answer: this
                      * puts a message into the same buffer realtime would fill,
                      * and every rule about who receives one - the connected
                      * component, the split, the merge - is the server's and is
                      * tested against real Postgres instead.
                      */}
                    <button
                      type="button"
                      className="lab-x"
                      title={`${user.displayName} says something`}
                      onClick={() => handle.say(user.id, `hey from ${user.displayName}`)}
                    >
                      say
                    </button>
                    <button
                      type="button"
                      className="lab-x"
                      title={`${user.displayName} sends an emote`}
                      onClick={() => handle.say(user.id, ':lol:')}
                    >
                      :lol:
                    </button>
                  </div>
                ))}
              </div>

              <div className="lab-buttons">
                <button
                  type="button"
                  disabled={together.length < 2}
                  onClick={() => {
                    // Everyone at once: the combo case, which needs distinct
                    // people rather than one person pressing repeatedly.
                    for (const user of together) handle.react(user.id, 'lol')
                  }}
                >
                  Combo lol (all)
                </button>
                <button
                  type="button"
                  disabled={together.length === 0}
                  onClick={() => {
                    // A burst from ONE person, which must NOT become a combo.
                    for (let i = 0; i < 5; i += 1) handle.react(together[0].id, 'fire')
                  }}
                >
                  Burst fire (one person ×5)
                </button>
              </div>
              <p className="lab-note">
                Room holds {roster.length} · {roster.filter((m) => m.hops === 1).length} direct.
                Reactions land in the same state field production reads from; the lab holds no
                subscription, no rate limit and no row policy, because those belong to the service.
              </p>
            </>
          )}
        </section>

        <section>
          <h2>Time</h2>
          <div className="lab-buttons">
            {[
              ['+45s', 45_000],
              ['+90s', 90_000],
              ['+5m', 5 * 60_000],
              ['+30m', 30 * 60_000],
            ].map(([label, ms]) => (
              <button key={label} type="button" onClick={() => setWorld(advance(world, ms as number))}>
                {label}
              </button>
            ))}
          </div>
          <p className="lab-note">
            Silent clients fall further behind, so the real 90-second staleness rule applies.
            Analytics windows move with the injected clock: +30m crosses an opportunity-key
            boundary. Lab clock is {Math.round(world.clockOffsetMs / 1000)}s ahead.
          </p>
        </section>

        <section>
          <h2>Presets</h2>
          <div className="lab-presets">
            {PRESETS.map((entry) => (
              <button
                key={entry.id}
                type="button"
                title={entry.hint}
                className={entry.id === presetId ? 'on' : ''}
                onClick={() => setLab({ world: entry.build(), presetId: entry.id })}
              >
                {entry.label}
              </button>
            ))}
          </div>
        </section>

        <section>
          <h2>
            Events
            <button type="button" className="lab-clear" onClick={() => handle.clearRecords()}>
              clear
            </button>
            <button
              type="button"
              className="lab-clear"
              onClick={() =>
                void navigator.clipboard?.writeText(JSON.stringify(handle.records(), null, 2))
              }
            >
              copy JSON
            </button>
          </h2>

          {blocked.length > 0 && (
            <ul className="lab-log lab-log-join">
              {blocked.map((line, index) => (
                <li key={index}>{line}</li>
              ))}
            </ul>
          )}

          <ul className="lab-log">
            {records.length === 0 && <li className="lab-empty">Nothing captured yet.</li>}
            {[...records].reverse().map((record) => (
              <li key={record.seq} className={`lab-${record.kind}`}>
                <strong>{record.label}</strong>
                <code>{JSON.stringify(record.detail)}</code>
              </li>
            ))}
          </ul>
          <p className="lab-note">
            Captured at the analytics send boundary: this is exactly what would have gone to
            Supabase. Nothing leaves the browser - the page has no working network.
          </p>
        </section>
      </aside>

      {/*
       * The same layer the content script mounts, so the panel's own placement,
       * drag and resize behave as they do on Twitch.
       */}
      <div className="kb-root lab-stage">
        <KickbackPanel client={handle.client} topOffset={16} reservedRight={0} />
      </div>
    </div>
  )
}

function ChannelField({
  value,
  onChange,
  placeholder,
  disabled,
}: {
  value: string
  onChange: (value: string) => void
  placeholder: string
  disabled?: boolean
}) {
  return (
    <>
      <input
        className="lab-channel"
        list="lab-channels"
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
      <datalist id="lab-channels">
        {CHANNELS.map((channel) => (
          <option key={channel} value={channel} />
        ))}
      </datalist>
    </>
  )
}
