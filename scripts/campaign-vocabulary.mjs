/**
 * The closed sets a campaign is described with, in one place.
 *
 * WHY THIS FILE EXISTS
 *
 * Four things have to agree about what a valid campaign looks like: the check
 * constraints in `supabase/migrations/0045_acquisition_provider_metadata.sql`,
 * the minting tool, the site build that pre-renders a page per campaign, and
 * the tests. Four hand-typed copies of a list is how a report quietly
 * undercounts six weeks later, and it is exactly the failure `0038` prevented
 * for `source` by writing the constraint down once.
 *
 * `tests/extension/campaignVocabulary.test.ts` reads the SQL and asserts this
 * file agrees with it, so the duplication cannot drift.
 *
 * THE SERVER IS STILL AUTHORITATIVE. Nothing here is trusted by the database;
 * this is the tooling's copy so a bad campaign fails at the terminal rather
 * than at a paste. The registry decides what a campaign IS.
 */

/**
 * The channel class. UNCHANGED from 0038 - this list is not this milestone's
 * to edit, and `reddit` has been in it since the beginning.
 */
export const SOURCES = [
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

/**
 * Which advertising or distribution platform this campaign runs on.
 *
 * NEW IN 0045, and deliberately NOT the same question as `source`. `source` is
 * the channel class Watchside has always grouped by; `provider` is the vendor
 * whose dashboard the spend and the click count live in. They are usually the
 * same word and occasionally are not: a creator campaign paid for through
 * Reddit has `source = 'creator'` and `provider = 'reddit'`, and collapsing
 * them would make one of those two questions unanswerable.
 *
 * `null` means no paid provider - an organic post, a launch, a link in a
 * README. Absence is the honest value there, not a `direct` bucket.
 *
 * DELIBERATELY SHORT. Only providers we have an actual reason to name are
 * here. Widening it is one line in a migration and one line here, together,
 * which is the point: adding a provider is a decision somebody made, not a
 * string somebody typed.
 */
export const PROVIDERS = [
  'reddit',
  'google',
  'meta',
  'tiktok',
  'x',
  'producthunt',
  'hackernews',
]

/**
 * How the traffic was obtained.
 *
 * The vocabulary a marketer means by "medium", constrained so a report can
 * group on it. IMMUTABLE once minted, for the same reason `source` is: it is a
 * grouping key, and editing one would silently rewrite what every historical
 * comparison meant.
 */
export const MEDIUMS = [
  'paid_social',
  'organic_social',
  'launch',
  'referral',
  'organic_search',
  'press',
  'creator',
]

/** The campaign code alphabet. Identical to 0038's constraint and core/acquisition.ts. */
export const CODE_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])$/

/**
 * A free-text label's shape: short, printable, and not a payload.
 *
 * 40 characters rather than 80, because these become UTM values and AMO
 * truncates a UTM parameter at 40. A label that arrives truncated in one
 * dashboard and whole in another is a label two reports disagree about.
 */
export const LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,39}$/

/** What a `content` or `term` value may be. Human, renameable, UTM-safe. */
export const VARIANT_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,39})$/

export function isCode(value) {
  return typeof value === 'string' && CODE_PATTERN.test(value)
}

export function isVariant(value) {
  return typeof value === 'string' && VARIANT_PATTERN.test(value)
}
