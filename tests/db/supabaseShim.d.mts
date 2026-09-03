/**
 * Types for the shared shim.
 *
 * The shim itself is .mjs because `scripts/schema-fingerprint.mjs` runs under
 * bare node - the authorization gate must be able to build a schema without a
 * test runner - and `tests/db/harness.ts` needs the identical text. This is the
 * one line of glue that keeps TypeScript happy about the arrangement.
 */
export declare const SUPABASE_SHIM: string
