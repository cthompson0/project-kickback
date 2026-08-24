import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { GroupChat } from '../../src/ui/components/GroupChat'
import { ChannelNameProvider } from '../../src/ui/ChannelNames'
import type { ChatMessage, KickbackClient } from '../../src/client/types'

/**
 * The sender label: "DisplayName:" and nothing else.
 *
 * The separator is part of the identity rather than a sibling, so it copies
 * with the name and clicking it does what clicking the name does. What is
 * asserted here is the part a string can answer - the colon appears exactly
 * once, it is inside the control, it is not in the message, and the name keeps
 * the capitalisation Twitch gave it.
 *
 * The part a string CANNOT answer - whether the line wraps like a sentence -
 * lives in `npm run test:wrap`, which measures real line boxes in Chrome.
 * These two regressions both shipped past suites like this one, so nothing
 * here should be read as covering the layout.
 */

const NOW = 1_700_000_000_000

function stubClient(): KickbackClient {
  return {
    sendFriendRequest: async () => 'req',
    removeFriend: async () => {},
    searchEmotes: async () => [],
    sendGroupMessage: async () => {},
  } as unknown as KickbackClient
}

function chat(displayName: string, body: string) {
  const message: ChatMessage = {
    id: 'm1',
    groupId: 'g1',
    userId: 'them',
    displayName,
    avatarUrl: null,
    body,
    createdAt: new Date(NOW).toISOString(),
  }

  return renderToStaticMarkup(
    <ChannelNameProvider people={[]} seen={{}}>
      <GroupChat
        groupId="g1"
        messages={[message]}
        selfId="me"
        client={stubClient()}
        members={[]}
        cardContext={{
          selfId: 'me',
          viewerActivity: { type: 'idle' },
          friendIds: new Set<string>(),
          outgoingRequestIds: new Set<string>(),
        }}
      />
    </ChannelNameProvider>,
  )
}

/** The rendered sender label, colon and all. */
function senderLabel(html: string): string {
  const match = html.match(/<span[^>]*class="kb-msg-who[^"]*"[^>]*>(.*?)<\/span>/)
  if (!match) throw new Error('no sender label in the rendered chat line')
  return match[1]
}

/** Everything the message body rendered, tags stripped. */
function bodyText(html: string): string {
  const match = html.match(/<span class="kb-msg-body[^"]*">(.*?)<\/span><\/div>/)
  return match ? match[1].replace(/<[^>]+>/g, '') : ''
}

const NAMES = ['Nina', 'AnoterosTV', 'xQcOW', 'AVeryLongDisplayNameIndeed', 'lowercaseonly']

const BODIES: Array<[string, string]> = [
  ['short prose', 'ok that was actually incredible'],
  [
    'a long sentence',
    'also sometimes chats have a random line break from my username and it just keeps going',
  ],
  ['a URL', 'https://www.twitch.tv/videos/2147483647?filter=archives&sort=time'],
  ['an unbroken token', 'W'.repeat(90)],
  ['an inline emote', 'that was rough :lol: honestly'],
  ['several emotes', ':lol: :pog: what even was that :fire:'],
  ['a combo message', ':pog: :pog: :pog:'],
  // A message that contains a colon of its own must not be mistaken for the
  // separator, in either direction.
  ['a message containing a colon', 'score: 3:2 and it was close'],
]

describe('the sender label carries the separator', () => {
  for (const name of NAMES) {
    it(`renders "${name}:" exactly once`, () => {
      const label = senderLabel(chat(name, 'hello there'))
      expect(label).toBe(`${name}:`)
      expect(label.match(/:/g)).toHaveLength(1)
    })
  }

  for (const [label, body] of BODIES) {
    it(`renders one colon beside ${label}`, () => {
      expect(senderLabel(chat('AnoterosTV', body))).toBe('AnoterosTV:')
    })
  }

  it('keeps the separator out of the message body', () => {
    // The colon is the label's last glyph, not the body's first.
    expect(bodyText(chat('AnoterosTV', 'hello there'))).toBe('hello there')
  })

  it('leaves a colon inside a message alone', () => {
    const html = chat('AnoterosTV', 'score: 3:2 and it was close')
    expect(bodyText(html)).toBe('score: 3:2 and it was close')
  })
})

describe('the sender label preserves capitalisation', () => {
  it('does not case-fold a mixed-case Twitch display name', () => {
    // Display names are chosen, not derived: xQcOW is not XQCOW or xqcow.
    expect(senderLabel(chat('xQcOW', 'hi'))).toBe('xQcOW:')
    expect(senderLabel(chat('AnoterosTV', 'hi'))).toBe('AnoterosTV:')
  })

  it('describes the person by name, without the separator', () => {
    // The colon is punctuation for the eye; it has no place in the label a
    // screen reader or a tooltip reads out.
    const html = chat('AnoterosTV', 'hi')
    expect(html).toContain('title="About AnoterosTV"')
    expect(html).not.toContain('title="About AnoterosTV:"')
  })
})

describe('the sender label is still the identity target', () => {
  const html = chat('AnoterosTV', 'hello there')

  it('is a control, with the separator inside it', () => {
    expect(html).toMatch(/<span[^>]*role="button"[^>]*class="kb-msg-who[^"]*"/)
    expect(senderLabel(html)).toBe('AnoterosTV:')
  })

  it('is reachable by keyboard', () => {
    expect(html).toMatch(/<span[^>]*tabindex="0"[^>]*class="kb-msg-who/)
  })

  it('is not a button, because a button cannot be an inline box', () => {
    /*
     * Chrome coerces `display: inline` to `inline-block` on a button, which
     * makes the name an atomic box and breaks the wrapping. This is the DOM
     * half of that guard; `npm run test:wrap` measures the consequence.
     */
    const head = html.slice(html.indexOf('kb-msg-head'), html.indexOf('</div>'))
    expect(head).not.toContain('<button')
  })

  it('does not swallow the message text', () => {
    // Selecting message text must not be interrupted by the control, so the
    // body is a sibling of the name rather than a child.
    expect(senderLabel(html)).not.toContain('hello there')
    expect(html).toContain('hello there')
  })
})
