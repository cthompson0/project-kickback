import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * Browser automation does not make noise.
 *
 * WHY THIS IS A TEST AND NOT A CONVENTION
 *
 * Every automated run in this repository that matters goes to twitch.tv, and a
 * live stream starts playing the moment the page settles. A headless browser is
 * still a real browser - `--headless=new` renders and plays audio exactly like a
 * visible one - so a Store-asset capture run played three streams out loud, at
 * whatever the machine's volume happened to be, with no window to mute.
 *
 * The fix is one flag on Chromium and one pref on Firefox. Both are trivial to
 * drop during a refactor and impossible to notice in a diff, and the cost of
 * losing them is paid by whoever is in the room rather than by CI. So they are
 * asserted.
 *
 * MUTING, NOT BLOCKING. Neither mechanism stops playback: the Store screenshots
 * need the player actually playing, because a paused player with a play button
 * over it is not what the product looks like, and the M3D acceptance depends on
 * the real page. Output is silenced; the stream runs.
 */

describe('Chromium automation is muted', () => {
  const CDP = readFileSync('scripts/cdp.mjs', 'utf8')

  it('passes --mute-audio on every launch', () => {
    expect(CDP).toContain("'--mute-audio'")
  })

  it('does not make it an option somebody can forget', () => {
    /*
     * The flag must sit in the unconditional argument list, not behind a
     * parameter. Every caller - screenshots, the Test Lab verifier, chat
     * wrapping, icon and social rendering - inherits it without knowing.
     */
    const args = CDP.slice(CDP.indexOf('const args = ['), CDP.indexOf('about:blank'))
    expect(args, '--mute-audio is not in the unconditional args array').toContain("'--mute-audio'")
    expect(CDP).not.toMatch(/mute\s*[?:=]|muted\s*=/)
  })

  it('still lets the page play, because a paused player is a different picture', () => {
    // Blocking autoplay would silence it too, and would change what the
    // screenshots show. Assert we did not take that shortcut.
    expect(CDP).not.toContain('--autoplay-policy=user-gesture-required')
  })
})

describe('Firefox automation is muted', () => {
  const HARNESS = readFileSync('scripts/firefox-e2e/harness.mjs', 'utf8')

  it('sets media.volume_scale to zero on every profile it builds', () => {
    expect(HARNESS).toContain('media.volume_scale')
    expect(HARNESS).toMatch(/media\.volume_scale"?,\s*"0\.0"/)
  })

  it('applies the quiet prefs wherever the strict prefs are applied', () => {
    /*
     * The two sets travel together. If a future change writes STRICT_ETP_PREFS
     * somewhere new and forgets the quiet ones, that profile is a noisy one.
     */
    const strictUses = HARNESS.match(/STRICT_ETP_PREFS/g) ?? []
    const quietUses = HARNESS.match(/QUIET_PREFS/g) ?? []
    // One declaration each, plus at least one shared application site.
    expect(strictUses.length).toBeGreaterThanOrEqual(2)
    expect(quietUses.length).toBeGreaterThanOrEqual(2)

    const applications = HARNESS.match(/\[\.\.\.STRICT_ETP_PREFS,\s*\.\.\.QUIET_PREFS\]/g) ?? []
    expect(applications.length, 'the strict prefs are written without the quiet ones').toBe(
      strictUses.length - 1,
    )
  })

  it('does not disable media entirely, which would change what is measured', () => {
    expect(HARNESS).not.toContain('media.autoplay.default')
    expect(HARNESS).not.toContain('media.hardware-video-decoding.enabled", false')
  })
})
