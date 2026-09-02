/**
 * A very small Chrome DevTools Protocol driver.
 *
 * Watchside lives inside a real page, so some questions can only be answered by
 * a real browser: where Twitch actually puts its chat rail, whether a drag
 * really moves the panel, whether a saved position really survives a reload.
 * This is the harness for those questions.
 *
 * Zero dependencies - Node has a WebSocket client built in, and CDP is just
 * JSON over one socket. It launches Edge rather than Chrome because branded
 * Chrome 137+ refuses --load-extension.
 *
 * Not part of `npm test`: it needs a browser and a network, and it is a
 * development tool rather than a gate.
 *
 *   node scripts/cdp.mjs <scenario.mjs> [--headful] [--extension <dir>]
 *
 * A scenario module default-exports `async ({ page, browser, log }) => {}`.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const EDGE_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/microsoft-edge',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
]

function findBrowser() {
  const found = EDGE_CANDIDATES.find((path) => existsSync(path))
  if (!found) throw new Error('No Microsoft Edge found - install it or edit EDGE_CANDIDATES')
  return found
}

async function waitForDevtools(port, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (response.ok) return await response.json()
    } catch {
      // Not up yet.
    }
    if (Date.now() > deadline) throw new Error('Browser devtools endpoint never came up')
    await new Promise((r) => setTimeout(r, 150))
  }
}

/** One CDP session over one WebSocket. */
function connect(wsUrl) {
  const socket = new WebSocket(wsUrl)
  const pending = new Map()
  const listeners = new Map()
  let nextId = 0

  const ready = new Promise((resolveReady, rejectReady) => {
    socket.addEventListener('open', () => resolveReady())
    socket.addEventListener('error', (event) => rejectReady(new Error(`socket error: ${event}`)))
  })

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.id !== undefined) {
      const slot = pending.get(message.id)
      if (!slot) return
      pending.delete(message.id)
      if (message.error) slot.reject(new Error(`${message.error.message} (${message.method})`))
      else slot.resolve(message.result)
      return
    }
    for (const listener of listeners.get(message.method) ?? []) listener(message.params)
  })

  return {
    ready,
    send(method, params = {}, sessionId) {
      const id = ++nextId
      return new Promise((resolveSend, rejectSend) => {
        pending.set(id, { resolve: resolveSend, reject: rejectSend, method })
        socket.send(JSON.stringify({ id, method, params, sessionId }))
      })
    },
    on(method, listener) {
      if (!listeners.has(method)) listeners.set(method, [])
      listeners.get(method).push(listener)
    },
    close: () => socket.close(),
  }
}

export async function launch({ extension = null, headful = false, width = 1600, height = 900 } = {}) {
  const port = 9200 + Number(process.hrtime.bigint() % 300n)
  const profile = mkdtempSync(join(tmpdir(), 'kickback-cdp-'))

  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,MediaRouter',

    /*
     * SILENCE, and not as an option.
     *
     * Every browser this launches goes to twitch.tv, where a live stream starts
     * playing the moment the page settles. A headless browser is still a real
     * browser: --headless=new renders and plays audio exactly like a visible
     * one, so a Store-asset capture run filled the room with whatever three
     * streams happened to be on.
     *
     * --mute-audio is the right mechanism rather than blocking autoplay,
     * because the screenshot needs the video to actually be playing - a paused
     * player with a play button over it is not what the product looks like.
     * The stream runs; nothing comes out of the speakers.
     *
     * Deliberately NOT a parameter. There is no automation in this repository
     * that should make noise, and an option is a thing somebody forgets to
     * pass. tests/extension/captureAudio.test.ts asserts it stays here.
     */
    '--mute-audio',
    `--window-size=${width},${height}`,
    'about:blank',
  ]
  if (!headful) args.unshift('--headless=new')
  if (extension) {
    const dir = resolve(extension)
    args.unshift(`--load-extension=${dir}`, `--disable-extensions-except=${dir}`)
  }

  const child = spawn(findBrowser(), args, { stdio: 'ignore' })
  const version = await waitForDevtools(port)
  const cdp = connect(version.webSocketDebuggerUrl)
  await cdp.ready

  const browser = {
    cdp,
    port,
    async newPage(url) {
      const { targetId } = await cdp.send('Target.createTarget', { url: url ?? 'about:blank' })
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
      await cdp.send('Page.enable', {}, sessionId)
      await cdp.send('Runtime.enable', {}, sessionId)
      return makePage(cdp, sessionId, targetId)
    },
    async close() {
      try {
        cdp.close()
        child.kill()
      } finally {
        // A locked profile directory is not worth failing the run over.
        try {
          rmSync(profile, { recursive: true, force: true })
        } catch {
          /* ignore */
        }
      }
    },
  }
  return browser
}

function makePage(cdp, sessionId, targetId) {
  const send = (method, params) => cdp.send(method, params, sessionId)

  return {
    sessionId,
    targetId,
    send,

    async goto(url, { waitMs = 0 } = {}) {
      await send('Page.navigate', { url })
      await this.waitForLoad()
      if (waitMs) await new Promise((r) => setTimeout(r, waitMs))
    },

    waitForLoad(timeoutMs = 30_000) {
      return new Promise((resolveLoad) => {
        const timer = setTimeout(resolveLoad, timeoutMs)
        cdp.on('Page.loadEventFired', () => {
          clearTimeout(timer)
          resolveLoad()
        })
      })
    },

    /** Evaluates an expression in the page and returns a structured value. */
    async evaluate(fn, ...args) {
      const expression = `(${fn.toString()})(...${JSON.stringify(args)})`
      const result = await send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      })
      if (result.exceptionDetails) {
        throw new Error(
          result.exceptionDetails.exception?.description ?? result.exceptionDetails.text,
        )
      }
      return result.result.value
    },

    async setViewport(width, height) {
      await send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false,
      })
    },

    async mouse(type, x, y, button = 'left', clickCount = 1) {
      await send('Input.dispatchMouseEvent', {
        type,
        x: Math.round(x),
        y: Math.round(y),
        button,
        buttons: type === 'mouseReleased' ? 0 : 1,
        clickCount,
        pointerType: 'mouse',
      })
    },

    /** A press-move-release gesture, in steps so listeners see real motion. */
    async drag(fromX, fromY, toX, toY, steps = 12) {
      await this.mouse('mousePressed', fromX, fromY)
      for (let step = 1; step <= steps; step += 1) {
        await this.mouse(
          'mouseMoved',
          fromX + ((toX - fromX) * step) / steps,
          fromY + ((toY - fromY) * step) / steps,
        )
      }
      await this.mouse('mouseReleased', toX, toY)
    },

    async screenshot(path) {
      const { data } = await send('Page.captureScreenshot', { format: 'png' })
      const { writeFileSync } = await import('node:fs')
      writeFileSync(path, Buffer.from(data, 'base64'))
      return path
    },
  }
}

// ------------------------------------------------------------------ runner

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  const [, , scenarioPath, ...flags] = process.argv
  if (!scenarioPath) {
    console.error('usage: node scripts/cdp.mjs <scenario.mjs> [--headful] [--extension <dir>]')
    process.exit(2)
  }
  const extensionIndex = flags.indexOf('--extension')
  const browser = await launch({
    headful: flags.includes('--headful'),
    extension: extensionIndex >= 0 ? flags[extensionIndex + 1] : null,
  })
  const scenario = await import(pathToFileURL(resolve(scenarioPath)).href)
  try {
    await scenario.default({ browser, log: (...parts) => console.log(...parts) })
  } finally {
    await browser.close()
  }
}
