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

/** Derive the manifest for a target engine. Pure; mutates nothing. */
export declare function manifestFor(
  target: string,
  source: Record<string, unknown>,
): Record<string, unknown>
