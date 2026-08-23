import { getCurrentChannel } from './channels'

/**
 * Twitch is a single page app and the router lives in the page's JS world, so a
 * content script cannot patch `history.pushState` to observe it. Instead we
 * watch the things that *are* shared with us: the URL (polled cheaply), the
 * `popstate` event, and `<title>` mutations, which Twitch updates on every
 * channel change and which usually beats the poll.
 */

const POLL_INTERVAL_MS = 400

export type ChannelListener = (channel: string | null) => void

/**
 * Subscribe to the channel the local user is currently viewing. The listener is
 * invoked immediately with the current value and then on every change.
 */
export function watchChannel(listener: ChannelListener): () => void {
  let current = getCurrentChannel()
  listener(current)

  const check = () => {
    const next = getCurrentChannel()
    if (next !== current) {
      current = next
      listener(current)
    }
  }

  const interval = window.setInterval(check, POLL_INTERVAL_MS)
  window.addEventListener('popstate', check)
  window.addEventListener('hashchange', check)

  const titleEl = document.querySelector('title')
  const titleObserver = titleEl ? new MutationObserver(check) : null
  titleObserver?.observe(titleEl as Node, { childList: true, characterData: true, subtree: true })

  return () => {
    window.clearInterval(interval)
    window.removeEventListener('popstate', check)
    window.removeEventListener('hashchange', check)
    titleObserver?.disconnect()
  }
}
