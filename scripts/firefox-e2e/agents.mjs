/**
 * The two agents the harness injects into a scratch copy of the real package.
 *
 * WHY A FIXED COMMAND VOCABULARY RATHER THAN REMOTE EVAL
 *
 * MV3 extension pages run under `script-src 'self'`, so `eval` and
 * `new Function` are unavailable - a remote-eval driver simply would not work.
 * The constraint turned out to be a favour: a fixed vocabulary is readable and
 * greppable, and each scenario says what it does instead of shipping code
 * strings across a socket.
 *
 * WHY EVERYTHING GOES THROUGH THE BACKGROUND
 *
 * A content script cannot reach the harness directly: Twitch's Content Security
 * Policy blocks a page-context fetch to localhost, which F2 discovered the hard
 * way and this harness rediscovered before the routing was fixed. So the
 * BACKGROUND agent is the only HTTP client. Page agents connect to it over an
 * extension port - the same mechanism the product itself uses - and the
 * background relays jobs out and results back.
 *
 *     harness  <--HTTP-->  background agent  <--port-->  page agent
 *
 * WHY NOT THE REMOTE DEBUGGING PROTOCOL
 *
 * The investigation proposed a `scripts/rdp.mjs` mirroring `scripts/cdp.mjs`.
 * F2-F4 then showed `web-ext run` already installs the add-on over Mozilla's
 * own protocol, and that instrumentation inside the extension observes
 * everything we need - which is where the interesting state lives anyway. A
 * second RDP client would be a protocol to maintain for no capability we lack.
 *
 * NOTHING SENSITIVE CROSSES THIS CHANNEL. Storage is reported by key name and
 * shape, identity by non-secret fields, tokens never.
 */

const E2E_PORT_NAME = 'watchside-e2e'

/** The background agent: HTTP client, command router, and worker informant. */
export function backgroundAgent(port) {
  return `
const BASE = 'http://127.0.0.1:${port}'
const BOOT = 'boot-' + Date.now() + '-' + Math.floor(performance.now() * 1000)
const errors = []

/* Page agents, by id. The port IS the identity, exactly as the product does it. */
const pages = new Map()
const pageWaiters = new Map()
let nextPageJob = 1

self.addEventListener('error', (e) => errors.push({ where: 'background', message: String(e.message) }))
self.addEventListener('unhandledrejection', (e) =>
  errors.push({ where: 'background', rejection: String(e.reason) }))

const post = (path, body) =>
  fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => r.json()).catch(() => null)

browser.runtime.onConnect.addListener((port) => {
  if (port.name !== '${E2E_PORT_NAME}') return
  let id = null
  port.onMessage.addListener((message) => {
    if (!message) return
    if (message.register) {
      id = message.register
      pages.set(id, { port, url: message.url, seenAt: Date.now() })
      return
    }
    if (message.url && id) pages.get(id).url = message.url
    if (message.jobId != null) {
      const waiter = pageWaiters.get(message.jobId)
      if (!waiter) return
      pageWaiters.delete(message.jobId)
      waiter(message)
    }
  })
  port.onDisconnect.addListener(() => {
    if (id) pages.delete(id)
  })
})

function askPage(agentId, command, args) {
  const entry = pages.get(agentId)
  if (!entry) return Promise.reject(new Error('no page agent ' + agentId))
  const jobId = nextPageJob++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pageWaiters.delete(jobId)
      reject(new Error('page agent did not answer ' + command))
    }, 15000)
    pageWaiters.set(jobId, (message) => {
      clearTimeout(timer)
      if (message.error) reject(new Error(message.error))
      else resolve(message.result)
    })
    try {
      entry.port.postMessage({ jobId, command, args })
    } catch (error) {
      clearTimeout(timer)
      pageWaiters.delete(jobId)
      reject(error)
    }
  })
}

/* Storage by SHAPE. A session key and a PKCE verifier look alike and mean
 * opposite things, so they are counted apart and no value is ever read. */
async function storageShape() {
  const all = await browser.storage.local.get(null)
  const keys = Object.keys(all).sort()
  return {
    watchside: keys.filter((k) => k.startsWith('kickback:')),
    sessionPresent: keys.some((k) => /^sb-.*-auth-token$/.test(k)),
    pkceVerifiers: keys.filter((k) => k.includes('code-verifier')).length,
  }
}

function diag(name) {
  const d = globalThis[name]
  if (!d || typeof d.now !== 'function') return { available: false }
  try {
    return { available: true, value: d.now() }
  } catch (error) {
    return { available: false, error: String(error) }
  }
}

const handlers = {
  hello: async () => ({ boot: BOOT, id: browser.runtime.id }),
  errors: async () => ({ errors }),
  storage: async () => storageShape(),
  destinations: async () => diag('kickbackDestinations'),
  gravity: async () => diag('kickbackGravity'),
  diagnosticsAttached: async () => ({
    destinations: typeof globalThis.kickbackDestinations,
    gravity: typeof globalThis.kickbackGravity,
    metadata: typeof globalThis.kickbackMetadata,
  }),

  'tabs.open': async ({ url, active }) => {
    const tab = await browser.tabs.create({ url, active: active !== false })
    return { id: tab.id }
  },
  'tabs.close': async ({ id }) => {
    await browser.tabs.remove(id)
    return { closed: id }
  },
  'tabs.list': async () => {
    const tabs = await browser.tabs.query({})
    return { tabs: tabs.map((t) => ({ id: t.id, url: t.url })) }
  },
  /* Closes Twitch tabs but never the last tab in the window - F4 learned that
   * the hard way, by closing the browser and nearly reading the silence as an
   * event page suspending. */
  'tabs.closeTwitch': async () => {
    const all = await browser.tabs.query({})
    if (!all.some((t) => !/twitch\\.tv/.test(t.url || ''))) {
      await browser.tabs.create({ url: 'about:blank', active: true })
    }
    const twitch = (await browser.tabs.query({})).filter((t) => /twitch\\.tv/.test(t.url || ''))
    for (const t of twitch) await browser.tabs.remove(t.id)
    return { closed: twitch.length }
  },

  'notify.create': async ({ id, options }) => {
    try {
      return { id: await browser.notifications.create(id, options), accepted: true }
    } catch (error) {
      return { accepted: false, error: String(error && error.message ? error.message : error) }
    }
  },
  'notify.clear': async ({ id }) => ({ cleared: await browser.notifications.clear(id) }),

  'perm.contains': async ({ origins }) => ({ has: await browser.permissions.contains({ origins }) }),
  'perm.remove': async ({ origins }) => ({ removed: await browser.permissions.remove({ origins }) }),
  'perm.all': async () => browser.permissions.getAll(),

  /* An alarm is the only thing that can wake a suspended event page on demand. */
  'alarm.create': async ({ name, delayInMinutes }) => {
    browser.alarms.create(name, { delayInMinutes })
    return { created: name }
  },
}

async function pump() {
  for (;;) {
    let job = null
    try {
      job = await post('/poll', {
        boot: BOOT,
        agents: [...pages.entries()].map(([id, meta]) => ({ id, url: meta.url })),
      })
    } catch { /* server gone; retry */ }

    if (!job || !job.command) {
      await new Promise((r) => setTimeout(r, 120))
      continue
    }

    let result, error = null
    try {
      if (job.target && job.target !== 'background') {
        result = await askPage(job.target, job.command, job.args || {})
      } else {
        const handler = handlers[job.command]
        if (!handler) throw new Error('unknown command: ' + job.command)
        result = await handler(job.args || {})
      }
    } catch (e) {
      error = String(e && e.message ? e.message : e)
    }
    await post('/result', { jobId: job.jobId, result, error, boot: BOOT })
  }
}

post('/boot', { boot: BOOT, id: browser.runtime.id })
pump()
`
}

/** The page agent: one per Twitch tab, reachable only through the background. */
export function contentAgent() {
  return `
const AGENT = 'page-' + Date.now() + '-' + Math.floor(Math.random() * 1e6)
const errors = []
const states = []

window.addEventListener('error', (e) => errors.push({ message: String(e.message) }))
window.addEventListener('unhandledrejection', (e) =>
  errors.push({ rejection: String(e.reason).slice(0, 200) }))

/* Observe the product through its OWN protocol: a port named as the panel
 * names it, so the worker broadcasts the same state the panel receives. No
 * credential is in that state. */
try {
  const productPort = browser.runtime.connect({ name: 'kickback' })
  productPort.onMessage.addListener((m) => {
    if (!m || m.type !== 'state') return
    const s = m.state || {}
    states.push({
      at: Date.now(),
      status: s.status,
      here: s.here ?? null,
      signedIn: Boolean(s.identity),
      // Non-secret identity only. These are the fields the panel itself shows;
      // no token, and nothing that could reconstruct one.
      userId: s.identity ? s.identity.userId : null,
      displayName: s.identity ? s.identity.displayName : null,
      twitchLogin: s.identity ? s.identity.twitchLogin : null,
      friendCode: s.identity ? s.identity.friendCode : null,
      friends: Array.isArray(s.friends) ? s.friends.length : null,
      friendLogins: Array.isArray(s.friends)
        ? s.friends.map((f) => (f.user && f.user.username) || null).filter(Boolean).sort()
        : null,
      gravityCount: Array.isArray(s.gravity) ? s.gravity.length : null,
      gravityChannels: Array.isArray(s.gravity)
        ? s.gravity.map((g) => g.channel).filter(Boolean)
        : null,
    })
    if (states.length > 40) states.splice(0, states.length - 40)
  })
} catch (error) {
  errors.push({ portError: String(error) })
}

const shadow = () => {
  const host = document.getElementById('kickback-host')
  return host && host.shadowRoot
}

function rect(el) {
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
}

/* Overlap area, because F4's lesson is to assert RELATIONSHIPS. Absolute
 * coordinates are user state - the panel is draggable - and Twitch's pixels
 * are not ours to pin. */
function overlap(a, b) {
  if (!a || !b) return null
  const x = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x))
  const y = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))
  return x * y
}

const CHAT_SELECTORS = [
  '[data-a-target="chat-scroller"]',
  '[data-test-selector="chat-shell"]',
  '[data-a-target="right-column-chat-bar"]',
]

function findChat() {
  for (const sel of CHAT_SELECTORS) {
    const el = document.querySelector(sel)
    if (el && el.getBoundingClientRect().width > 40) return { el, sel }
  }
  return { el: null, sel: null }
}

const handlers = {
  hello: () => ({ agent: AGENT, url: location.pathname }),

  dom: () => {
    const hosts = document.querySelectorAll('#kickback-host')
    const root = shadow()
    const panel = root && root.querySelector('.kb-panel')
    const chat = findChat()
    const player =
      document.querySelector('[data-a-target="video-player"]') ||
      document.querySelector('.video-player')
    const panelRect = rect(panel)
    return {
      url: location.pathname,
      hostCount: hosts.length,
      panelCount: root ? root.querySelectorAll('.kb-panel').length : 0,
      shadowRoot: Boolean(root),
      styleTags: root ? root.querySelectorAll('style').length : 0,
      panelRect,
      chatSelector: chat.sel,
      chatRect: rect(chat.el),
      overlapChat: overlap(panelRect, rect(chat.el)),
      overlapPlayer: overlap(panelRect, rect(player)),
      viewport: { w: window.innerWidth, h: window.innerHeight },
      inViewport: panelRect
        ? panelRect.x >= -1 && panelRect.y >= -1 &&
          panelRect.x + panelRect.w <= window.innerWidth + 2 &&
          panelRect.y + panelRect.h <= window.innerHeight + 2
        : null,
      panelText: panel ? panel.textContent.slice(0, 240) : null,
    }
  },

  state: () => ({ states: states.slice(-6), errors }),

  localStorage: () => {
    try {
      const probe = 'kickback:e2e:probe'
      window.localStorage.setItem(probe, 'v')
      const back = window.localStorage.getItem(probe)
      window.localStorage.removeItem(probe)
      return {
        writable: back === 'v',
        watchsideKeys: Object.keys(window.localStorage).filter((k) => k.startsWith('kickback')),
      }
    } catch (error) {
      return { writable: false, error: String(error).slice(0, 160) }
    }
  },

  /* Click inside the panel's shadow root, by selector or by visible text. */
  click: ({ selector, text }) => {
    const root = shadow()
    if (!root) return { clicked: false, reason: 'no shadow root' }
    const nodes = [...root.querySelectorAll(selector || 'button')]
    const target = text ? nodes.find((n) => n.textContent.trim().includes(text)) : nodes[0]
    if (!target) return { clicked: false, reason: 'no match' }
    target.click()
    return { clicked: true, label: target.textContent.trim().slice(0, 60) }
  },

  /* Real Twitch SPA navigation: click a link Twitch's own router owns, rather
   * than assigning location, which would be a full reload and would prove
   * nothing about the SPA path. */
  navigate: ({ pattern, exclude }) => {
    const re = new RegExp(pattern)
    const skip = exclude ? new RegExp(exclude) : null
    const links = [...document.querySelectorAll('a[href^="/"]')].filter((a) => {
      const href = a.getAttribute('href') || ''
      if (href === location.pathname) return false
      if (skip && skip.test(href)) return false
      return re.test(href)
    })
    if (!links.length) return { navigated: false, candidates: 0 }
    const href = links[0].getAttribute('href')
    links[0].click()
    return { navigated: true, href }
  },

  /* Twitch's own chat collapse control. Its label varies, so match on role. */
  chatToggle: () => {
    const button =
      document.querySelector('[data-a-target="right-column__toggle-collapse-btn"]') ||
      document.querySelector('button[aria-label*="Collapse"]') ||
      document.querySelector('button[aria-label*="Expand"]')
    if (!button) return { toggled: false, reason: 'no control' }
    button.click()
    return { toggled: true, label: button.getAttribute('aria-label') }
  },

  resize: () => {
    window.dispatchEvent(new Event('resize'))
    return { dispatched: true }
  },
}

const bus = browser.runtime.connect({ name: '${E2E_PORT_NAME}' })
bus.postMessage({ register: AGENT, url: location.pathname })

bus.onMessage.addListener(async (job) => {
  if (!job || job.jobId == null) return
  let result, error = null
  try {
    const handler = handlers[job.command]
    if (!handler) throw new Error('unknown command: ' + job.command)
    result = await handler(job.args || {})
  } catch (e) {
    error = String(e && e.message ? e.message : e)
  }
  bus.postMessage({ jobId: job.jobId, result, error, url: location.pathname })
})

/* Twitch navigates without reloading, so the agent tells the background where
 * it is now - otherwise the harness would address tabs by a stale URL. */
let lastPath = location.pathname
setInterval(() => {
  if (location.pathname === lastPath) return
  lastPath = location.pathname
  try { bus.postMessage({ url: lastPath }) } catch { /* port closed */ }
}, 400)
`
}
