import { createRoot } from 'react-dom/client'
import { KickbackPanel } from '../ui/KickbackPanel'
import { ErrorBoundary } from '../ui/ErrorBoundary'
import { createPortClient } from '../client/port'
import type { KickbackClient } from '../client/types'
import { watchTopOffset } from '../platforms/twitch/anchor'
import { measureChatRail } from '../platforms/twitch/chatRail'
import { watchChannel, watchTitle } from '../platforms/twitch/navigation'
import { getCurrentChannel } from '../platforms/twitch/channels'
import { channelNameFromTitle } from '../core/channelNames'
import panelStyles from '../ui/kickback.css?inline'

/**
 * Kickback's entry point on Twitch.
 *
 * Everything Kickback renders lives inside a single host element with its own
 * shadow root, appended to <body>. Twitch's own React tree is never touched, so
 * there is nothing here that can break the site, and our CSS cannot leak out.
 */

const HOST_ID = 'kickback-host'

/**
 * Build-time constant, so `IS_DEMO` folds to `false` in a production build and
 * the dynamic import below - along with all of src/mock - is dropped from the
 * bundle entirely. tests/extension/bundle.test.ts asserts that.
 */
const IS_DEMO = import.meta.env.VITE_KICKBACK_MODE === 'demo'

async function createClient(): Promise<KickbackClient> {
  if (IS_DEMO) {
    const { createDemoClient } = await import('../client/demo')
    return createDemoClient()
  }
  return createPortClient()
}

function createHost(): HTMLDivElement {
  const host = document.createElement('div')
  host.id = HOST_ID
  // A transparent layer over the whole viewport. It ignores pointer events
  // entirely - only the panel inside it accepts them - so Twitch behaves
  // exactly as if Kickback were not here, while the panel is free to be
  // dragged anywhere rather than being pinned to one edge.
  host.style.cssText = [
    'position:fixed',
    'inset:0',
    'overflow:visible',
    'pointer-events:none',
    'z-index:2147483000',
  ].join(';')
  return host
}

async function mount(): Promise<void> {
  if (document.getElementById(HOST_ID)) return

  const host = createHost()
  const shadow = host.attachShadow({ mode: 'open' })

  const style = document.createElement('style')
  style.textContent = panelStyles

  const container = document.createElement('div')
  container.className = 'kb-root'

  shadow.append(style, container)
  document.body.appendChild(host)

  const client = await createClient()

  const root = createRoot(container)
  const render = (topOffset: number, reservedRight: number) =>
    root.render(
      <ErrorBoundary>
        <KickbackPanel client={client} topOffset={topOffset} reservedRight={reservedRight} />
      </ErrorBoundary>,
    )

  // Twitch's nav can move and its chat rail can be collapsed, so both are
  // measured rather than assumed. They only feed the *default* placement:
  // once the user has moved the panel, their choice wins.
  let topOffset = 58
  let reservedRight = measureChatRail()
  render(topOffset, reservedRight)

  watchTopOffset((topPx) => {
    topOffset = topPx
    reservedRight = measureChatRail()
    render(topOffset, reservedRight)
  })

  reportActivity(client)
  keepAttached(host)
  hideDuringFullscreen(host)
}

/**
 * Tells the service worker what this tab is showing.
 *
 * Visibility matters as much as the channel: with several Twitch tabs open,
 * the worker needs to know which one the user is actually looking at, or a
 * background tab would decide what your friends see. The worker owns that
 * rule - this only reports the facts.
 */
function reportActivity(client: KickbackClient): void {
  /** The casing we last managed to report, so a title tick is not a resend. */
  let reportedName: string | null = null

  const nameFor = (channel: string | null) =>
    // Twitch spells the channel properly in the page title, which is the one
    // place its own casing is available without touching its markup.
    channel ? channelNameFromTitle(document.title, channel) : null

  const send = () => {
    const channel = getCurrentChannel()
    reportedName = nameFor(channel)
    client.reportActivity(channel, !document.hidden, reportedName)
  }

  // On connect, on navigation, and whenever this tab is shown or hidden.
  send()
  watchChannel(send)
  document.addEventListener('visibilitychange', send)
  window.addEventListener('pageshow', send)

  /*
   * And again when the title catches up.
   *
   * Twitch changes the URL first and the title a beat later, so the send above
   * runs while the title still names the PREVIOUS channel - which reads as
   * "no casing available" and leaves the channel to be displayed as its bare
   * login forever. This is the only moment the real casing exists.
   *
   * Guarded on the resolved name rather than on the title, so an unrelated
   * title change - a stream renaming itself, an unread badge appearing - costs
   * nothing.
   */
  watchTitle(() => {
    if (nameFor(getCurrentChannel()) === reportedName) return
    send()
  })
}

/**
 * Twitch re-renders large parts of the page. It should never touch a node it
 * does not own, but if our host ever disappears we simply put it back rather
 * than leaving the user without Kickback until a reload.
 */
function keepAttached(host: HTMLDivElement): void {
  const observer = new MutationObserver(() => {
    if (!host.isConnected && document.body) {
      document.body.appendChild(host)
    }
  })
  observer.observe(document.body, { childList: true })
}

/** Stay out of the way when Twitch goes fullscreen. */
function hideDuringFullscreen(host: HTMLDivElement): void {
  const sync = () => {
    host.style.display = document.fullscreenElement ? 'none' : ''
  }
  document.addEventListener('fullscreenchange', sync)
  sync()
}

function boot(): void {
  mount().catch((error) => {
    console.error('[Kickback] failed to start', error)
  })
}

if (document.body) {
  boot()
} else {
  document.addEventListener('DOMContentLoaded', boot, { once: true })
}
