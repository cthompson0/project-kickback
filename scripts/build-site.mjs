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
const rebase = (html) =>
  BASE === '/' ? html : html.replace(/(href=")\/(?!\/)/g, `$1${BASE}`)

/** The one place a page's chrome is defined. */
const SHELL = readFileSync(join(SOURCE, 'shell.html'), 'utf8')

function page({ file, title, description, out }) {
  const body = readFileSync(join(PAGES, file), 'utf8')
  const html = rebase(
    SHELL.replace('{{TITLE}}', title)
      .replace('{{DESCRIPTION}}', description)
      .replace('{{BODY}}', body.replace(/\n$/, '')),
  )

  const target = join(OUT, out)
  mkdirSync(join(target, '..'), { recursive: true })
  writeFileSync(target, html)
  return target
}

rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

const written = [
  page({
    file: 'index.html',
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
  }),
  page({
    file: '404.html',
    title: 'Watchside',
    description: 'Watchside — see where your friends are watching Twitch.',
    out: join('i', 'index.html'),
  }),
      ]
    : []),
]

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

console.log(`wrote ${written.length + (BASE === '/' ? 2 : 1)} files to ${OUT} (base ${BASE})`)
for (const file of written) console.log(`  ${file}`)
if (BASE === '/') console.log(`  ${join(OUT, 'CNAME')}`)
console.log(`  ${join(OUT, '.nojekyll')}`)
