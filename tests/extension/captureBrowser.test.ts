import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * Captures are taken in a browser Watchside actually ships on.
 *
 * WHY THIS IS A TEST AND NOT A CONVENTION
 *
 * The harness used to launch Microsoft Edge, and the reason was purely
 * mechanical: branded Chrome dropped the --load-extension switch in M137, Edge
 * was the Chromium on the machine that still honoured it, and "it works" won.
 * Nobody decided that marketing screenshots of a Chrome/Firefox product should
 * be photographed in Edge - it leaked in through a workaround and then every
 * capture script inherited it by reusing the driver.
 *
 * That is exactly the kind of decision that gets remade by accident. The next
 * person to hit "no browser found" on a fresh machine will reach for whatever
 * is installed, and the fastest fix is always the wrong one. So the constraint
 * is asserted rather than written down: the harness resolves Chrome for Testing
 * and nothing else, and it fails loudly with the install command instead of
 * falling back.
 *
 * Firefox is the other supported target and is deliberately not driven here -
 * it speaks WebDriver BiDi rather than CDP, so it needs its own harness
 * (web-ext, already a devDependency) rather than another path in this one.
 */

const CDP = readFileSync('scripts/cdp.mjs', 'utf8')

/** The file with its comments removed, so prose about Edge cannot pass or fail. */
const CODE = CDP.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

describe('the capture harness launches a supported browser', () => {
  it('never launches Edge', () => {
    expect(CODE).not.toMatch(/msedge|microsoft-edge|Microsoft Edge/i)
  })

  it('resolves Chrome for Testing', () => {
    expect(CODE).toContain('chrome-win64')
    expect(CODE).toContain('chrome-linux64')
  })

  it('tells you how to get it rather than substituting something else', () => {
    /*
     * The failure path is the whole point. A fallback to "whatever is
     * installed" is how Edge got here, and on this machine that fallback would
     * silently pick a branded Chrome that cannot load an unpacked extension at
     * all - a harder failure to read than a missing binary.
     */
    expect(CODE).toContain('@puppeteer/browsers install chrome@stable')
    expect(CODE).toMatch(/throw new Error\(/)
  })

  it('keeps every profile off the machine owner’s real browser', () => {
    /*
     * --user-data-dir is unconditional: a throwaway temp directory by default,
     * and a named one only where a human sign-in has to survive between runs.
     * Neither is a real profile, and there is no path that omits the flag.
     */
    const args = CODE.slice(CODE.indexOf('const args = ['), CODE.indexOf('about:blank'))
    expect(args).toContain('--user-data-dir=')
  })

  it('is headless unless a caller asks otherwise', () => {
    // Headed mode is an opt-in for the one step that needs a person in front
    // of it. Everything else - rendering, capture, verification - is headless.
    expect(CODE).toContain('headful = false')
    expect(CODE).toContain("if (!headful) args.unshift('--headless=new')")
  })
})
