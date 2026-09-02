import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Every request the client can make has somewhere to land.
 *
 * WHY THIS EXISTS
 *
 * `badgeCatalog` was added to the RPC union, to the port client, and to the
 * worker's handler map - and the worker never imported the function that handler
 * calls. The typecheck says so plainly, but only when it is actually run: the
 * root tsconfig is solution-style with `files: []`, so a bare `tsc --noEmit`
 * against it checks nothing at all and exits happily. That is a trap worth a
 * test rather than a note, because the same command looks correct to the next
 * person who types it. `npm run typecheck` now runs `tsc -b`, which is the one
 * that reads the project references.
 *
 * The cost of missing it was not a compile error somebody would notice. It was a
 * feature that looked finished, passed its own component tests against a stub
 * client, and would have thrown the first time a real panel opened.
 *
 * WHAT THIS PROVES, AND WHAT IT DOES NOT
 *
 * It proves three lists agree: the RPC union, the worker's handlers, and each
 * client implementation. It does not prove any handler is correct - that is what
 * the rest of the suite is for. It is a shape check for the one seam where
 * several files must be edited together and nothing forces them to be.
 */

const read = (...parts: string[]) => readFileSync(join(...parts), 'utf8')

/** The RPC names, from the union that defines them. */
function rpcMethods(): string[] {
  const source = read('src', 'client', 'messages.ts')
  const start = source.indexOf('export type RpcMethod')
  expect(start).toBeGreaterThan(-1)
  const block = source.slice(start, source.indexOf('export type ClientMessage'))
  return [...block.matchAll(/^\s*\|\s*'([a-zA-Z]+)'/gm)].map((match) => match[1])
}

const METHODS = rpcMethods()

describe('every client request has a handler and an implementation', () => {
  it('finds the union at all', () => {
    // If this fails the union was renamed or reshaped, and every assertion below
    // would otherwise pass vacuously against an empty list.
    expect(METHODS.length).toBeGreaterThan(20)
    expect(METHODS).toContain('badgeCatalog')
    expect(METHODS).toContain('searchUsers')
  })

  it('answers each one in the worker', () => {
    const worker = read('src', 'background', 'index.ts')
    const missing = METHODS.filter((method) => !worker.includes(`\n  ${method}:`))
    expect(missing, `the worker has no handler for: ${missing.join(', ')}`).toEqual([])
  })

  it('calls nothing the worker has not imported', () => {
    /*
     * The actual defect, caught directly.
     *
     * A handler body calling a bare identifier that is neither imported nor
     * declared in the file is a runtime ReferenceError and nothing else: the
     * message arrives, the handler runs, and the surface that asked gets an
     * error it cannot explain.
     */
    const worker = read('src', 'background', 'index.ts')

    const imported = new Set<string>()
    for (const match of worker.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from/g)) {
      for (const raw of match[1].split(',')) {
        const name = raw.trim().split(/\s+as\s+/).pop()
        if (name) imported.add(name.trim())
      }
    }
    expect(imported.size, 'no imports were parsed, so this test proves nothing').toBeGreaterThan(10)

    const declared = new Set<string>()
    for (const match of worker.matchAll(
      /^\s*(?:export\s+)?(?:async\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm,
    )) {
      declared.add(match[1])
    }

    const problems: string[] = []
    for (const method of METHODS) {
      const start = worker.indexOf(`\n  ${method}:`)
      if (start < 0) continue
      // The handler body, to its closing brace at the map's indentation.
      const end = worker.indexOf('\n  },', start)
      if (end < 0) continue
      const body = worker.slice(start, end)

      for (const call of body.matchAll(/await\s+([a-z][\w$]*)\s*\(/g)) {
        const name = call[1]
        if (!imported.has(name) && !declared.has(name)) {
          problems.push(`${method} calls ${name}(), which the worker neither imports nor declares`)
        }
      }
    }
    expect(problems).toEqual([])
  })

  it('implements each one in every client', () => {
    /*
     * The port client is the real one. Demo and the Test Lab are the two that
     * are easy to forget, and forgetting either crashes the whole panel at
     * render rather than failing the one surface that asked - which is how a
     * single missing method turned into sixteen unrelated Test Lab failures.
     */
    for (const file of [
      join('src', 'client', 'port.ts'),
      join('src', 'client', 'demo.ts'),
      join('src', 'testlab', 'client.ts'),
    ]) {
      const source = read(file)
      const missing = METHODS.filter(
        (method) =>
          // A property, a shorthand method, or an async method - any of the
          // three is an implementation. Absence of all three is not.
          !source.includes(`${method}:`) &&
          !source.includes(`${method}(`) &&
          !source.includes(`${method} (`),
      )
      expect(missing, `${file} does not implement: ${missing.join(', ')}`).toEqual([])
    }
  })
})
