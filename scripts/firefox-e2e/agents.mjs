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

const countPer = (map) =>
  map && typeof map === 'object'
    ? Object.fromEntries(
        Object.entries(map).map(([channel, list]) => [
          channel,
          Array.isArray(list) ? list.length : 0,
        ]),
      )
    : null

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
      /*
       * The two answers to "who is in this room", as COUNTS.
       *
       * roomPeers is derived from presence; roomMembers is the server's
       * membership answer. They are supposed to agree, and the only way to
       * see them disagree is to record both. Counts, not ids - the harness
       * has no business carrying other people's identifiers around.
       */
      roomPeers: countPer(s.roomPeers),
      roomMembers: countPer(s.roomMembers),
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

  /*
   * Is this browser logged in to twitch.tv?
   *
   * Answered from the DOM - the logged-in avatar button versus the log-in
   * button - NOT from cookies. Watchside does not need a Twitch website
   * session to work; it needs one only for the one-time OAuth hop. This
   * command exists to prove that distinction rather than assume it.
   */
  twitchLogin: () => {
    const avatar =
      document.querySelector('[data-a-target="user-menu-toggle"]') ||
      document.querySelector('button[data-a-target="user-menu-toggle"]')
    const loginButton = document.querySelector('[data-a-target="login-button"]')
    const signupButton = document.querySelector('[data-a-target="signup-button"]')
    return {
      loggedIn: Boolean(avatar),
      loginButtonPresent: Boolean(loginButton || signupButton),
      url: location.pathname,
    }
  },

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

  /*
   * The panel as a structured snapshot, read from the RENDERED DOM.
   *
   * The social assertions could be made against the state broadcast instead,
   * and they would be easier - but a state field says the client believes
   * something, while a card in the shadow root says the owner would have SEEN
   * it. Gravity, JOIN and the room are all claims about what is on screen, so
   * that is where they are checked.
   */
  panel: () => {
    const root = shadow()
    if (!root) return { present: false }
    const text = (el) => (el ? el.textContent.trim() : null)

    const session = root.querySelector('.kb-session')

    return {
      present: true,
      collapsed: Boolean(root.querySelector('.kb-launcher')),
      tabs: [...root.querySelectorAll('.kb-tab')].map((t) => ({
        label: text(t),
        active: t.classList.contains('kb-tab-active'),
        session: t.classList.contains('kb-tab-session'),
      })),
      // Friend rows, with the HERE badge. This is the presence-derived view of
      // who is co-present, which is a DIFFERENT path from the room roster -
      // and being able to compare the two is what tells a slow server answer
      // apart from a client that never noticed the arrival.
      rows: [...root.querySelectorAll('.kb-row')].map((r) => ({
        name: text(r.querySelector('.kb-row-name')),
        status: text(r.querySelector('.kb-row-status')),
        here: Boolean(r.querySelector('.kb-badge-here')),
      })),
      cards: [...root.querySelectorAll('.kb-gravity-card')].map((card) => ({
        channel: text(card.querySelector('.kb-gravity-channel')),
        count: text(card.querySelector('.kb-gravity-count')),
        heavy: card.classList.contains('kb-gravity-card-strong'),
        here: card.classList.contains('kb-gravity-card-here'),
        join: Boolean(card.querySelector('button.kb-join')),
      })),
      session: session
        ? {
            channel: text(session.querySelector('.kb-session-channel')),
            count: text(session.querySelector('.kb-session-count')),
            // The roster is behind a tap, so report whether it is open as well
            // as what it says - an empty list means "closed", not "nobody".
            roster: Boolean(session.querySelector('.kb-room-people')),
            people: [...session.querySelectorAll('.kb-cluster-name')].map((p) =>
              p.textContent.trim()),
            composer: Boolean(session.querySelector('.kb-composer-input')),
            messages: [...session.querySelectorAll('.kb-msg')].map((m) => ({
              // The name carries the ":" that separates it from the body, so
              // it is trimmed here rather than in every assertion.
              who: (text(m.querySelector('.kb-msg-who')) || '').replace(/:+$/, ''),
              self: Boolean(m.querySelector('.kb-msg-who-self')),
              body: text(m.querySelector('.kb-msg-body')),
            })),
          }
        : null,
    }
  },

  expand: () => {
    const root = shadow()
    const launcher = root && root.querySelector('.kb-launcher')
    if (!launcher) return { expanded: false, reason: 'not collapsed' }
    launcher.click()
    return { expanded: true }
  },

  /* JOIN from the gravity card for a NAMED channel - not "the first JOIN on
   * screen", which would pass while sending the actor somewhere else. */
  join: ({ channel }) => {
    const root = shadow()
    if (!root) return { clicked: false, reason: 'no shadow root' }
    const cards = [...root.querySelectorAll('.kb-gravity-card')]
    const wanted = String(channel).trim().toLowerCase()
    const seen = cards.map((c) => {
      const name = c.querySelector('.kb-gravity-channel')
      return name ? name.textContent.trim() : null
    })
    const index = seen.findIndex((name) => name && name.toLowerCase() === wanted)
    if (index < 0) return { clicked: false, reason: 'no card for ' + channel, seen }
    const button = cards[index].querySelector('button.kb-join')
    if (!button) return { clicked: false, reason: 'card has no JOIN', seen }
    button.click()
    return { clicked: true, channel, label: button.textContent.trim() }
  },

  compose: ({ body, send }) => {
    const root = shadow()
    const input = root && root.querySelector('.kb-composer-input')
    if (!input) return { typed: false, reason: 'no composer' }
    /*
     * A controlled React input ignores a plain .value assignment: React holds
     * the value in state and overwrites the node on the next render, and the
     * SEND button stays disabled because state never changed. Setting through
     * the prototype descriptor React reads, then firing the event it listens
     * for, is what makes this a real keystroke rather than a DOM poke.
     */
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, body)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    if (!send) return { typed: true, sent: false }
    const button = root.querySelector('button.kb-send')
    if (!button) return { typed: true, sent: false, reason: 'no send button' }
    if (button.disabled) return { typed: true, sent: false, reason: 'send disabled' }
    button.click()
    return { typed: true, sent: true }
  },

  resize: () => {
    window.dispatchEvent(new Event('resize'))
    return { dispatched: true }
  },
}

/*
 * The bus RECONNECTS, because on Gecko the other end goes away.
 *
 * The background is an event page, not a service worker: idle for long enough
 * with nothing holding it, it suspends, and every port to it disconnects. A
 * page agent that connected once at load is then unreachable forever, and the
 * harness reports "no page agent on /lirik" - which reads like the tab died
 * when in fact the tab is fine and the worker merely took a nap.
 *
 * That is not hypothetical: it is what a scenario waiting two minutes for a
 * server-side answer does to the OTHER actor, who is sitting idle throughout.
 * Reconnecting re-registers under the same AGENT id, so the harness never
 * notices the gap.
 */
let bus = null

async function run(job) {
  let result, error = null
  try {
    const handler = handlers[job.command]
    if (!handler) throw new Error('unknown command: ' + job.command)
    result = await handler(job.args || {})
  } catch (e) {
    error = String(e && e.message ? e.message : e)
  }
  try {
    bus.postMessage({ jobId: job.jobId, result, error, url: location.pathname })
  } catch { /* the port went away mid-job; the harness will retry */ }
}

function connect() {
  try {
    bus = browser.runtime.connect({ name: '${E2E_PORT_NAME}' })
  } catch (error) {
    errors.push({ connectError: String(error).slice(0, 160) })
    setTimeout(connect, 500)
    return
  }
  bus.postMessage({ register: AGENT, url: location.pathname })
  bus.onMessage.addListener((job) => {
    if (job && job.jobId != null) void run(job)
  })
  bus.onDisconnect.addListener(() => {
    bus = null
    setTimeout(connect, 250)
  })
}

connect()

/* Twitch navigates without reloading, so the agent tells the background where
 * it is now - otherwise the harness would address tabs by a stale URL. */
let lastPath = location.pathname
setInterval(() => {
  if (!bus) return
  if (location.pathname === lastPath) return
  lastPath = location.pathname
  try { bus.postMessage({ url: lastPath }) } catch { /* port closed */ }
}, 400)
`
}
