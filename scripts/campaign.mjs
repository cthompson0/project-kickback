/**
 * Mint a campaign: the SQL that makes it real, the link to publish, and the
 * manifest entry that gets it a landing page.
 *
 *   npm run campaign -- --code reddit-launch-a --source reddit \
 *                       --provider reddit --medium paid_social \
 *                       --content explanatory_presence \
 *                       --label "Reddit launch - explanatory"
 *
 * WHY A SCRIPT THAT PRINTS SQL RATHER THAN ONE THAT RUNS IT
 *
 * There is no campaign management UI and M5C deliberately does not build one.
 * What is actually needed is narrow: get a correct, validated row into
 * `acquisition_campaigns`, and get the link out without anybody hand-assembling
 * a URL and typoing the code into a stream overlay.
 *
 * It prints rather than executes because minting a campaign is a decision, not
 * a build step - and because the alternative is holding a database credential
 * in a place that never needed one. Paste the statement into the SQL editor;
 * the whole workflow is one copy each way.
 *
 * WHAT 0045 ADDED, AND THE PROBLEM IT SOLVES
 *
 * A campaign now carries `provider`, `medium`, `content` and `term`, and those
 * same four facts are what a store URL's UTM parameters have to say. Typing
 * them twice - once into SQL, once into a URL - is how a campaign ends up whose
 * registry definition and published link disagree, and nothing would ever
 * notice. So this script emits BOTH from one set of arguments, and writes the
 * manifest the site build pre-renders from. There is no supported path in which
 * a human types a UTM value by hand.
 *
 * UTMs ARE OUTBOUND ONLY. They exist for Reddit's dashboard, the Chrome Web
 * Store's tagged page-view report and AMO's tagged download report. Nothing in
 * Watchside ever reads one back: attribution comes from the opaque code, which
 * resolves against this registry server-side. A visitor editing
 * `?utm_source=` changes nothing at all.
 *
 * WHAT IT REFUSES, AND WHY THAT MATTERS HERE
 *
 * Every constraint the database enforces is checked first, so a bad campaign
 * fails at the terminal rather than at a paste. The ones that matter most are
 * SOURCE, PROVIDER and MEDIUM: all three are immutable once minted (0038,
 * 0045), because reports group on them and editing one would silently rewrite
 * the meaning of every historical comparison. Getting one wrong means minting a
 * new code, so getting one wrong here is worth preventing.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CODE_PATTERN,
  LABEL_PATTERN,
  MEDIUMS,
  PROVIDERS,
  SOURCES,
  VARIANT_PATTERN,
} from './campaign-vocabulary.mjs'

/** The committed list the site build pre-renders a page from. */
const MANIFEST = join('docs', 'web', 'watchside-app', 'campaigns.json')

function usage(message) {
  if (message) console.error(`\n  ${message}\n`)
  console.error(`  Usage:
    npm run campaign -- --code <code> --source <source> --label "<label>"
                        [--provider <provider>] [--medium <medium>]
                        [--content <variant>] [--term <variant>]
                        [--creator <key>] [--no-manifest]
    npm run campaign -- --list-vocabulary
    npm run campaign -- --retire <code>

  --code      the immutable public identity, lowercase and hyphenated.
              This ends up in an ad URL and a stream panel, so it is readable
              rather than opaque. It can never be changed.
  --source    one of: ${SOURCES.join(', ')}
              IMMUTABLE once minted. Wrong source means a new code.
  --provider  one of: ${PROVIDERS.join(', ')}
              The ad/distribution platform whose dashboard holds the spend.
              NOT a synonym for source: a creator campaign bought through
              Reddit is source=creator, provider=reddit. IMMUTABLE.
              Omit entirely when there is no paid provider.
  --medium    one of: ${MEDIUMS.join(', ')}
              How the traffic was obtained. IMMUTABLE - reports group on it.
  --content   the creative/variant label, e.g. explanatory_presence.
              MUTABLE: rename it whenever you like, the code is the identity.
  --term      the targeting/keyword label. MUTABLE.
  --creator   optional stable key for the creator or partner this campaign is
              associated with. NOT a Twitch login, and not a claim that they
              authorized anything.
  --label     the human name, up to 40 characters. Change it whenever you like.

  --no-manifest  print only; do not add the campaign to ${MANIFEST}.
`)
  process.exit(message ? 1 : 0)
}

const argv = process.argv.slice(2)
const flag = (name) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}
const has = (name) => argv.includes(`--${name}`)

if (has('help') || argv.length === 0) usage()

if (has('list-vocabulary')) {
  console.log(`sources:   ${SOURCES.join(', ')}`)
  console.log(`providers: ${PROVIDERS.join(', ')}`)
  console.log(`mediums:   ${MEDIUMS.join(', ')}`)
  process.exit(0)
}

// --------------------------------------------------------------- the manifest

function readManifest() {
  if (!existsSync(MANIFEST)) return { campaigns: [] }
  try {
    const parsed = JSON.parse(readFileSync(MANIFEST, 'utf8'))
    return { campaigns: Array.isArray(parsed?.campaigns) ? parsed.campaigns : [] }
  } catch {
    usage(`${MANIFEST} exists but is not readable JSON. Fix or delete it.`)
  }
}

/**
 * Add or update one campaign, keeping the file sorted and stable.
 *
 * Sorted by code so a diff shows what changed rather than where it landed, and
 * rewritten wholesale so a hand-edited file is normalised the next time this
 * runs. The manifest is NOT authoritative - the database is - but a campaign
 * missing from it simply has no pre-rendered page, which is a visible failure
 * rather than a silent one.
 */
function writeManifest(entry) {
  const manifest = readManifest()
  const others = manifest.campaigns.filter((campaign) => campaign.code !== entry.code)
  const campaigns = [...others, entry].sort((a, b) => a.code.localeCompare(b.code))
  writeFileSync(MANIFEST, `${JSON.stringify({ campaigns }, null, 2)}\n`)
  return campaigns.length
}

// -------------------------------------------------------------------- retire

const retire = flag('retire')
if (retire) {
  if (!CODE_PATTERN.test(retire)) usage(`Not a valid campaign code: ${retire}`)
  /*
   * Retiring closes a campaign to NEW attribution and destroys nothing. Rows
   * already attributed keep their attribution and the definition stays, so the
   * old numbers remain readable. That is the difference between disabling a bad
   * link and deleting history, and only one of them is recoverable.
   *
   * The manifest entry is left alone deliberately: the landing page should keep
   * answering for a link already circulating in an ad, a comment or a
   * screenshot. A retired campaign resolves to `inactive` at bind time, which
   * 0040 records, rather than to a dead page.
   */
  console.log(`
-- Closes ${retire} to new attribution. Existing attribution is untouched,
-- and every number already reported about it stays reconstructable.
update public.acquisition_campaigns
   set active = false
 where code = '${retire}';
`)
  console.log(`-- The landing page for /c/${retire}/ is deliberately left in place,`)
  console.log('-- so links already circulating still reach a real page.')
  process.exit(0)
}

// ------------------------------------------------------------------ validate

const code = flag('code')
const source = flag('source')
const provider = flag('provider')
const medium = flag('medium')
const content = flag('content')
const term = flag('term')
const creator = flag('creator')
const label = flag('label')

if (!code) usage('--code is required.')
if (!CODE_PATTERN.test(code)) {
  usage(
    `Not a valid campaign code: ${code}\n  ` +
      'Lowercase letters, digits and hyphens; 2-32 characters; no leading or trailing hyphen.',
  )
}
if (!source) usage('--source is required.')
if (!SOURCES.includes(source)) usage(`Not a known source: ${source}\n  One of: ${SOURCES.join(', ')}`)
if (provider !== undefined && !PROVIDERS.includes(provider)) {
  usage(`Not a known provider: ${provider}\n  One of: ${PROVIDERS.join(', ')}`)
}
if (medium !== undefined && !MEDIUMS.includes(medium)) {
  usage(`Not a known medium: ${medium}\n  One of: ${MEDIUMS.join(', ')}`)
}
if (content !== undefined && !VARIANT_PATTERN.test(content)) {
  usage(`Not a valid --content: ${content}\n  Lowercase, digits, _ and -; up to 40 characters.`)
}
if (term !== undefined && !VARIANT_PATTERN.test(term)) {
  usage(`Not a valid --term: ${term}\n  Lowercase, digits, _ and -; up to 40 characters.`)
}
if (creator !== undefined && !CODE_PATTERN.test(creator)) {
  usage(`Not a valid creator key: ${creator}`)
}
if (!label) usage('--label is required.')
if (!LABEL_PATTERN.test(label)) {
  usage(
    `Not a valid --label: ${label}\n  ` +
      'Up to 40 characters, letters/digits/space/._- and starting with a letter or digit.\n  ' +
      '40 because AMO truncates a UTM value there, and a label that arrives cut in\n  ' +
      'one dashboard and whole in another is a label two reports disagree about.',
  )
}

/*
 * A paid campaign with no provider is almost always a mistake, and it is the
 * mistake that costs the most: the spend lives in a vendor dashboard that
 * nothing can then be joined to. A warning rather than a refusal, because a
 * paid placement bought outside any of the known providers is a real thing.
 */
if (medium === 'paid_social' && provider === undefined) {
  console.error(
    '\n  NOTE: medium=paid_social with no --provider. Spend will live in a vendor\n' +
      '  dashboard this campaign cannot be joined to. Intended?\n',
  )
}

// Single quotes are the only thing that could break out of the literal.
const quoted = (value) => (value === undefined ? 'null' : `'${String(value).replace(/'/g, "''")}'`)

console.log(`
-- ${label}
--   source   ${source}
--   provider ${provider ?? '(none)'}
--   medium   ${medium ?? '(none)'}
--   content  ${content ?? '(none)'}
--   term     ${term ?? '(none)'}
--   creator  ${creator ?? '(none)'}
--
-- source, provider, medium and creator are IMMUTABLE after this runs, because
-- reports group on them. If one is wrong, mint a new code rather than editing
-- the row. content, term and label may be changed freely.
insert into public.acquisition_campaigns
  (code, source, creator_key, label, active, provider, medium, content, term)
values (
  ${quoted(code)}, ${quoted(source)}, ${quoted(creator)}, ${quoted(label)}, true,
  ${quoted(provider)}, ${quoted(medium)}, ${quoted(content)}, ${quoted(term)}
)
on conflict (code) do update
  set label   = excluded.label,
      active  = true,
      content = excluded.content,
      term    = excluded.term;
`)

/*
 * The link, and the UTMs generated FROM the definition above.
 *
 * The campaign URL itself carries only the code - that is 0038's whole defence,
 * and nothing about it changes here. The UTM parameters are decoration for the
 * vendor's own dashboard and for a human reading the link; Watchside reads none
 * of them, so a visitor editing one changes nothing.
 */
const utm = new URLSearchParams()
utm.set('utm_source', provider ?? source)
if (medium) utm.set('utm_medium', medium)
utm.set('utm_campaign', code)
if (content) utm.set('utm_content', content)
if (term) utm.set('utm_term', term)

console.log(`-- The link to publish:
--   https://watchside.app/c/${code}/?${utm.toString()}
--
-- The path segment is the trusted identity. The query string is outbound
-- interop metadata for the vendor dashboard and is never read back.
`)

if (has('no-manifest')) {
  console.log(`-- --no-manifest: ${MANIFEST} was not changed, so /c/${code}/ will NOT be`)
  console.log('-- pre-rendered and the link will fall through to the 404 campaign branch.')
} else {
  const total = writeManifest({
    code,
    source,
    ...(provider !== undefined ? { provider } : {}),
    ...(medium !== undefined ? { medium } : {}),
    ...(content !== undefined ? { content } : {}),
    ...(term !== undefined ? { term } : {}),
    label,
  })
  console.log(`-- ${MANIFEST} updated (${total} campaigns).`)
  console.log('-- Run `npm run build:site` to pre-render /c/' + code + '/ as a real page.')
}
