import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { humanMessage, serverMessage } from '../../src/core/errors'

/**
 * What a person is told when something fails.
 *
 * THE DEFECT THIS PINS
 *
 * Eighteen call sites were written as
 *
 *     cause instanceof Error ? cause.message : 'Could not send that request.'
 *
 * which reads as "the real reason, with a sentence as backup" and behaves as the
 * opposite: a thrown cause is nearly always an Error, so the raw message was the
 * normal path and the written sentence was almost never used. A failed friend
 * request showed `TypeError: Failed to fetch`; a rejected insert could show a
 * Postgres constraint name.
 *
 * WHY A SOURCE SCAN AND NOT ONLY A UNIT TEST
 *
 * The unit test proves the helper is right. The scan proves the helper is
 * USED - and this is exactly the shape of fix that gets undone later by somebody
 * restoring `cause.message` to "give users more detail", which is how it got
 * here in the first place.
 */

function tsxFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) out.push(...tsxFiles(path))
    else if (/\.tsx?$/.test(entry)) out.push(path)
  }
  return out
}

describe('the written sentence is what a person sees', () => {
  it('returns the sentence for a real Error', () => {
    const cause = new TypeError('Failed to fetch')
    expect(humanMessage(cause, 'Could not send that request.')).toBe(
      'Could not send that request.',
    )
  })

  it('returns the sentence for a database-shaped failure', () => {
    const cause = new Error('duplicate key value violates unique constraint "friendships_pkey"')
    expect(humanMessage(cause, 'Could not send that request.')).toBe(
      'Could not send that request.',
    )
  })

  it('returns the sentence for anything else thrown', () => {
    for (const cause of [null, undefined, 'a string', 42, { message: 'nope' }]) {
      expect(humanMessage(cause, 'That did not work.')).toBe('That did not work.')
    }
  })
})

describe('a server sentence written for a person is allowed through', () => {
  it('passes a plain sentence', () => {
    expect(serverMessage('Twitch permissions are disabled in the Test Lab.', 'fallback')).toBe(
      'Twitch permissions are disabled in the Test Lab.',
    )
  })

  it.each([
    ['a stack frame', '    at handler (index.js:1:1)'],
    ['a type name', 'TypeError: cannot read properties'],
    ['an Error prefix', 'Error: something failed'],
    ['a constraint', 'violates unique constraint "friendships_pkey"'],
    ['a JSON blob', '{"code":"PGRST116"}'],
    ['a URL', 'request to https://xyz.supabase.co/rest/v1 failed'],
    ['an essay', 'x'.repeat(200)],
    ['nothing', ''],
    ['null', null],
  ])('refuses %s and uses the written sentence', (_label, message) => {
    expect(serverMessage(message, 'We could not do that.')).toBe('We could not do that.')
  })
})

describe('no panel surface shows a raw error message', () => {
  it('has no `instanceof Error ? …message` left in the UI', () => {
    /*
     * The pattern itself, banned by scan. It is not wrong everywhere - logging
     * a cause is fine - but in the UI layer it is always the display path, and
     * the UI layer is where it was wrong eighteen times.
     */
    const offenders: string[] = []
    for (const file of tsxFiles(join('src', 'ui'))) {
      const source = readFileSync(file, 'utf8')
      const matches = source.match(/instanceof Error \? \w+\.message/g) ?? []
      if (matches.length > 0) offenders.push(`${file} (${matches.length})`)
    }
    expect(offenders, `raw error text reaches the user in: ${offenders.join(', ')}`).toEqual([])
  })

  it('routes failures through the helper instead', () => {
    // The inverse assertion, so the scan above cannot be satisfied by simply
    // deleting the error handling entirely.
    let uses = 0
    for (const file of tsxFiles(join('src', 'ui'))) {
      uses += (readFileSync(file, 'utf8').match(/humanMessage\(/g) ?? []).length
    }
    expect(uses).toBeGreaterThanOrEqual(15)
  })

  it('still gives every one of them a written sentence', () => {
    /*
     * The messages were always the good part; they were simply not reached.
     * This checks none of them is empty or a placeholder.
     */
    for (const file of tsxFiles(join('src', 'ui'))) {
      const source = readFileSync(file, 'utf8')
      for (const call of source.match(/humanMessage\([^,]+,\s*('[^']*'|"[^"]*")/g) ?? []) {
        const message = call.slice(call.indexOf(',') + 1).trim().slice(1, -1)
        expect(message.length, `empty message in ${file}`).toBeGreaterThan(8)
        expect(message, `placeholder message in ${file}`).not.toMatch(/^(error|failed|oops)\.?$/i)
      }
    }
  })
})
