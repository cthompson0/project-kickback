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

/**
 * Every distinct backend origin a built bundle names.
 *
 * Callers assert the result has exactly one element, so the Gecko host
 * permission can only ever name the backend the code actually talks to.
 */
export declare function backendOriginsIn(source: string): string[]

/**
 * Whether a set of host permissions actually grants an origin. The Chromium
 * manifest declares its backend grant statically, so nothing else checks it.
 */
export declare function grantsOrigin(patterns: string[], origin: string): boolean
