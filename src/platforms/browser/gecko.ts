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
 * The Gecko (Firefox) adapter.
 *
 * F1 SCOPE. This establishes the architecture and encodes the engine
 * differences the investigation actually proved
 * (docs/reports/firefox-prepublic-compatibility-2026-08-28.md). It is NOT a
 * claim that Firefox is supported: no Firefox manifest ships, no Firefox
 * redirect URL is registered with Supabase, and none of this has been run
 * against a real Firefox yet. That is F2 onwards.
 *
 * WHY `browser.*` AND NOT `chrome.*`
 *
 * Firefox exposes both, but only `browser.*` is promise-shaped. The `chrome.*`
 * alias is callback-shaped, so `await chrome.storage.local.get(key)` yields
 * `undefined` instead of the stored value - no throw, no warning, nothing a
 * unit test would see. Using `browser.*` here is the entire reason this
 * adapter is not optional.
 */

/**
 * The `browser` global, which TypeScript does not know about because
 * `@types/chrome` describes the other engine.
 *
 * Declared as the narrow set of members this file touches rather than `any`, so
 * a typo is still a compile error. This is the only untyped-global bridge in
 * the codebase, and it is confined to this file on purpose.
 */
declare const browser: {
  storage: {
    local: {
      get(keys: string | string[]): Promise<Record<string, unknown>>
      set(items: Record<string, unknown>): Promise<void>
      remove(keys: string | string[]): Promise<void>
    }
  }
  identity: {
    getRedirectURL(): string
    launchWebAuthFlow(details: { url: string; interactive: boolean }): Promise<string>
  }
  notifications: {
    create(id: string, options: Record<string, unknown>): Promise<string>
    clear(id: string): Promise<boolean>
    onClicked: { addListener(handler: (id: string) => void): void }
  }
  runtime: {
    getURL(path: string): string
    connect(info: { name: string }): ExtensionPort
    onConnect: { addListener(handler: (port: ExtensionPort) => void): void }
    onStartup: { addListener(handler: () => void): void }
    onInstalled: { addListener(handler: () => void): void }
  }
  alarms: {
    create(name: string, options: { periodInMinutes: number }): void
    onAlarm: { addListener(handler: (alarm: { name: string }) => void): void }
  }
  tabs: {
    create(properties: { url: string }): Promise<unknown>
  }
}

/**
 * Reshape a notification for an engine that has no buttons.
 *
 * Firefox supports only `type`, `title`, `message` and `iconUrl`, and it does
 * not IGNORE the extras - passing `buttons` fails schema validation and the
 * whole notification is lost. So they are removed here, at the boundary.
 *
 * This costs nothing in behaviour. src/background/notifier.ts wires the button
 * and the notification body to the identical `open()`, so a Firefox user clicks
 * the notification and lands exactly where a Chromium user who clicked "Join
 * them" lands. What is missing is a label, not a capability - which is why
 * notifier.ts, where the product decisions live, does not change.
 *
 * Built by naming the four survivors rather than deleting the extras, so a
 * field added to ExtensionNotificationOptions later cannot reach Firefox by
 * being forgotten about.
 */
function forGecko(options: ExtensionNotificationOptions): Record<string, unknown> {
  return {
    type: options.type,
    iconUrl: options.iconUrl,
    title: options.title,
    message: options.message,
  }
}

export const geckoStorage: ExtensionStorageArea = {
  get: (keys) => browser.storage.local.get(keys),
  set: (items) => browser.storage.local.set(items),
  remove: (keys) => browser.storage.local.remove(keys),
}

export const geckoIdentity: ExtensionIdentity = {
  getRedirectURL: () => browser.identity.getRedirectURL(),
  launchWebAuthFlow: (url) =>
    // Gecko rejects when the window is closed rather than resolving empty, so
    // unlike Chromium there is nothing to translate. The guard stays anyway:
    // both adapters promise the same contract, and a contract kept by accident
    // is not kept.
    browser.identity.launchWebAuthFlow({ url, interactive: true }).then((redirectedTo) => {
      if (!redirectedTo) throw new Error('Sign-in window closed')
      return redirectedTo
    }),
}

export const geckoNotifications: ExtensionNotifications = {
  create: (id, options) => void browser.notifications.create(id, forGecko(options)),
  clear: (id) => void browser.notifications.clear(id),
  onClicked: (handler) => browser.notifications.onClicked.addListener(handler),
  // Firefox has no notification buttons and therefore no button event.
  // Accepting the handler and never calling it keeps the contract total, so no
  // caller has to know which engine it is on.
  onButtonClicked: () => {},
}

export const geckoRuntime: ExtensionRuntime = {
  getURL: (path) => browser.runtime.getURL(path),
  connect: (name) => browser.runtime.connect({ name }),
  onConnect: (handler) => browser.runtime.onConnect.addListener(handler),
  onStartup: (handler) => browser.runtime.onStartup.addListener(handler),
  onInstalled: (handler) => browser.runtime.onInstalled.addListener(handler),
}

export const geckoAlarms: ExtensionAlarms = {
  create: (name, options) => browser.alarms.create(name, options),
  onAlarm: (handler) => browser.alarms.onAlarm.addListener((alarm) => handler(alarm.name)),
}

export const geckoTabs: ExtensionTabs = {
  create: (url) => void browser.tabs.create({ url }),
}

/** The whole Gecko surface as one object. See createChromiumApi. */
export function createGeckoApi(): BrowserExtensionApi {
  return {
    storage: geckoStorage,
    identity: geckoIdentity,
    notifications: geckoNotifications,
    runtime: geckoRuntime,
    alarms: geckoAlarms,
    tabs: geckoTabs,
  }
}
