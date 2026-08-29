import type {
  BrowserExtensionApi,
  ExtensionAlarms,
  ExtensionIdentity,
  ExtensionNotificationOptions,
  ExtensionNotifications,
  ExtensionPort,
  ExtensionRuntime,
  ExtensionStorageArea,
  ExtensionTabs,
} from './types'

/**
 * The Chromium adapter.
 *
 * This is the engine Watchside shipped on, so this file's only job is to be a
 * FAITHFUL passthrough. Every call here is the call the composition root used
 * to make inline, moved and not otherwise touched: same API, same arguments,
 * same semantics, same order. Chromium behaviour after the abstraction must be
 * indistinguishable from before it, and the way to guarantee that is for this
 * file to add nothing.
 *
 * In particular, notification `buttons` are passed straight through. Chromium
 * supports them, Watchside uses one, and the Gecko adapter's decision to drop
 * them has no business leaking back here.
 *
 * WHY ONE CONST PER NAMESPACE RATHER THAN ONE OBJECT
 *
 * A bundler cannot tree-shake individual properties off an object, so a single
 * exported `api` object would drag `identity`, `notifications`, `alarms` and
 * `tabs` into the CONTENT SCRIPT, which only ever opens a port. Separate
 * exports let each bundle carry exactly the namespaces it calls - verified
 * against the real built output in tests/extension/browserAdapter.test.ts.
 */

export const chromiumStorage: ExtensionStorageArea = {
  get: (keys) => chrome.storage.local.get(keys),
  set: (items) => chrome.storage.local.set(items),
  remove: (keys) => chrome.storage.local.remove(keys),
}

export const chromiumIdentity: ExtensionIdentity = {
  getRedirectURL: () => chrome.identity.getRedirectURL(),
  launchWebAuthFlow: (url) =>
    chrome.identity.launchWebAuthFlow({ url, interactive: true }).then((redirectedTo) => {
      // Chromium resolves with undefined when the user closes the window
      // rather than rejecting, so the "cancelled" case becomes a rejection
      // here - once - instead of at every call site.
      if (!redirectedTo) throw new Error('Sign-in window closed')
      return redirectedTo
    }),
}

export const chromiumNotifications: ExtensionNotifications = {
  // No cast: ExtensionNotificationOptions requires exactly the fields Chromium
  // requires, so the shapes line up and the compiler checks it rather than
  // being told to stop looking.
  create: (id: string, options: ExtensionNotificationOptions) =>
    void chrome.notifications.create(id, options),
  clear: (id) => void chrome.notifications.clear(id),
  onClicked: (handler) => chrome.notifications.onClicked.addListener(handler),
  onButtonClicked: (handler) => chrome.notifications.onButtonClicked.addListener(handler),
}

export const chromiumRuntime: ExtensionRuntime = {
  getURL: (path) => chrome.runtime.getURL(path),
  connect: (name) => chrome.runtime.connect({ name }) as unknown as ExtensionPort,
  onConnect: (handler) =>
    chrome.runtime.onConnect.addListener((port) => handler(port as unknown as ExtensionPort)),
  onStartup: (handler) => chrome.runtime.onStartup.addListener(handler),
  onInstalled: (handler) => chrome.runtime.onInstalled.addListener(handler),
}

export const chromiumAlarms: ExtensionAlarms = {
  create: (name, options) => chrome.alarms.create(name, options),
  // Only the name crosses the boundary; nothing in Watchside reads the rest of
  // the alarm object.
  onAlarm: (handler) => chrome.alarms.onAlarm.addListener((alarm) => handler(alarm.name)),
}

export const chromiumTabs: ExtensionTabs = {
  create: (url) => void chrome.tabs.create({ url }),
}

/**
 * The whole Chromium surface as one object.
 *
 * For tests and for anything that genuinely wants all of it. Production code
 * imports the individual namespaces through ./index.ts so the bundler can drop
 * what a given bundle does not use.
 */
export function createChromiumApi(): BrowserExtensionApi {
  return {
    storage: chromiumStorage,
    identity: chromiumIdentity,
    notifications: chromiumNotifications,
    runtime: chromiumRuntime,
    alarms: chromiumAlarms,
    tabs: chromiumTabs,
  }
}
