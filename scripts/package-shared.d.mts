/**
 * Types for scripts/package-shared.mjs.
 *
 * The packagers are plain ESM so they can run without a build step, but
 * tests/extension/firefoxPackage.test.ts imports the shared rules to assert
 * they are still the rules - and a safety net typed as `any` would be a poor
 * place to lose type checking.
 */
export declare const RUNTIME_FILES: string[]
export declare const FORBIDDEN_PATHS: string[]
export declare const FORBIDDEN_CONTENT: Array<{ label: string; pattern: RegExp }>
export declare const FILE_SCOPED_CONTENT: Record<string, Array<{ label: string; pattern: RegExp }>>
export declare const DEMO_MARKERS: string[]
export declare const JWT_LITERAL: RegExp
export declare function step(label: string): void
export declare function run(command: string, args: string[], env?: Record<string, string>): void
export declare function walk(dir: string, base?: string): string[]
export declare function createScanner(fail: (message: string) => void): {
  scanContents(root: string, files: string[], where: string): void
  checkPaths(paths: string[], where: string): void
}
