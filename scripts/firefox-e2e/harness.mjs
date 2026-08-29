/**
 * A real Firefox, running the real packaged extension, driven from Node.
 *
 * WHAT THIS IS NOT
 *
 * Not a browser automation framework. It launches Firefox through `web-ext`,
 * which already installs a temporary add-on over Mozilla's own protocol, and
 * talks to two small agents injected into a scratch copy of the package. Total
 * transport: one HTTP server with three routes. The F5 report explains why that
 * beat writing a second RDP client.
 *
 * PROFILE SAFETY IS STRUCTURAL, NOT A CONVENTION
 *
 * `createProfile()` refuses to run against a directory it did not create. The
 * owner's Firefox profile, the preserved authenticated profile and its backup
 * are unreachable from here by construction rather than by care.
 *
 * NO SLEEPS. Every wait is `waitFor(predicate)` with an explicit timeout and a
 * label that becomes the failure message.
 */
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { backgroundAgent, contentAgent } from './agents.mjs'

const FIREFOX_CANDIDATES = [
  'C:/Program Files/Mozilla Firefox/firefox.exe',
  'C:/Program Files (x86)/Mozilla Firefox/firefox.exe',
  '/usr/bin/firefox',
  '/Applications/Firefox.app/Contents/MacOS/firefox',
]

export const PACKAGE_DIR = join('dist-firefox', 'package')

/** Built from a char code so no editor or shell can mangle it into a literal. */
const NEWLINE = String.fromCharCode(10)

/** Profiles this harness is allowed to touch all live under here. */
const SANDBOX_ROOT = resolve(join('dist-firefox', 'e2e'))

export function findFirefox() {
  const found = FIREFOX_CANDIDATES.find((path) => existsSync(path))
  if (!found) throw new Error('No Firefox found - install it or edit FIREFOX_CANDIDATES')
  return found
}

/**
 * Strict Enhanced Tracking Protection, written as prefs.
 *
 * These are the settings Firefox's own "Strict" category applies. They are
 * TIGHTENED, never loosened: the point is to prove Watchside works under the
 * strictest privacy posture Firefox ships, not to make room for it.
 */
const STRICT_ETP_PREFS = [
  'user_pref("browser.contentblocking.category", "strict");',
  'user_pref("privacy.trackingprotection.enabled", true);',
  'user_pref("privacy.trackingprotection.socialtracking.enabled", true);',
  'user_pref("privacy.trackingprotection.cryptomining.enabled", true);',
  'user_pref("privacy.trackingprotection.fingerprinting.enabled", true);',
  // 5 = dynamic first-party isolation, which is what Strict uses.
  'user_pref("network.cookie.cookieBehavior", 5);',
  'user_pref("privacy.partition.network_state", true);',
]

/**
 * A disposable profile, optionally seeded from an authenticated one.
 *
 * `seed` is copied, never opened in place, so the source cannot be mutated by
 * anything the browser does.
 */
export function createProfile({ name, seed = null, strictEtp = false }) {
  mkdirSync(SANDBOX_ROOT, { recursive: true })
  const dir = join(SANDBOX_ROOT, name)

  if (!resolve(dir).startsWith(SANDBOX_ROOT)) {
    throw new Error(`refusing a profile outside ${SANDBOX_ROOT}: ${dir}`)
  }

  rmSync(dir, { recursive: true, force: true })
  /*
   * A seeded profile is copied; an unseeded one is left ABSENT on purpose.
   * web-ext refuses to start against an empty directory it did not create, so
   * the fresh case hands it a path that does not exist yet and lets it build
   * the profile itself.
   */
  if (seed) {
    if (!existsSync(seed)) throw new Error(`seed profile not found: ${seed}`)
    cpSync(seed, dir, { recursive: true })
    /*
     * A seed captured from a force-killed browser carries its lock files, and
     * Firefox then refuses to start in the copy. Removing them is safe: the
     * copy is brand new and nothing is running in it.
     */
    for (const lock of ['parent.lock', '.parentlock', 'lock']) {
      rmSync(join(dir, lock), { force: true })
    }
  }

  if (strictEtp) {
    mkdirSync(dir, { recursive: true })
    const existing = existsSync(join(dir, 'user.js'))
      ? readFileSync(join(dir, 'user.js'), 'utf8')
      : ''
    writeFileSync(join(dir, 'user.js'), `${existing}\n${STRICT_ETP_PREFS.join('\n')}\n`)
  }
  return dir
}

/** A scratch copy of the real package with the two agents added. */
function instrument({ dir, port }) {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  cpSync(PACKAGE_DIR, dir, { recursive: true })

  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))
  manifest.background.scripts.push('e2e-background.js')
  manifest.content_scripts[0].js.push('e2e-content.js')
  // The agents' only extra reach: a loopback port this harness owns.
  manifest.host_permissions.push(`http://127.0.0.1:${port}/*`)
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)

  writeFileSync(join(dir, 'e2e-background.js'), backgroundAgent(port))
  writeFileSync(join(dir, 'e2e-content.js'), contentAgent())
  return dir
}

/**
 * Bind a channel on the first free port in a range.
 *
 * Sequential rather than random so a failure is reproducible, and bounded so a
 * genuinely exhausted range reports that rather than looping.
 */
async function bindChannel(from, to) {
  for (let port = from; port <= to; port += 1) {
    const channel = createChannel(port)
    try {
      await channel.listening
      return channel
    } catch (error) {
      if (error && error.code !== 'EADDRINUSE') throw error
    }
  }
  throw new Error(`no free port for the E2E channel between ${from} and ${to}`)
}

/** The command channel: agents long-poll, the harness queues and awaits. */
function createChannel(port) {
  const queue = [] // one FIFO; each job names its target
  const pending = new Map() // jobId -> { resolve, reject }
  const agents = new Map() // agent id -> { url, seenAt }
  const boots = []
  let nextJob = 1

  const server = createServer((req, res) => {
    res.setHeader('access-control-allow-origin', '*')
    res.setHeader('access-control-allow-headers', 'content-type')
    if (req.method === 'OPTIONS') return res.end()

    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      let payload = {}
      try {
        payload = body ? JSON.parse(body) : {}
      } catch {
        /* ignore malformed */
      }
      // E2E_DEBUG=1 turns the channel into a transcript. Worth keeping: when
      // the extension goes quiet, the only question is whether it is talking.
      if (process.env.E2E_DEBUG) {
        console.log(`    [channel] ${req.url} ${body.slice(0, 140)}`)
      }
      const reply = (value) => {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(value ?? {}))
      }

      if (req.url === '/boot') {
        boots.push({ ...payload, at: Date.now() })
        if (payload.role === 'page') agents.set(payload.agent, { url: payload.url, seenAt: Date.now() })
        return reply({})
      }

      if (req.url === '/poll') {
        // The background is the only HTTP client, and it reports the page agents
        // it currently holds ports to. Twitch navigates without reloading, so
        // this registry is refreshed on every poll rather than cached.
        agents.clear()
        for (const entry of payload.agents || []) agents.set(entry.id, { url: entry.url, seenAt: Date.now() })
        const job = queue.length ? queue.shift() : null
        return reply(job ? { jobId: job.jobId, target: job.target, command: job.command, args: job.args } : {})
      }

      if (req.url === '/result') {
        const waiter = pending.get(payload.jobId)
        if (waiter) {
          pending.delete(payload.jobId)
          if (payload.error) waiter.reject(new Error(payload.error))
          else waiter.resolve(payload.result)
        }
        return reply({})
      }
      res.statusCode = 404
      res.end()
    })
  })

  const listening = new Promise((ok, fail) => {
    server.once('error', fail)
    server.listen(port, '127.0.0.1', ok)
  })

  function send(target, command, args = {}, { timeout = 20_000 } = {}) {
    const jobId = nextJob++
    queue.push({ jobId, target, command, args })

    return new Promise((ok, fail) => {
      const timer = setTimeout(() => {
        pending.delete(jobId)
        fail(new Error(`timed out after ${timeout}ms: ${target} ${command}`))
      }, timeout)
      pending.set(jobId, {
        resolve: (v) => {
          clearTimeout(timer)
          ok(v)
        },
        reject: (e) => {
          clearTimeout(timer)
          fail(e)
        },
      })
    })
  }

  return {
    listening,
    port: () => server.address().port,
    send,
    agents,
    boots,
    close: () => new Promise((ok) => server.close(ok)),
  }
}

/**
 * Launch a browser, install the instrumented package, and hand back a driver.
 */
export async function launch({
  profile,
  startUrl = 'https://www.twitch.tv/',
  label = 'actor',
  timeoutMs = 60_000,
} = {}) {
  if (!existsSync(PACKAGE_DIR)) {
    throw new Error(`No Firefox package at ${PACKAGE_DIR}. Run: npm run package:firefox`)
  }

  /*
   * Bind first, instrument second.
   *
   * The agents need the port baked into their source, and two actors running
   * at once must not collide - so the OS picks the port (0), we read back what
   * it gave us, and only then write the agent files. Guessing a port and
   * hoping was the earlier design and it is a race with nothing to gain.
   */
  /*
   * A FIXED-RANGE port, probed upward - deliberately not the OS ephemeral
   * range.
   *
   * Letting the OS choose (port 0) looked tidier and broke every launch:
   * web-ext picks Firefox's debugger port from the ephemeral range too, and
   * once our server had taken the number it wanted, Firefox could not bind its
   * listener and web-ext retried ECONNREFUSED 250 times before giving up. The
   * symptom - "timed out waiting for the extension background to boot" - said
   * nothing about ports, which is why it took a manual web-ext run to see it.
   *
   * 8900 upward is outside the dynamic range, and probing means two concurrent
   * actors still never collide with each other.
   */
  const channel = await bindChannel(8900, 8999)
  const port = channel.port()

  const sourceDir = instrument({
    dir: join(SANDBOX_ROOT, `instrumented-${label}`),
    port,
  })

  /*
   * web-ext is run through its own entry point rather than npx, and WITHOUT a
   * shell. On Windows a shell concatenates argv without escaping, so the
   * Firefox path - which contains a space - arrived split in two and web-ext
   * answered "this command does not take any arguments". Spawning node
   * directly keeps every argument intact on every platform.
   */
  const webExtBin = resolve(join('node_modules', 'web-ext', 'bin', 'web-ext.js'))
  const child = spawn(
    process.execPath,
    [
      webExtBin,
      'run',
      '--source-dir', sourceDir,
      '--firefox', findFirefox(),
      '--firefox-profile', profile,
      '--profile-create-if-missing',
      '--keep-profile-changes',
      '--start-url', startUrl,
      '--no-reload',
      '--no-input',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )

  const log = []
  child.stdout.on('data', (d) => log.push(String(d)))
  child.stderr.on('data', (d) => log.push(String(d)))

  const driver = {
    port,
    log,
    channel,

    /** Ask the worker something. */
    bg: (command, args, opts) => channel.send('background', command, args, opts),

    /** Ask a page agent something. `match` is a substring of its URL path. */
    async page(match, command, args, opts) {
      const agent = await driver.agentFor(match)
      return channel.send(agent, command, args, opts)
    },

    /** The most recently seen agent whose URL contains `match`. */
    async agentFor(match, { timeout = 30_000 } = {}) {
      const found = await driver.waitFor(
        () => {
          const entries = [...channel.agents.entries()]
            .filter(([, meta]) => !match || (meta.url || '').includes(match))
            .sort((a, b) => b[1].seenAt - a[1].seenAt)
          return entries.length ? entries[0][0] : null
        },
        { timeout, label: `a page agent on "${match}"` },
      )
      return found
    },

    /**
     * Poll until `probe` returns something truthy, or fail with `label`.
     *
     * The only waiting primitive in the harness. There is no sleep anywhere,
     * so a slow machine waits longer rather than failing, and a broken build
     * fails with a sentence rather than a timeout number.
     */
    async waitFor(probe, { timeout = 30_000, interval = 250, label = 'condition' } = {}) {
      const deadline = Date.now() + timeout
      let lastError = null
      for (;;) {
        try {
          const value = await probe()
          if (value) return value
        } catch (error) {
          lastError = error
        }
        if (Date.now() > deadline) {
          throw new Error(
            `timed out after ${timeout}ms waiting for ${label}` +
              (lastError ? ` (last error: ${lastError.message})` : ''),
          )
        }
        await new Promise((r) => setTimeout(r, interval))
      }
    },

    /**
     * Shut down only what this harness started - identified by PROFILE PATH.
     *
     * Two earlier attempts were wrong in instructive ways. `taskkill /F /IM
     * firefox.exe` killed EVERY Firefox on the machine: the owner's browsing,
     * a second actor mid-run, and any window somebody was signing in to - and
     * a force kill also denies Firefox the chance to flush its profile, so
     * cookies written moments earlier vanish and the next launch looks logged
     * out. Killing our own process TREE then failed the other way: Firefox's
     * launcher exits immediately and the real browser reparents, so the tree
     * no longer contains it and thirty processes leaked into the next scenario.
     *
     * The profile directory is unique per run and lives inside our sandbox, so
     * matching on it selects exactly our browser and nothing else. Ask
     * politely first so the profile is flushed; escalate only for stragglers.
     */
    async close() {
      await channel.close()
      child.kill()

      if (process.platform !== 'win32') {
        await new Promise((r) => setTimeout(r, 1_000))
        return
      }

      /*
       * Matched on the profile DIRECTORY NAME rather than the full path, so
       * forward and back slashes cannot make the comparison miss. The name is
       * unique per scenario and lives only inside our sandbox, so it selects
       * our browser and nothing else.
       */
      const marker = basename(profile)
      const script =
        `Get-CimInstance Win32_Process -Filter "Name='firefox.exe'" | ` +
        `Where-Object { $_.CommandLine -like '*${marker}*' } | ` +
        `ForEach-Object { $_.ProcessId }`

      const pidsMatching = () =>
        new Promise((done) => {
          let out = ''
          const ps = spawn('powershell', ['-NoProfile', '-Command', script], {
            stdio: ['ignore', 'pipe', 'ignore'],
          })
          ps.stdout.on('data', (d) => { out += String(d) })
          ps.on('close', () =>
            done(
              out
                .split(NEWLINE)
                .map((line) => line.trim())
                .filter(Boolean),
            ),
          )
          ps.on('error', () => done([]))
        })

      const ours = await pidsMatching()

      const taskkill = (args) =>
        new Promise((done) => {
          const proc = spawn('taskkill', args, { stdio: 'ignore' })
          proc.on('close', done)
          proc.on('error', done)
        })

      /*
       * FORCE, but only on processes matching our profile.
       *
       * Being polite here was a mistake worth recording: a graceful kill left
       * content processes alive holding the debugger port, and the NEXT launch
       * then failed with ECONNREFUSED. It also bought nothing, because the
       * harness never opens a seed profile - it opens disposable copies, so
       * there is no login here that an unflushed profile could lose. The
       * graceful shutdown that genuinely matters is the owner closing their
       * own authentication window, which this code never touches.
       *
       * What DOES matter is the scoping: matched by profile name, so the
       * owner's browser and any concurrent actor are never in range.
       */
      for (const pid of ours) await taskkill(['/PID', pid, '/T', '/F'])

      // Confirm they are gone rather than assuming, then let the OS settle.
      const deadline = Date.now() + 15_000
      while ((await pidsMatching()).length > 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 250))
      }
      await new Promise((r) => setTimeout(r, 750))
    },
  }

  // The add-on is up when its background agent has said hello.
  try {
    // Only the background posts /boot now; page agents reach us through it.
    await driver.waitFor(() => channel.boots.some((b) => b.boot), {
      timeout: timeoutMs,
      label: 'the extension background to boot',
    })
  } catch (error) {
    // Without this the failure is a bare timeout and the browser's own
    // explanation is thrown away.
    error.diagnostics = {
      webExt: log
        .join('')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(-12),
    }
    await driver.close().catch(() => {})
    throw error
  }

  return driver
}

/**
 * Where an actor's authenticated seed profile lives.
 *
 *   A  WATCHSIDE_E2E_SEED_A  (or the older WATCHSIDE_E2E_SEED_PROFILE)
 *   B  WATCHSIDE_E2E_SEED_B
 *
 * Seeds are authenticated ONCE by the owner and then copied for every run.
 * They are never opened directly, so a test cannot disturb the identity it
 * depends on. Credentials never reach this file: it only ever handles a path.
 */
export function seedProfile(actor) {
  const key = actor === 'B' ? 'WATCHSIDE_E2E_SEED_B' : 'WATCHSIDE_E2E_SEED_A'
  const value =
    process.env[key] ||
    (actor === 'A' ? process.env.WATCHSIDE_E2E_SEED_PROFILE : null) ||
    null
  return { key, path: value, present: Boolean(value && existsSync(value)) }
}

export { SANDBOX_ROOT }
