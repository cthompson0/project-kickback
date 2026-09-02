import { execFileSync } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

/**
 * The checked-in Pages artifact still matches the build it came from.
 *
 * WHY IT IS CHECKED IN AT ALL
 *
 * `dist-pages/` is gitignored, so a build output is neither reviewable in a diff
 * nor copyable without running a build first. `docs/web/invite-landing/` already
 * set the convention: the publishable file lives in the repository, so publishing
 * is a copy and nothing else.
 *
 * WHY IT NEEDS A TEST
 *
 * The invite landing page is the cautionary tale. It was checked in as
 * ready-to-copy, the published copy was later rebranded from the old purple to
 * the current orange, and the repository copy kept the old palette for months.
 * Nothing failed, because nothing compared them - and the file documented as
 * "copy this to publish" would have reverted the live page's branding.
 *
 * A checked-in artifact with no gate is a stale artifact that looks current.
 */

const SOURCE = join('docs', 'web', 'pages-watchside')
// Its own directory: publicRouting.test.ts builds the same tree in a parallel
// worker, and sharing one output raced them into intermittent failure.
const BUILT = join('dist-pages-artifact')

const normalise = (text: string) => text.replace(/\r\n/g, '\n')
const read = (...parts: string[]) => normalise(readFileSync(join(...parts), 'utf8'))

beforeAll(() => {
  rmSync(BUILT, { recursive: true, force: true })
  execFileSync(process.execPath, [join('scripts', 'build-site.mjs'), BUILT, '/watchside/'], {
    stdio: 'pipe',
  })
}, 60_000)

describe('the publishable Pages artifact', () => {
  it('is byte-identical to what the build produces', () => {
    expect(read(SOURCE, 'index.html')).toBe(read(BUILT, 'index.html'))
    expect(read(SOURCE, 'support', 'index.html')).toBe(read(BUILT, 'support', 'index.html'))
  })

  it('links only to paths the published set will actually answer', () => {
    /*
     * `/watchside/` returned 404 before this artifact existed, and the support
     * page's back link and footer both point there. Publishing support alone
     * would have shipped a page whose own navigation was broken, which is why
     * index.html is part of the artifact rather than an optional extra.
     *
     * `/watchside/privacy` is the one link that resolves to something this
     * artifact does not contain - it is already live, generated from the same
     * policy, and deliberately not overwritten.
     */
    const answerable = new Set(['/watchside/', '/watchside/support', '/watchside/privacy'])

    for (const file of [join(SOURCE, 'index.html'), join(SOURCE, 'support', 'index.html')]) {
      const html = normalise(readFileSync(file, 'utf8'))
      const internal = [...html.matchAll(/href="(\/[^"]*)"/g)].map((match) => match[1])
      expect(internal.length).toBeGreaterThan(0)
      for (const href of internal) {
        expect(answerable.has(href), `${file} links to ${href}, which nothing serves`).toBe(true)
      }
    }
  })

  it('carries no privacy page, so publishing cannot overwrite the live policy', () => {
    // The build emits one; the artifact deliberately does not carry it.
    const files = execFileSync('git', ['ls-files', SOURCE], { encoding: 'utf8' })
    expect(files).not.toMatch(/privacy/)
    expect(files).toMatch(/index\.html/)
    expect(files).toMatch(/support/)
  })

  it('is the page the account panel actually links to', () => {
    // Read the link from source rather than restating it: a link edited in the
    // panel and not here would otherwise pass while pointing somewhere unbuilt.
    const panel = read('src', 'ui', 'components', 'AuthStates.tsx')
    const links = panel.match(/https:\/\/anoteros-labs\.github\.io\/watchside\/support\/?/g) ?? []
    expect(links.length).toBeGreaterThan(0)
  })

  it('answers the questions the page exists for', () => {
    /*
     * The page currently live covers feedback and an email address. It does not
     * cover the panel failing to appear, which is the one case where a page
     * outside the extension is the only thing that can help. These assertions
     * are what stop the replacement regressing to that.
     */
    const support = read(SOURCE, 'support', 'index.html')
    for (const topic of [
      'panel does not appear',
      'Signing in with Twitch is not working',
      'out of date',
      'Notifications are not arriving',
      'deleting your account',
      'Get in touch',
    ]) {
      expect(support).toContain(topic)
    }
  })
})

/**
 * The invite landing page, against the thing it is supposed to be a copy of.
 *
 * This one cannot be compared to a build - it is hand-written and has no
 * generator. What it can be held to is the contract the extension depends on,
 * which is the half that actually matters when somebody copies the file.
 */
describe('the invite landing artifact', () => {
  const INVITE = join('docs', 'web', 'invite-landing', 'index.html')

  it('carries the referral hop the content script reads', () => {
    const html = read(INVITE)
    expect(html).toContain('kickback_invite')
    expect(html).toContain('https://www.twitch.tv/')
  })

  it('validates codes against the alphabet the product issues', () => {
    // Same 22 characters, with I, L, O and U omitted so a code read aloud
    // cannot become a different valid code.
    expect(read(INVITE)).toContain('0-9ABCDEFGHJKMNPQRSTVWXYZ')
  })

  it('builds no destination it did not write itself', () => {
    const html = read(INVITE)
    // The only navigation target is a literal twitch.tv. Nothing reads a
    // destination out of the URL, which is what keeps this off the open-redirect
    // list despite being a page whose whole job is to send people onward.
    expect(html).not.toMatch(/location\.assign|location\.replace|window\.location\s*=/)
  })
})
