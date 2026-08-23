import { describe, expect, it, vi } from 'vitest'
import {
  EMOTES,
  emoteKey,
  externalEmoteUrl,
  externalToken,
  isEmoteOnly,
  isKickbackEmote,
  parseMessage,
  soleEmote,
} from '../../src/core/emotes'
import type { Emote } from '../../src/core/emotes'
import { annotateCombos } from '../../src/core/combos'
import { createSevenTvClient, normalizeEmoteSet, toEmote } from '../../src/background/sevenTv'
import type { SevenTvClient } from '../../src/background/sevenTv'
import {
  CHANNEL_CACHE_TTL_MS,
  GLOBAL_CACHE_TTL_MS,
  SEARCH_LIMIT,
  createEmoteCatalog,
} from '../../src/background/emoteCatalog'

/**
 * External emote providers.
 *
 * The properties that matter are all about identity and trust: an emote is
 * what its provider and id say it is (never its name, never its URL), provider
 * payloads are untrusted, and a message stays readable long after the emote
 * has left the channel it came from.
 */

const OMEGALUL = '01F6MZGCNR000255V6CN6betv0'
const SEVENTV_LOL = '01FCXYZABC000255V6CN6XXXX0'

const sevenTv = (id: string, name: string, animated = false): Emote => ({
  provider: '7tv',
  id,
  name,
  animated,
  url: externalEmoteUrl('7tv', id),
})

// ---------------------------------------------------------------- the model

describe('unified emote model', () => {
  it('identifies an emote by provider and id, not by name', () => {
    const a = sevenTv(OMEGALUL, 'OMEGALUL')
    const b = sevenTv(SEVENTV_LOL, 'OMEGALUL')
    expect(emoteKey(a)).not.toBe(emoteKey(b))

    const renamed = { ...a, name: 'OMEGALULiguess' }
    expect(emoteKey(renamed)).toBe(emoteKey(a))
  })

  it('gives built-ins their own provider namespace', () => {
    const builtIn = EMOTES.find((emote) => emote.name === 'lol')!
    expect(emoteKey(builtIn)).toBe('kickback:lol')
    expect(isKickbackEmote(builtIn)).toBe(true)
    expect(builtIn.url).toBeNull()
  })

  it('derives an image URL from the id rather than trusting a provider', () => {
    expect(externalEmoteUrl('7tv', OMEGALUL)).toBe(
      `https://cdn.7tv.app/emote/${OMEGALUL}/2x.webp`,
    )
  })

  it('refuses to build a URL from an id that is not an id', () => {
    for (const hostile of ['../../evil', 'a/b', 'x?y', 'javascript:alert(1)', '']) {
      expect(externalEmoteUrl('7tv', hostile)).toBeNull()
    }
  })
})

describe('external tokens in message bodies', () => {
  it('round-trips through the token form', () => {
    const emote = sevenTv(OMEGALUL, 'OMEGALUL')
    const segments = parseMessage(externalToken(emote))
    expect(segments).toHaveLength(1)
    expect(segments[0]).toMatchObject({
      type: 'emote',
      emote: { provider: '7tv', id: OMEGALUL, name: 'OMEGALUL' },
    })
  })

  it('splits text around an external emote', () => {
    const body = `that was ${externalToken(sevenTv(OMEGALUL, 'OMEGALUL'))} rough`
    expect(parseMessage(body).map((segment) => segment.type)).toEqual([
      'text',
      'emote',
      'text',
    ])
  })

  it('renders a mix of built-in and external emotes in order', () => {
    const body = `:lol: ${externalToken(sevenTv(OMEGALUL, 'OMEGALUL'))}`
    const emotes = parseMessage(body)
      .filter((segment) => segment.type === 'emote')
      .map((segment) => (segment.type === 'emote' ? emoteKey(segment.emote) : ''))
    expect(emotes).toEqual(['kickback:lol', `7tv:${OMEGALUL}`])
    expect(isEmoteOnly(body)).toBe(true)
  })

  it('renders history after the emote has left the channel', () => {
    // Nothing is looked up: the message carries provider, id and name, so an
    // emote removed from a channel set months ago still draws.
    const historical = `[[7tv|${OMEGALUL}|OMEGALUL]]`
    const segments = parseMessage(historical)
    expect(segments[0]).toMatchObject({ type: 'emote', emote: { id: OMEGALUL } })
  })

  it('shows an unparseable token as literal text rather than guessing', () => {
    const hostile = [
      // Provider we do not know.
      `[[bttv|${OMEGALUL}|WutFace]]`,
      // Kickback is not a valid external provider - built-ins use :tokens:.
      `[[kickback|lol|lol]]`,
      // Id that is not an id.
      '[[7tv|../../../etc/passwd|X]]',
      // Name carrying markup.
      `[[7tv|${OMEGALUL}|<img src=x onerror=alert(1)>]]`,
    ]
    for (const body of hostile) {
      expect(parseMessage(body)).toEqual([{ type: 'text', text: body }])
    }
  })
})

// ---------------------------------------------------------------- collisions

describe('name collisions across providers', () => {
  it('does not combo two different emotes that share a name', () => {
    const mine = ':lol:'
    const theirs = externalToken(sevenTv(SEVENTV_LOL, 'lol'))

    const annotations = annotateCombos([
      { id: 'm1', userId: 'u1', displayName: 'A', body: mine },
      { id: 'm2', userId: 'u2', displayName: 'B', body: theirs },
    ])

    // Two runs of one, neither worth showing - not a run of two.
    expect(annotations.get('m1')?.comboCount).toBeUndefined()
    expect(annotations.get('m2')?.comboCount).toBeUndefined()
  })

  it('combos across people when the provider and id match', () => {
    const body = externalToken(sevenTv(OMEGALUL, 'OMEGALUL'))
    const annotations = annotateCombos([
      { id: 'm1', userId: 'u1', displayName: 'A', body },
      { id: 'm2', userId: 'u2', displayName: 'B', body },
      { id: 'm3', userId: 'u3', displayName: 'C', body },
    ])
    expect(annotations.get('m3')?.comboCount).toBe(3)
    expect(annotations.get('m3')?.comboEmote?.id).toBe(OMEGALUL)
  })

  it('combos a renamed emote with its earlier self', () => {
    // Same id, different display name: still the same emote.
    const before = `[[7tv|${OMEGALUL}|OMEGALUL]]`
    const after = `[[7tv|${OMEGALUL}|OMEGALULiguess]]`
    const annotations = annotateCombos([
      { id: 'm1', userId: 'u1', displayName: 'A', body: before },
      { id: 'm2', userId: 'u2', displayName: 'B', body: after },
    ])
    expect(annotations.get('m2')?.comboCount).toBe(2)
  })

  it('treats a message of one external emote as sole', () => {
    const emote = soleEmote(`  ${externalToken(sevenTv(OMEGALUL, 'OMEGALUL'))}  `)
    expect(emote && emoteKey(emote)).toBe(`7tv:${OMEGALUL}`)
  })

  it('is not a sole emote when two different emotes appear', () => {
    expect(
      soleEmote(`:lol:${externalToken(sevenTv(SEVENTV_LOL, 'lol'))}`),
    ).toBeNull()
  })
})

// ------------------------------------------------------------------- 7TV API

describe('7TV payload normalisation', () => {
  it('accepts a well-formed emote', () => {
    expect(toEmote({ id: OMEGALUL, name: 'OMEGALUL', data: { animated: true } })).toEqual({
      provider: '7tv',
      id: OMEGALUL,
      name: 'OMEGALUL',
      animated: true,
      url: `https://cdn.7tv.app/emote/${OMEGALUL}/2x.webp`,
    })
  })

  it('ignores a provider-supplied host and derives the URL itself', () => {
    const emote = toEmote({
      id: OMEGALUL,
      name: 'OMEGALUL',
      // The field a naive client would use.
      data: { animated: false, host: { url: '//evil.example.com/pwn' } },
    } as never)
    expect(emote?.url).toBe(`https://cdn.7tv.app/emote/${OMEGALUL}/2x.webp`)
    expect(emote?.url).not.toContain('evil')
  })

  it('drops entries that are not shaped like emotes', () => {
    const rubbish = [
      {},
      { id: OMEGALUL },
      { name: 'OMEGALUL' },
      { id: 42, name: 'OMEGALUL' },
      { id: OMEGALUL, name: 12 },
      null,
      'not an object',
    ]
    for (const raw of rubbish) {
      expect(toEmote(raw as never)).toBeNull()
    }
  })

  it('drops a name that could not be typed as a word', () => {
    for (const name of ['<script>x</script>', 'has space', 'a'.repeat(65), '', '[[7tv|x|y]]']) {
      expect(toEmote({ id: OMEGALUL, name })).toBeNull()
    }
  })

  it('keeps the good emotes out of a partly broken set', () => {
    const emotes = normalizeEmoteSet({
      emotes: [
        { id: OMEGALUL, name: 'OMEGALUL' },
        { id: 'no spaces allowed', name: 'Broken' },
        { id: SEVENTV_LOL, name: 'lol' },
      ],
    })
    expect(emotes.map((emote) => emote.name)).toEqual(['OMEGALUL', 'lol'])
  })

  it('de-duplicates by id', () => {
    const emotes = normalizeEmoteSet({
      emotes: [
        { id: OMEGALUL, name: 'OMEGALUL' },
        { id: OMEGALUL, name: 'OMEGALUL' },
      ],
    })
    expect(emotes).toHaveLength(1)
  })

  it('treats a shapeless payload as an empty set', () => {
    for (const payload of [null, undefined, {}, { emotes: 'lots' }, []]) {
      expect(normalizeEmoteSet(payload)).toEqual([])
    }
  })
})

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as Response
}

describe('7TV client', () => {
  const gqlUsers = (connections: unknown[]) =>
    jsonResponse({ data: { users: [{ connections }] } })

  it('resolves an exact Twitch login to a numeric id', async () => {
    const fetchImpl = vi.fn(async () =>
      gqlUsers([{ id: '23161357', platform: 'TWITCH', username: 'LIRIK' }]),
    )
    const client = createSevenTvClient(fetchImpl as never)
    expect(await client.resolveTwitchId('lirik')).toBe('23161357')
  })

  it('rejects a fuzzy match that is not the login asked for', async () => {
    // 7TV search is fuzzy; taking the first hit would point chat at the wrong
    // channel's emotes.
    const fetchImpl = vi.fn(async () =>
      gqlUsers([{ id: '999', platform: 'TWITCH', username: 'lirikfan' }]),
    )
    const client = createSevenTvClient(fetchImpl as never)
    expect(await client.resolveTwitchId('lirik')).toBeNull()
  })

  it('rejects a non-Twitch connection and a non-numeric id', async () => {
    const client = createSevenTvClient(
      (async () =>
        gqlUsers([
          { id: '23161357', platform: 'YOUTUBE', username: 'lirik' },
          { id: 'not-a-number', platform: 'TWITCH', username: 'lirik' },
        ])) as never,
    )
    expect(await client.resolveTwitchId('lirik')).toBeNull()
  })

  it('never asks about a login that is not a login', async () => {
    const fetchImpl = vi.fn()
    const client = createSevenTvClient(fetchImpl as never)
    for (const bad of ['../admin', 'a b', '', 'x'.repeat(26)]) {
      expect(await client.resolveTwitchId(bad)).toBeNull()
    }
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('reads a channel set', async () => {
    const client = createSevenTvClient(
      (async (url: string) => {
        expect(url).toBe('https://7tv.io/v3/users/twitch/23161357')
        return jsonResponse({ emote_set: { emotes: [{ id: OMEGALUL, name: 'OMEGALUL' }] } })
      }) as never,
    )
    expect(await client.channelEmotes('23161357')).toHaveLength(1)
  })

  it('treats a channel with no 7TV set as simply having none', async () => {
    const client = createSevenTvClient((async () => jsonResponse({ emote_set: null })) as never)
    expect(await client.channelEmotes('23161357')).toEqual([])
  })

  it('survives an unreachable provider', async () => {
    const dead = createSevenTvClient((async () => {
      throw new Error('ECONNREFUSED')
    }) as never)
    expect(await dead.globalEmotes()).toEqual([])
    expect(await dead.channelEmotes('1')).toEqual([])
    expect(await dead.resolveTwitchId('lirik')).toBeNull()
  })

  it('survives an error response and malformed JSON', async () => {
    const failing = createSevenTvClient((async () => jsonResponse({}, false)) as never)
    expect(await failing.globalEmotes()).toEqual([])

    const garbage = createSevenTvClient((async () => ({
      ok: true,
      json: async () => {
        throw new SyntaxError('Unexpected token <')
      },
    })) as never)
    expect(await garbage.globalEmotes()).toEqual([])
  })

  it('reports failures without throwing them at the caller', async () => {
    const onError = vi.fn()
    const client = createSevenTvClient(
      (async () => {
        throw new Error('nope')
      }) as never,
      onError,
    )
    await client.globalEmotes()
    expect(onError).toHaveBeenCalled()
  })
})

// ----------------------------------------------------------------- catalogue

function stubClient(overrides: Partial<SevenTvClient> = {}) {
  return {
    resolveTwitchId: vi.fn(async (login: string) => (login === 'lirik' ? '23161357' : null)),
    channelEmotes: vi.fn(async () => [sevenTv(OMEGALUL, 'OMEGALUL')]),
    globalEmotes: vi.fn(async () => [sevenTv(SEVENTV_LOL, 'lol')]),
    ...overrides,
  } as SevenTvClient & Record<string, ReturnType<typeof vi.fn>>
}

/** Lets the catalogue's in-flight loads settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('emote catalogue', () => {
  it('loads the channel the user is watching', async () => {
    const client = stubClient()
    const catalog = createEmoteCatalog({ client })
    catalog.setChannel('LIRIK')
    await settle()

    expect(catalog.getChannel()).toBe('lirik')
    expect(catalog.size()).toEqual({ channel: 1, global: 1 })
    expect(client.resolveTwitchId).toHaveBeenCalledWith('lirik')
  })

  it('drops the previous channel set the instant the channel changes', async () => {
    const client = stubClient()
    const catalog = createEmoteCatalog({ client })

    catalog.setChannel('lirik')
    await settle()
    // The set really is loaded, which is what makes the next assertion mean
    // something.
    expect(catalog.size().channel).toBe(1)

    catalog.setChannel('someoneelse')

    // Immediately, not eventually: one channel's emotes must never appear to
    // belong to the next, not even for the moment before the new set arrives.
    expect(catalog.size().channel).toBe(0)
  })

  it('discards a channel load that lands after the user has moved on', async () => {
    let release = () => {}
    const landed = new Promise<void>((resolve) => {
      release = resolve
    })
    const client = stubClient({
      channelEmotes: vi.fn(async () => {
        await landed
        return [sevenTv(OMEGALUL, 'OMEGALUL')]
      }),
    })
    const catalog = createEmoteCatalog({ client })

    catalog.setChannel('lirik')
    await settle()
    catalog.setChannel('someoneelse')

    // LIRIK's set arrives now, long after we stopped watching LIRIK.
    release()
    await settle()
    await settle()

    expect(catalog.size().channel).toBe(0)
  })

  it('follows the user back to a channel without refetching', async () => {
    const client = stubClient()
    const catalog = createEmoteCatalog({ client })

    catalog.setChannel('lirik')
    await settle()
    catalog.setChannel('someoneelse')
    await settle()
    catalog.setChannel('lirik')
    await settle()

    expect(catalog.size().channel).toBe(1)
    expect(client.resolveTwitchId).toHaveBeenCalledTimes(2) // lirik once, someoneelse once
  })

  it('refetches a channel once its cache has aged out', async () => {
    let clock = 1_000
    const client = stubClient()
    const catalog = createEmoteCatalog({ client, now: () => clock })

    catalog.setChannel('lirik')
    await settle()
    catalog.setChannel('someoneelse')
    await settle()

    clock += CHANNEL_CACHE_TTL_MS + 1
    catalog.setChannel('lirik')
    await settle()

    expect(client.channelEmotes).toHaveBeenCalledTimes(2)
  })

  it('does not refetch globals while they are fresh, and does once stale', async () => {
    let clock = 1_000
    const client = stubClient()
    const catalog = createEmoteCatalog({ client, now: () => clock })

    catalog.setChannel('lirik')
    await settle()
    catalog.setChannel('someoneelse')
    await settle()
    expect(client.globalEmotes).toHaveBeenCalledTimes(1)

    clock += GLOBAL_CACHE_TTL_MS + 1
    catalog.setChannel('lirik')
    await settle()
    expect(client.globalEmotes).toHaveBeenCalledTimes(2)
  })

  it('keeps a stale set rather than emptying the picker on a failed refresh', async () => {
    let clock = 1_000
    let calls = 0
    const client = stubClient({
      globalEmotes: vi.fn(async () => {
        calls += 1
        return calls === 1 ? [sevenTv(SEVENTV_LOL, 'lol')] : []
      }),
    })
    const catalog = createEmoteCatalog({ client, now: () => clock })

    catalog.setChannel('lirik')
    await settle()
    clock += GLOBAL_CACHE_TTL_MS + 1
    catalog.setChannel('someoneelse')
    await settle()

    expect(catalog.size().global).toBe(1)
  })

  it('offers no channel emotes when signed out of nothing in particular', async () => {
    const client = stubClient()
    const catalog = createEmoteCatalog({ client })
    catalog.setChannel(null)
    await settle()

    expect(catalog.size().channel).toBe(0)
    expect(client.resolveTwitchId).not.toHaveBeenCalled()
    // Globals still load: they need no channel.
    expect(catalog.size().global).toBe(1)
  })

  it('fetches globals once through a burst of navigation', async () => {
    // setChannel runs on every activity push, which on a busy SPA is often.
    const client = stubClient()
    const catalog = createEmoteCatalog({ client })

    catalog.setChannel('lirik')
    catalog.setChannel('someoneelse')
    catalog.setChannel('lirik')
    catalog.setChannel(null)
    await settle()

    expect(client.globalEmotes).toHaveBeenCalledTimes(1)
  })

  it('leaves the picker usable when 7TV is entirely unreachable', async () => {
    const dead = stubClient({
      resolveTwitchId: vi.fn(async () => null),
      channelEmotes: vi.fn(async () => []),
      globalEmotes: vi.fn(async () => []),
    })
    const catalog = createEmoteCatalog({ client: dead })
    catalog.setChannel('lirik')
    await settle()

    // Built-ins are local, so chat keeps its emotes regardless.
    const sections = catalog.search('')
    expect(sections.map((section) => section.title)).toEqual(['Kickback'])
    expect(sections[0].emotes.length).toBe(EMOTES.length)
  })

  it('survives a channel 7TV has never heard of', async () => {
    const client = stubClient()
    const catalog = createEmoteCatalog({ client })
    catalog.setChannel('someoneelse')
    await settle()

    expect(catalog.size().channel).toBe(0)
    expect(client.channelEmotes).not.toHaveBeenCalled()
  })
})

describe('picker search', () => {
  it('groups results by source, channel before global', async () => {
    const catalog = createEmoteCatalog({ client: stubClient() })
    catalog.setChannel('lirik')
    await settle()

    const titles = catalog.search('').map((section) => section.title)
    expect(titles).toEqual(['Kickback', '7TV · lirik', '7TV global'])
  })

  it('matches on name, case-insensitively, anywhere in the name', async () => {
    const catalog = createEmoteCatalog({ client: stubClient() })
    catalog.setChannel('lirik')
    await settle()

    const names = catalog
      .search('mega')
      .flatMap((section) => section.emotes.map((emote) => emote.name))
    expect(names).toEqual(['OMEGALUL'])
  })

  it('returns no sections when nothing matches', async () => {
    const catalog = createEmoteCatalog({ client: stubClient() })
    catalog.setChannel('lirik')
    await settle()
    expect(catalog.search('zzzznothing')).toEqual([])
  })

  it('does not list a global emote the channel overrides', async () => {
    const client = stubClient({
      channelEmotes: vi.fn(async () => [sevenTv(OMEGALUL, 'lol')]),
      globalEmotes: vi.fn(async () => [sevenTv(SEVENTV_LOL, 'lol')]),
    })
    const catalog = createEmoteCatalog({ client })
    catalog.setChannel('lirik')
    await settle()

    const sections = catalog.search('lol')
    expect(sections.map((section) => section.title)).toEqual(['Kickback', '7TV · lirik'])
  })

  it('caps each section so a huge channel cannot flood the picker', async () => {
    const many = Array.from({ length: 500 }, (_, index) =>
      sevenTv(`${OMEGALUL.slice(0, 20)}${String(index).padStart(6, '0')}`, `Emote${index}`),
    )
    const catalog = createEmoteCatalog({
      client: stubClient({ channelEmotes: vi.fn(async () => many) }),
    })
    catalog.setChannel('lirik')
    await settle()

    expect(catalog.size().channel).toBe(500)
    const channelSection = catalog.search('Emote').find((s) => s.title === '7TV · lirik')!
    expect(channelSection.emotes).toHaveLength(SEARCH_LIMIT)
  })
})

// ------------------------------------------------------------------ sending

describe('resolving names at send time', () => {
  async function ready(overrides: Partial<SevenTvClient> = {}) {
    const catalog = createEmoteCatalog({ client: stubClient(overrides) })
    catalog.setChannel('lirik')
    await settle()
    return catalog
  }

  it('rewrites a bare name into a stable token', async () => {
    const catalog = await ready()
    expect(catalog.resolveOutgoing('OMEGALUL')).toBe(`[[7tv|${OMEGALUL}|OMEGALUL]]`)
  })

  it('rewrites only whole words', async () => {
    const catalog = await ready()
    expect(catalog.resolveOutgoing('OMEGALULiguess')).toBe('OMEGALULiguess')
    expect(catalog.resolveOutgoing('xOMEGALUL')).toBe('xOMEGALUL')
  })

  it('is case sensitive, the way emote names are', async () => {
    const catalog = await ready()
    expect(catalog.resolveOutgoing('omegalul')).toBe('omegalul')
  })

  it('preserves the surrounding text exactly', async () => {
    const catalog = await ready()
    expect(catalog.resolveOutgoing('that   was OMEGALUL  honestly')).toBe(
      `that   was [[7tv|${OMEGALUL}|OMEGALUL]]  honestly`,
    )
  })

  it('leaves ordinary words alone', async () => {
    const catalog = await ready()
    const body = 'we should probably go to bed'
    expect(catalog.resolveOutgoing(body)).toBe(body)
  })

  it('gives the channel emote the name when global has one too', async () => {
    const catalog = await ready({
      channelEmotes: vi.fn(async () => [sevenTv(OMEGALUL, 'lol')]),
      globalEmotes: vi.fn(async () => [sevenTv(SEVENTV_LOL, 'lol')]),
    })
    // Documented precedence: channel > global.
    expect(catalog.resolveOutgoing('lol')).toBe(`[[7tv|${OMEGALUL}|lol]]`)
  })

  it('leaves a built-in token untouched for the parser to handle', async () => {
    const catalog = await ready()
    expect(catalog.resolveOutgoing(':lol: OMEGALUL')).toBe(
      `:lol: [[7tv|${OMEGALUL}|OMEGALUL]]`,
    )
  })

  it('changes nothing when no external emotes have loaded', () => {
    const catalog = createEmoteCatalog({ client: stubClient() })
    expect(catalog.resolveOutgoing('OMEGALUL')).toBe('OMEGALUL')
  })

  it('produces a body that parses back to the emote that was meant', async () => {
    const catalog = await ready()
    const sent = catalog.resolveOutgoing('OMEGALUL OMEGALUL')
    const parsed = parseMessage(sent).filter((segment) => segment.type === 'emote')
    expect(parsed).toHaveLength(2)
    expect(soleEmote(sent) && emoteKey(soleEmote(sent)!)).toBe(`7tv:${OMEGALUL}`)
  })

  it('cannot be tricked into forging a token through an emote name', async () => {
    // A name is validated on the way in, so a hostile 7TV set cannot inject a
    // token that resolves to a different provider or a different id.
    const catalog = await ready({
      channelEmotes: vi.fn(async () => normalizeEmoteSet({
        emotes: [{ id: OMEGALUL, name: '[[twitch|999|Evil]]' }],
      })),
    })
    expect(catalog.size().channel).toBe(0)
    expect(catalog.resolveOutgoing('[[twitch|999|Evil]]')).toBe('[[twitch|999|Evil]]')
  })
})
