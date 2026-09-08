/**
 * Types for scripts/campaign-vocabulary.mjs.
 *
 * The vocabulary is plain ESM so `campaign.mjs` and `build-site.mjs` can import
 * it without a build step, but two test suites import it as well - and a list
 * that the database's check constraints are asserted against is a poor place to
 * lose type safety.
 */

/** The channel class. Unchanged since 0038; `reddit` has always been in it. */
export declare const SOURCES: string[]

/** The advertising or distribution platform. New in 0045, and immutable once minted. */
export declare const PROVIDERS: string[]

/** How the traffic was obtained. New in 0045, and immutable once minted. */
export declare const MEDIUMS: string[]

/** The campaign code alphabet, identical to 0038's check constraint. */
export declare const CODE_PATTERN: RegExp

/** A human label's shape. 40 characters, because AMO truncates a UTM value there. */
export declare const LABEL_PATTERN: RegExp

/** What a `content` or `term` value may be: human, renameable, UTM-safe. */
export declare const VARIANT_PATTERN: RegExp

export declare function isCode(value: unknown): boolean
export declare function isVariant(value: unknown): boolean
