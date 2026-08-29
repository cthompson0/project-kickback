/**
 * Types for scripts/manifest.mjs.
 *
 * The transform is plain ESM so packaging scripts can import it without a
 * build step, but tests/extension/browserAdapter.test.ts imports it too - and
 * a manifest transform typed as `any` would be a poor place to lose type
 * safety, given what it decides.
 */

/** The permanent Firefox add-on id. The Gecko OAuth redirect derives from it. */
export declare const GECKO_ID: string

/** The oldest Firefox Watchside will install on. */
export declare const GECKO_MIN_VERSION: string

/**
 * What Watchside collects, in Mozilla's data-collection taxonomy.
 *
 * `optional` is deliberately absent rather than empty: the only optional type
 * Mozilla offers is `technicalAndInteraction`, and declaring it means honouring
 * a user who declines it.
 */
export declare const GECKO_DATA_COLLECTION: {
  required: string[]
  optional?: string[]
}

/** The Chromium manifest's broad backend grant, which Gecko narrows. */
export declare const SUPABASE_WILDCARD: string

/** Derive the manifest for a target engine. Pure; mutates nothing. */
export declare function manifestFor(
  target: string,
  source: Record<string, unknown>,
  options?: { supabaseOrigin?: string | null },
): Record<string, unknown>
