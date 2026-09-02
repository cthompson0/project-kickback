/**
 * Mint a campaign link, and the SQL that makes it real.
 *
 *   npm run campaign -- --code lirik-oct --source creator --creator lirik \
 *                       --label "LIRIK October"
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
 * WHAT IT REFUSES, AND WHY THAT MATTERS HERE
 *
 * Every constraint the database enforces is checked first, so a bad campaign
 * fails at the terminal rather than at a paste. The one that matters most is
 * SOURCE: it is immutable once minted (0038), because `acquisition_attributed`
 * events carry it and editing it later would silently rewrite the meaning of
 * every historical event. Getting it wrong here means minting a new code, so
 * getting it wrong here is worth preventing.
 */

const SOURCES = [
  'tiktok',
  'x',
  'youtube',
  'twitch',
  'creator',
  'discord',
  'reddit',
  'press',
  'direct',
  'other',
]

/** The same shape 0038 checks, and core/acquisition.ts validates. */
const CODE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])$/

function usage(message) {
  if (message) console.error(`\n  ${message}\n`)
  console.error(`  Usage:
    npm run campaign -- --code <code> --source <source> [--creator <key>] --label "<label>"
    npm run campaign -- --list-sources
    npm run campaign -- --retire <code>

  --code     the immutable public identity, lowercase and hyphenated.
             This ends up in a stream panel and a TikTok bio, so it is
             readable rather than opaque. It can never be changed.
  --source   one of: ${SOURCES.join(', ')}
             IMMUTABLE once minted. Wrong source means a new code.
  --creator  optional stable key for the creator or partner this campaign is
             associated with. NOT a Twitch login, and not a claim that they
             authorized anything.
  --label    the human name. Change it whenever you like: links do not depend
             on it, which is the whole point of the code being the identity.
`)
  process.exit(message ? 1 : 0)
}

const argv = process.argv.slice(2)
const flag = (name) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}

if (argv.includes('--help') || argv.length === 0) usage()

if (argv.includes('--list-sources')) {
  console.log(SOURCES.join('\n'))
  process.exit(0)
}

const retire = flag('retire')
if (retire) {
  if (!CODE.test(retire)) usage(`Not a valid campaign code: ${retire}`)
  /*
   * Retiring closes a campaign to NEW attribution and destroys nothing. Rows
   * already attributed keep their attribution and the definition stays, so the
   * old numbers remain readable. That is the difference between disabling a bad
   * link and deleting history, and only one of them is recoverable.
   */
  console.log(`
-- Closes ${retire} to new attribution. Existing attribution is untouched,
-- and every number already reported about it stays reconstructable.
update public.acquisition_campaigns
   set active = false
 where code = '${retire}';
`)
  process.exit(0)
}

const code = flag('code')
const source = flag('source')
const creator = flag('creator')
const label = flag('label')

if (!code) usage('--code is required.')
if (!CODE.test(code)) {
  usage(
    `Not a valid campaign code: ${code}\n  ` +
      'Lowercase letters, digits and hyphens; 2-32 characters; no leading or trailing hyphen.',
  )
}
if (!source) usage('--source is required.')
if (!SOURCES.includes(source)) {
  usage(`Not a known source: ${source}\n  One of: ${SOURCES.join(', ')}`)
}
if (creator !== undefined && !CODE.test(creator)) {
  usage(`Not a valid creator key: ${creator}`)
}
if (!label) usage('--label is required.')
if (label.length > 80) usage('--label must be 80 characters or fewer.')

// Single quotes are the only thing that could break out of the literal, and a
// label is the only free-text field here.
const quoted = (value) => (value === undefined ? 'null' : `'${String(value).replace(/'/g, "''")}'`)

console.log(`
-- ${label}
--   source  ${source}${source === 'creator' || creator ? '' : ''}
--   creator ${creator ?? '(none)'}
--
-- source and creator are IMMUTABLE after this runs. If either is wrong, mint a
-- new code rather than editing the row: historical events carry the source.
insert into public.acquisition_campaigns (code, source, creator_key, label, active)
values (${quoted(code)}, ${quoted(source)}, ${quoted(creator)}, ${quoted(label)}, true)
on conflict (code) do update
  set label = excluded.label,
      active = true;

-- The link to publish:
--   https://watchside.app/c/${code}
`)
