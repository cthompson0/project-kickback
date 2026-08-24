import { readFileSync } from 'node:fs'
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

/** The rendered sender label, colon and all - as text, however it is marked up. */
function senderLabel(html: string): string {
  return labelMarkup(html).replace(/<[^>]+>/g, '')
}

/**
 * The label's inner markup, one level of nesting allowed.
 *
 * The separator is its own element - it is punctuation and must not carry the
 * sender's colour - so a non-greedy match to the first closing tag would stop
 * inside the label and quietly drop the colon it is here to check.
 */
function labelMarkup(html: string): string {
  const match = html.match(
    /<span[^>]*class="kb-msg-who[^"]*"[^>]*>((?:[^<]|<span[^>]*>[^<]*<\/span>)*)<\/span>/,
  )
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

describe('the separator does not wear the sender colour', () => {
  const CSS = readFileSync('src/ui/kickback.css', 'utf8')
  const rule = (selector: string) => {
    const at = CSS.indexOf(selector)
    if (at < 0) throw new Error('no rule for ' + selector)
    return CSS.slice(at, CSS.indexOf('}', at))
  }

  it('renders the colon as its own element, outside the coloured name', () => {
    /*
     * The regression: .kb-msg-who paints the sender's colour over everything
     * inside it, so a colon sitting in the same text node came out orange - or
     * green, for yourself. The name keeps the colour; the colon steps out of it.
     */
    expect(labelMarkup(chat('AnoterosTV', 'hello there'))).toBe(
      'AnoterosTV<span class="kb-msg-sep">:</span>',
    )
  })

  it('paints it with the ordinary message foreground, not a hardcoded white', () => {
    // The same token message text uses, so a theme change moves both together.
    expect(rule('.kb-msg-sep {')).toContain('color: var(--kb-text)')
    expect(rule('.kb-msg-body {')).toContain('color: var(--kb-text)')
    expect(rule('.kb-msg-sep {')).not.toMatch(/#[0-9a-fA-F]{3,8}/)
  })

  it('does not drag the sender weight onto the punctuation', () => {
    // .kb-msg-who is 800; a bold colon still reads as part of the name.
    expect(rule('.kb-msg-sep {')).toContain('font-weight: 400')
  })

  it('still gives the name itself the sender colour', () => {
    // Fixing the colon must not quietly flatten the thing it separates.
    expect(rule('.kb-msg-who {')).toContain('color: var(--kb-accent)')
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
