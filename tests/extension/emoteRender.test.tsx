import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { EMOTES, externalEmoteUrl, externalToken, parseMessage } from '../../src/core/emotes'
import type { Emote } from '../../src/core/emotes'
import { EmoteImage } from '../../src/ui/components/EmoteImage'
import { EmotePicker } from '../../src/ui/components/EmotePicker'
import type { KickbackClient } from '../../src/client/types'

/**
 * What the emote components actually put in the DOM.
 *
 * Rendering is where an untrusted provider name would do damage if it ever
 * became markup, and where an emote URL would do damage if it ever came from
 * a payload. Both are asserted on the rendered output rather than the input.
 */

const OMEGALUL = '01F00Z3A9G0007E4VV006YKSK9'

const external = (name: string, id = OMEGALUL): Emote => ({
  provider: '7tv',
  id,
  name,
  animated: false,
  url: externalEmoteUrl('7tv', id),
})

describe('rendering an emote', () => {
  it('draws a built-in as inline SVG with no URL at all', () => {
    const html = renderToStaticMarkup(<EmoteImage emote={EMOTES[0]} />)
    expect(html).toContain('<svg')
    expect(html).not.toContain('http')
    expect(html).toContain('aria-label="Crying laughing"')
  })

  it('draws an external emote as an image on the provider CDN', () => {
    const html = renderToStaticMarkup(<EmoteImage emote={external('OMEGALUL')} />)
    expect(html).toContain(`src="https://cdn.7tv.app/emote/${OMEGALUL}/2x.webp"`)
    expect(html).toContain('alt="OMEGALUL"')
    expect(html).toContain('loading="lazy"')
  })

  it('shows the name instead of a broken image when there is no URL', () => {
    const html = renderToStaticMarkup(
      <EmoteImage emote={{ provider: '7tv', id: 'x', name: 'Whatever', animated: false, url: null }} />,
    )
    expect(html).not.toContain('<img')
    expect(html).toContain('Whatever')
  })

  it('escapes a hostile emote name rather than emitting markup', () => {
    // A name like this cannot get through validation, but rendering must not
    // be the only thing standing between a payload and the DOM.
    const html = renderToStaticMarkup(
      <EmoteImage emote={{ ...external('x'), name: '<img src=x onerror=alert(1)>' }} />,
    )
    // The name is escaped into an attribute value, so it opens no tag and
    // runs nothing. Asserting on the tag boundary is the property that matters.
    expect(html.match(/<img/g)).toHaveLength(1)
    expect(html).toContain('alt="&lt;img src=x onerror=alert(1)&gt;"')
  })
})

function stubClient(sections: unknown[] = []): KickbackClient {
  return { searchEmotes: async () => sections } as unknown as KickbackClient
}

describe('the picker', () => {
  it('offers the built-ins before any provider has answered', () => {
    const html = renderToStaticMarkup(<EmotePicker client={stubClient()} onPick={() => {}} />)
    expect(html).toContain('Watchside')
    expect(html).toContain('Search emotes')
    // One button per built-in.
    expect(html.match(/kb-emote-btn/g)?.length).toBe(EMOTES.length)
  })

  it('renders the search box so a big channel is navigable', () => {
    const html = renderToStaticMarkup(<EmotePicker client={stubClient()} onPick={() => {}} />)
    expect(html).toContain('kb-emote-scroll')
    expect(html).toContain('kb-emote-search')
  })
})

describe('a stored message body renders on its own', () => {
  it('draws an external emote from the body alone, with no catalogue', () => {
    // The point of the stable token: no provider call, no channel context, no
    // lookup table - a message from a year ago still draws what was meant.
    const body = `that was ${externalToken(external('OMEGALUL'))} honestly`
    const html = renderToStaticMarkup(
      <>
        {parseMessage(body).map((segment, index) =>
          segment.type === 'emote' ? (
            <EmoteImage key={index} emote={segment.emote} />
          ) : (
            <span key={index}>{segment.text}</span>
          ),
        )}
      </>,
    )
    expect(html).toContain(`cdn.7tv.app/emote/${OMEGALUL}`)
    expect(html).toContain('that was ')
    expect(html).toContain(' honestly')
  })

  it('shows a token for an unsupported provider as plain text', () => {
    const body = `nice [[bttv|${OMEGALUL}|WutFace]] one`
    const html = renderToStaticMarkup(
      <>
        {parseMessage(body).map((segment, index) =>
          segment.type === 'emote' ? (
            <EmoteImage key={index} emote={segment.emote} />
          ) : (
            <span key={index}>{segment.text}</span>
          ),
        )}
      </>,
    )
    expect(html).not.toContain('<img')
    expect(html).toContain('bttv')
  })
})
