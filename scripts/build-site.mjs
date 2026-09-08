/**
 * Assembles the watchside.app static site.
 *
 *   npm run build:site
 *
 * WHY A BUILD RATHER THAN CHECKED-IN HTML
 *
 * The privacy page is generated from `docs/PRIVACY.md` - that was already true,
 * and it is the reason the policy and the published page cannot drift. Once one
 * page is generated the rest may as well share a shell, so there is exactly one
 * place to change a colour, a footer or a meta tag.
 *
 * WHAT IT PRODUCES
 *
 *   /                index.html      what Watchside is, and how to get it
 *   /privacy         privacy/        generated from docs/PRIVACY.md
 *   /support         support/        works whether or not the extension does
 *   /i/<code>        404.html        GitHub Pages serves this for unknown paths
 *   CNAME                            the custom domain
 *   .nojekyll                        no Jekyll processing
 *
 * THE /i/ ROUTE IS THE 404 PAGE ON PURPOSE. A static host has no router, and
 * GitHub Pages answers any unmatched path with 404.html - so that file reads the
 * code out of the path itself. It is the whole reason `/i/<code>` can exist
 * without a server.
 *
 * A SECOND TARGET, FOR TODAY
 *
 *   npm run build:site:pages   ->  dist-pages/  under /watchside/
 *
 * The extension links to a Support page NOW, and watchside.app does not resolve
 * yet. So the same sources also build against the Pages subpath that is already
 * live, which needs no DNS and can be published immediately. The canonical
 * domain replaces it later; until then the link in a shipped build has to lead
 * somewhere real.
 *
 * The subpath build deliberately omits 404.html, /i/ and CNAME. That 404 only
 * works from a domain root, and the org Pages root is not Watchside's to claim.
 *
 * The output is not published from here. See docs/web/watchside-app/README.md;
 * publishing is the owner's, and deliberately so.
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CODE_PATTERN } from './campaign-vocabulary.mjs'

const SOURCE = join('docs', 'web', 'watchside-app')
const PAGES = join(SOURCE, 'pages')
const OUT = process.argv[2] ?? join('dist-site')

/*
 * Where the tree will be served from, with both slashes: '/' for the domain
 * root, '/watchside/' for the Pages subpath.
 *
 * The pages are written with root-absolute links because that is what they
 * mean - Privacy is Privacy wherever the page happens to sit. Rewriting them
 * here keeps one set of sources instead of two that drift.
 */
const BASE = process.argv[3] ?? '/'
/*
 * `src` is rewritten as well as `href` because the landing page now ships
 * images. Without it the subpath build would emit `/img/presence.webp`, which
 * is a 404 under /watchside/ - and a broken hero is not the kind of thing a
 * passing build would have told us about.
 */
const rebase = (html) =>
  BASE === '/' ? html : html.replace(/((?:href|src)=")\/(?!\/)/g, `$1${BASE}`)

// --------------------------------------------------------------- store links

/**
 * The two store listings, in one place.
 *
 * They used to be four hand-typed hrefs in the landing page and two more in the
 * 404. Every one of them now has to carry campaign-derived UTM parameters,
 * which is six chances to tag one wrong - so the page carries placeholders and
 * the URL is built here.
 */
const STORES = {
  chrome: 'https://chromewebstore.google.com/detail/ngfopkeokddfnncdhfkhnffilbdhkkip',
  firefox: 'https://addons.mozilla.org/firefox/addon/watchside/',
}

/**
 * What the two stores actually report, which is NOT the same thing.
 *
 * Chrome breaks down tagged listing PAGE VIEWS. AMO breaks down tagged
 * DOWNLOADS - one step further along the funnel. They are different
 * measurements of different events and must never be added together or
 * presented as one series; see docs/ANALYTICS.md.
 *
 * Both cap or truncate values, AMO at 40 characters, which is why the campaign
 * vocabulary constrains labels to 40 rather than the registry's 80.
 */
const UTM_MAX = 40

/**
 * Outbound UTM parameters, derived from a trusted campaign definition.
 *
 * OUTBOUND ONLY, and this is the rule the whole design rests on. These exist
 * for the vendor's dashboard, the Chrome Web Store's tagged page-view report
 * and AMO's tagged download report. Watchside reads none of them back: a
 * visitor who edits ?utm_source= changes nothing at all, because attribution
 * comes from the opaque code resolved against the server-side registry.
 *
 * `campaign` null is the ordinary landing page: tagged so store traffic from
 * watchside.app is distinguishable in aggregate, and deliberately NOT called
 * "organic attribution" - nothing authenticated is ever attributed from it.
 */
function storeUtm(campaign, siteTag = 'site_landing') {
  const params = new URLSearchParams()
  if (!campaign) {
    params.set('utm_source', 'watchside_site')
    params.set('utm_medium', 'referral')
    params.set('utm_campaign', siteTag)
    return params
  }
  // Every value comes from the registry definition. Nothing is typed by hand.
  params.set('utm_source', campaign.provider ?? campaign.source)
  if (campaign.medium) params.set('utm_medium', campaign.medium)
  params.set('utm_campaign', campaign.code)
  if (campaign.content) params.set('utm_content', campaign.content)
  if (campaign.term) params.set('utm_term', campaign.term)
  for (const [key, value] of [...params]) {
    if (value.length > UTM_MAX) throw new Error(`UTM ${key} exceeds ${UTM_MAX}: ${value}`)
  }
  return params
}

/**
 * One store link's attributes.
 *
 * `target="_blank" rel="noopener"` ONLY on a campaign page, and the asymmetry
 * is the point. On a campaign page the visitor has to come back here to hand
 * the code to Twitch, so leaving in the same tab loses the attribution; on the
 * ordinary landing page there is nothing to come back for and hijacking the
 * tab would be rude.
 *
 * `rel="noreferrer"` is DELIBERATELY ABSENT. It would strip the referrer that
 * the store-side aggregate reporting depends on, which is the entire point of
 * tagging these URLs. `noopener` alone closes the window.opener hole without
 * costing the measurement - they are different flags and only one of them is
 * about security. A test pins this so a future tidy-up cannot "helpfully" add
 * the other one.
 */
function storeLink(store, campaign, siteTag) {
  /*
   * `&` becomes `&amp;` because this lands in an HTML attribute. Browsers
   * forgive a bare `&` here, and forgiving is not the same as correct - a
   * parameter that happened to spell a named entity would be silently rewritten.
   */
  const href = `${STORES[store]}?${storeUtm(campaign, siteTag).toString()}`.replaceAll('&', '&amp;')
  const attrs = campaign ? ` target="_blank" rel="noopener" data-store="${store}"` : ''
  return `href="${href}"${attrs}`
}

/** The campaigns with a pre-rendered page. Not authoritative; the registry is. */
function readCampaigns() {
  const path = join(SOURCE, 'campaigns.json')
  if (!existsSync(path)) return []
  const parsed = JSON.parse(readFileSync(path, 'utf8'))
  const campaigns = Array.isArray(parsed?.campaigns) ? parsed.campaigns : []
  for (const campaign of campaigns) {
    if (!CODE_PATTERN.test(campaign.code ?? '')) {
      throw new Error(`campaigns.json: not a valid campaign code: ${campaign.code}`)
    }
  }
  return campaigns
}

/**
 * The continue-to-Twitch block, for a campaign page.
 *
 * THE DESTINATION IS BAKED AT BUILD TIME from the campaign this page is for.
 * Nothing at runtime reads the URL, so there is nothing for a crafted link to
 * change - the page cannot be made to point anywhere but twitch.tv.
 *
 * Rendered visible and complete, not hidden behind script. campaign.js only
 * emphasises it after a store is chosen.
 */
function continueBlock(campaign) {
  const url = `https://www.twitch.tv/?watchside_campaign=${encodeURIComponent(campaign.code)}`
  return `          <div class="continue" id="continue-block">
            <p id="continue-lead">
              Already installed? Continue to Twitch to finish setting up.
            </p>
            <a class="btn btn-primary" id="continue" href="${url}">Continue to Twitch</a>
          </div>
          <script src="/js/campaign.js"></script>
`
}

/** The one place a page's chrome is defined. */
const SHELL = readFileSync(join(SOURCE, 'shell.html'), 'utf8')

/**
 * One page, from the shared shell.
 *
 * `head` is an optional block of page-specific CSS. The landing page needs a
 * good deal of it and privacy, support and 404 need none, so putting it in the
 * shell would make every document page carry layout rules for a page it is not.
 */
function page({ file, title, description, out, head = '', campaign = null, siteTag }) {
  /*
   * The store links and the campaign block are filled HERE rather than written
   * into the page, because the same source produces the root landing page and
   * one page per campaign, and the only differences between them are these
   * three substitutions. Six hand-typed store URLs was six chances to tag one
   * wrong; now there are none.
   */
  const body = readFileSync(join(PAGES, file), 'utf8')
    .replaceAll('{{CHROME_LINK}}', storeLink('chrome', campaign, siteTag))
    .replaceAll('{{FIREFOX_LINK}}', storeLink('firefox', campaign, siteTag))
    .replace('{{CAMPAIGN_BLOCK}}', campaign ? continueBlock(campaign) : '')

  const html = rebase(
    SHELL.replace('{{TITLE}}', title)
      .replace('{{DESCRIPTION}}', description)
      .replace('{{HEAD}}', head)
      .replace('{{BODY}}', body.replace(/\n$/, '')),
  )

  const target = join(OUT, out)
  mkdirSync(join(target, '..'), { recursive: true })
  writeFileSync(target, html)
  return target
}

const LANDING_CSS = readFileSync(join(SOURCE, 'landing.css'), 'utf8')

rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

const written = [
  page({
    file: 'index.html',
    head: LANDING_CSS,
    title: 'Watchside — see where your friends are watching Twitch',
    description:
      'Watchside is a browser extension that shows which Twitch streams your friends are on, so you can jump in and watch together.',
    out: 'index.html',
  }),
  page({
    file: 'support.html',
    title: 'Support — Watchside',
    description: 'Help with Watchside, including when the extension will not open.',
    out: join('support', 'index.html'),
  }),
  ...(BASE === '/'
    ? [
  /*
   * Both the 404 and the invite landing.
   *
   * Written twice: once as 404.html for unmatched paths, and once at /i/ so the
   * bare route resolves rather than falling through. The bare route shows the
   * plain page, because /i/ with no code is not an invite.
   */
  page({
    file: '404.html',
    title: 'Watchside',
    description: 'Watchside — see where your friends are watching Twitch.',
    out: '404.html',
    siteTag: 'site_fallback',
  }),
  page({
    file: '404.html',
    title: 'Watchside',
    description: 'Watchside — see where your friends are watching Twitch.',
    out: join('i', 'index.html'),
    siteTag: 'site_fallback',
  }),
  /* The bare campaign route, so /c/ resolves rather than falling through. */
  page({
    file: '404.html',
    title: 'Watchside',
    description: 'Watchside — see where your friends are watching Twitch.',
    out: join('c', 'index.html'),
    siteTag: 'site_fallback',
  }),
      ]
    : []),
]

/*
 * A REAL PAGE PER CAMPAIGN, at /c/<code>/.
 *
 * WHAT THIS REPLACES, AND WHY IT MATTERED
 *
 * /c/<code> used to fall through to 404.html, which meant paid traffic landed
 * on an HTTP 404 carrying a logo, one paragraph and two buttons - not the
 * landing page with the screenshots, the how-it-works section and the privacy
 * section that the whole site exists to be. Buying clicks to that would have
 * been buying clicks to the worst page on the domain.
 *
 * A static host has no router, so the only way to answer 200 is for the file to
 * exist. One file per minted campaign, from the same source as the root page.
 *
 * 404.html KEEPS its campaign branch as the fallback, so a code that has been
 * minted but not yet rebuilt, or a link from a campaign retired long ago, still
 * reaches a working page rather than a bare 404.
 *
 * NOT MERGED WITH /i/<code>. A campaign says how somebody discovered Watchside;
 * an invite says which user brought them. Different facts, different tables,
 * different parameters, and a shared route would make a code's meaning depend
 * on context - discovered wrong in a report six weeks later.
 */
const campaigns = BASE === '/' ? readCampaigns() : []
for (const campaign of campaigns) {
  written.push(
    page({
      file: 'index.html',
      head: LANDING_CSS,
      title: 'Watchside — see where your friends are watching Twitch',
      description:
        'Watchside is a browser extension that shows which Twitch streams your friends are on, so you can jump in and watch together.',
      out: join('c', campaign.code, 'index.html'),
      campaign,
    }),
  )
}

/*
 * The privacy page, from the policy itself.
 *
 * Same generator the published Pages copy already uses, so the two cannot say
 * different things. `../` is the back link because the page sits at /privacy/.
 */
// The generator writes a file and does not make directories - it was written to
// target an existing published tree.
mkdirSync(join(OUT, 'privacy'), { recursive: true })
execFileSync(
  process.execPath,
  [
    join('scripts', 'build-privacy-page.mjs'),
    join(OUT, 'privacy', 'index.html'),
    BASE,
    'Watchside',
  ],
  { stdio: 'inherit' },
)
written.push(join(OUT, 'privacy', 'index.html'))

/*
 * CNAME is what makes GitHub Pages serve the custom domain, and it lives in the
 * published output rather than anywhere clever. One line, no trailing path.
 *
 * NEVER written for the subpath build: a CNAME in the org Pages repo would
 * rebind that whole site to watchside.app and take /kickback/ with it.
 */
if (BASE === '/') writeFileSync(join(OUT, 'CNAME'), 'watchside.app\n')
writeFileSync(join(OUT, '.nojekyll'), '')

if (existsSync(join(SOURCE, 'static'))) {
  cpSync(join(SOURCE, 'static'), OUT, { recursive: true })
}

/*
 * The two scripts, as FILES.
 *
 * They are files rather than inline blocks so the Content-Security-Policy in
 * the shell can say `script-src 'self'` and mean it. An inline script would
 * force either 'unsafe-inline' - which is not a strict policy - or a per-page
 * hash, which is more machinery than two small files are worth.
 */
cpSync(join(SOURCE, 'js'), join(OUT, 'js'), { recursive: true })

console.log(`wrote ${written.length + (BASE === '/' ? 2 : 1)} files to ${OUT} (base ${BASE})`)
for (const file of written) console.log(`  ${file}`)
if (BASE === '/') console.log(`  ${join(OUT, 'CNAME')}`)
console.log(`  ${join(OUT, '.nojekyll')}`)
