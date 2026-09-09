/**
 * Current Twitch metadata, through Watchside's own production path.
 *
 *   npm run metadata:harvest -- --channels a,b,c,d,e
 *
 * WHY THIS EXISTS RATHER THAN A DIRECT HELIX CALL
 *
 * The marketing capture has to show the enrichment the product actually
 * displays, and the demo build has no backend, so it has no metadata. The
 * obvious fix - give the capture script a Twitch client id and secret and call
 * Helix itself - was rejected on purpose: the tooling would then possess a
 * production credential it does not need, and the records would come from a
 * second path that could drift from the one users get.
 *
 * So this uses the path that already exists. A real signed-in Watchside client
 * fetches public metadata for every Twitch destination it has open - see
 * `metadata.want(channels)` in src/background/index.ts, which pushes
 * `tabActivity.destinations()` unconditionally, friends or no friends. That
 * request goes to the JWT-verified `twitch-metadata` Edge Function, which holds
 * the Twitch secret server-side, calls Helix, writes the shared cache and
 * returns the records. This script drives exactly that, by opening tabs.
 *
 * WHAT THIS IS NOT
 *
 * It is not a bypass and it does not weaken anything. There is no capture-only
 * endpoint, no service-role key, no anon call to a function that wants a user,
 * and no change to any shipped code - the extension it loads is an ordinary
 * production build of the current source, behaving exactly as it does for any
 * user. The one privileged act is a HUMAN signing in through the normal Twitch
 * OAuth screen, which is what "a legitimate Watchside client" means.
 *
 * WHAT IT READS, AND WHAT IT REFUSES TO READ
 *
 * One key: `kickback:channelMetadata`, the extension's own cache of PUBLIC
 * Twitch channel facts - display casing, avatar URL, live state, category,
 * title, viewer count. Nothing else is read out of the profile. The Supabase
 * session is checked for EXISTENCE ONLY, as a boolean, so the script can tell
 * "not signed in yet" from "signed in and still fetching"; its value is never
 * read, never printed and never written anywhere.
 *
 * WHAT IT COSTS, STATED PLAINLY
 *
 * A real sign-in writes what a real sign-in always writes: a presence row and
 * ordinary analytics events for THAT owner's own account, and one
 * `twitch_metadata_cache` upsert per channel. That is the function's normal
 * behaviour under normal use. No account is created, no other user's data is
 * touched, no schema changes, and nothing is written that browsing Twitch with
 * Watchside installed would not have written anyway.
 */
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { launch } from './cdp.mjs'

/** Where the records land, for `npm run capture:marketing` to pick up. */
export const HARVEST_FILE = '.metadata-harvest.json'

/** The extension's own cache key. The only key this script ever reads. */
const METADATA_KEY = 'kickback:channelMetadata'

/** The kept browser profile, so one sign-in serves every run. Gitignored. */
const PROFILE_DIR = '.harvest-profile'

const argv = process.argv.slice(2)
const flag = (name) => {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 ? argv[index + 1] : undefined
}
const has = (name) => argv.includes(`--${name}`)

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * How many channels may be open at once.
 *
 * MAX_DESTINATIONS in src/background/activity.ts is 3, and `destinations()`
 * caps at it - so a fourth tab is simply not in the set the worker asks about.
 * Harvesting in threes is working WITH that rule rather than around it.
 */
const MAX_OPEN = 3

// ------------------------------------------------------- worker-side probes

/*
 * Evaluated inside the extension's service worker, where `chrome` exists.
 * Each is self-contained: nothing from this file exists on the other side.
 */

/** Whether a Supabase session exists. A BOOLEAN. The token is never read. */
function probeSignedIn() {
  return new Promise((resolve) => {
    chrome.storage.local.get(null, (all) => {
      const keys = Object.keys(all ?? {})
      resolve(keys.some((key) => /^sb-.*-auth-token$/.test(key)))
    })
  })
}

/** The extension's cache of public Twitch channel facts. */
function probeMetadata(key) {
  return new Promise((resolve) => {
    chrome.storage.local.get(key, (all) => {
      const value = all?.[key]
      resolve(value && typeof value === 'object' ? value : {})
    })
  })
}

// -------------------------------------------------------------------- main

async function main() {
  const channels = (flag('channels') ?? '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)

  if (channels.length === 0) {
    console.error('\n  usage: npm run metadata:harvest -- --channels a,b,c,d,e\n')
    return 2
  }

  if (!has('no-build') || !existsSync('dist')) {
    console.log('== Building the production extension (current source)')
    execFileSync('npm', ['run', 'build'], {
      stdio: 'inherit',
      shell: process.platform === 'win32',
    })
  }

  /*
   * A KEPT profile, so the sign-in is asked for once and not once per attempt.
   *
   * It holds a real Watchside session, on the owner's own machine, exactly as
   * their ordinary browser profile does. Gitignored. `--fresh` deletes it, and
   * so does deleting the directory by hand.
   */
  if (has('fresh')) rmSync(PROFILE_DIR, { recursive: true, force: true })

  /*
   * HEADLESS FIRST, HEADED ONLY IF A PERSON IS ACTUALLY NEEDED.
   *
   * One step of this script genuinely requires a human: completing Twitch's
   * OAuth screen. There is no legitimate headless way to become a signed-in
   * client, and becoming one is the entire point - the metadata is fetched by a
   * real session through the JWT-verified Edge Function, exactly as ordinary
   * use does.
   *
   * But that is the FIRST run only. The kept profile holds the session
   * afterwards, so every later run can do the whole job with no window at all,
   * and opening one anyway would be a visible browser on the machine for no
   * reason. So: start headless, ask the worker whether a session already
   * exists, and open a window only if the answer is no.
   *
   * `--headed` forces the window for somebody who wants to watch it work.
   */
  let browser = await launch({
    extension: 'dist',
    headful: has('headed'),
    width: 1400,
    height: 900,
    profileDir: PROFILE_DIR,
  })

  /**
   * A Twitch tab, the worker it wakes, and whether a session is already there.
   *
   * Everything here is per-browser, so re-running it after a relaunch is how
   * the headed retry gets its own worker rather than a stale handle.
   */
  async function connect() {
    // A Twitch tab wakes the worker: the content script connects to it.
    const first = await browser.newPage()
    await first.goto('https://www.twitch.tv/', { waitMs: 4_000 })

    /*
     * OUR worker, named exactly.
     *
     * The first version matched any `chrome-extension://` service worker, which
     * is wrong twice: a browser may carry extensions of its own, so the first
     * match could easily be one of those, and a wrong attach fails later and
     * further away. The background script's filename comes from the manifest
     * and is ours.
     *
     * It also needs longer than it looks. Measured on this machine, the
     * Watchside worker appears roughly twelve seconds after the Twitch tab
     * starts loading - the content script has to connect before Chrome starts
     * the worker at all - so a short timeout reports "no extension" for what is
     * really "not yet".
     */
    const attached = await browser.attach(
      (target) =>
        target.type === 'service_worker' && target.url.endsWith('/kickback-background.js'),
      { timeoutMs: 90_000 },
    )
    return attached
  }

  try {
    let worker = await connect()
    if (!worker) {
      console.error('\n  Could not attach to the Watchside service worker. Targets seen:\n')
      for (const target of await browser.targets()) {
        console.error(`   ${String(target.type).padEnd(16)} ${String(target.url).slice(0, 100)}`)
      }
      console.error('')
      return 3
    }
    console.log(`== Attached to ${worker.info.url}`)

    if (!(await worker.evaluate(probeSignedIn))) {
      /*
       * No session, so a person is needed - and only now does a window open.
       * The headless browser is closed first rather than left behind: two
       * browsers on one kept profile would fight over the same profile lock.
       */
      if (!has('headed')) {
        console.log('== No session in the kept profile; opening a window for sign-in')
        await browser.close()
        browser = await launch({
          extension: 'dist',
          headful: true,
          width: 1400,
          height: 900,
          profileDir: PROFILE_DIR,
        })
        worker = await connect()
        if (!worker) {
          console.error('\n  Could not attach after reopening for sign-in.\n')
          return 3
        }
      }

      console.log(`
== SIGN IN, please.

   A browser window is open on twitch.tv with Watchside loaded. Open the
   Watchside panel and sign in with Twitch as you normally would.

   This is the only step that needs a person, and it is the step that makes
   the metadata request a legitimate one. Nothing is read from your session -
   the script only checks that one exists. The window closes when the harvest
   finishes, and later runs will not need to open one.
`)

      /*
       * Long enough that the person can arrive.
       *
       * Five minutes assumed somebody was watching the terminal when the window
       * opened, which is the one thing a script that just asked for a human
       * cannot assume. The cost of waiting is an idle browser; the cost of
       * timing out is the whole run, and this run's output goes stale in
       * thirty minutes, so it has to be re-done rather than resumed.
       */
      const signInDeadline = Date.now() + 15 * 60_000
      while (!(await worker.evaluate(probeSignedIn))) {
        if (Date.now() > signInDeadline) {
          console.error('\n  Timed out waiting for sign-in.\n')
          return 4
        }
        await wait(2_000)
      }
    }
    console.log('== Signed in')

    /*
     * Open the channels, in threes, and let the worker do what it always does.
     *
     * Nothing is asked of the extension here. Tabs are opened; the presence
     * heartbeat notices the destinations, `metadata.want` finds no record for
     * them, and the Edge Function is called. Polling the cache is how the
     * script learns it happened.
     */
    const collected = new Map()

    for (let index = 0; index < channels.length; index += MAX_OPEN) {
      const batch = channels.slice(index, index + MAX_OPEN)
      console.log(`\n== Opening ${batch.join(', ')}`)

      const pages = []
      for (const channel of batch) {
        const page = await browser.newPage()
        await page.goto(`https://www.twitch.tv/${channel}`, { waitMs: 1_000 })
        pages.push(page)
      }

      const deadline = Date.now() + 90_000
      for (;;) {
        const records = await worker.evaluate(probeMetadata, METADATA_KEY)
        for (const [login, record] of Object.entries(records ?? {})) {
          if (record && typeof record === 'object') collected.set(login, record)
        }
        if (batch.every((channel) => collected.has(channel))) break
        if (Date.now() > deadline) {
          console.log(`   timed out waiting for ${batch.filter((c) => !collected.has(c)).join(', ')}`)
          break
        }
        await wait(3_000)
      }

      for (const channel of batch) {
        const record = collected.get(channel)
        console.log(
          record
            ? `   ${channel.padEnd(18)} ${String(record.live).padEnd(7)}` +
                ` ${record.viewerCount ?? '-'} viewers  ${record.gameName ?? ''}`
            : `   ${channel.padEnd(18)} (no record)`,
        )
      }

      // Closed before the next batch, so the three-destination cap applies to
      // the batch we are actually waiting on rather than to a growing pile.
      for (const page of pages) await page.close()
    }

    const records = channels.map((channel) => collected.get(channel)).filter(Boolean)
    if (records.length === 0) {
      console.error('\n  No metadata was returned. Is the Edge Function deployed?\n')
      return 5
    }

    writeFileSync(
      HARVEST_FILE,
      `${JSON.stringify({ harvestedAt: Date.now(), records }, null, 2)}\n`,
    )
    console.log(`\n== Wrote ${records.length} records to ${HARVEST_FILE}`)
    console.log('   Now run:  npm run capture:marketing')
    return 0
  } finally {
    await browser.close()
  }
}

/*
 * Only when RUN, never when imported.
 *
 * `marketing-capture.mjs` imports HARVEST_FILE from here so the two cannot
 * disagree about the filename. Without this guard that import would launch a
 * browser and print a usage message - which is exactly what it did the first
 * time, and the same convention scripts/cdp.mjs already uses.
 */
const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (isMain) process.exitCode = await main()
