/**
 * The browser surface Watchside actually uses.
 *
 * WHY THIS EXISTS
 *
 * Watchside runs on Chromium today and must run on Firefox before public
 * launch. The two engines expose the same extension APIs under different
 * namespaces - `chrome.*` and `browser.*` - and, more dangerously, under
 * different CALLING CONVENTIONS. `browser.storage.local.get()` returns a
 * promise; Firefox's compatibility `chrome.*` alias is callback-shaped. Code
 * that awaits the latter gets `undefined` rather than an error, which is the
 * kind of failure a unit test cannot see and a user hits immediately.
 *
 * So the boundary is explicit and typed by US, not by either vendor. Feature
 * code imports `ext` and never learns which browser it is on. There is exactly
 * one place in the product that knows: the choice of adapter module, made once,
 * at build time, in ./index.ts.
 *
 * WHAT BELONGS HERE
 *
 * Only the calls Watchside genuinely makes. This is deliberately not a
 * general-purpose WebExtension wrapper - a bigger surface would be a bigger
 * thing to keep true across two engines, for no gain. Ordinary web APIs
 * (DOM, fetch, MutationObserver, localStorage) are NOT abstracted: they are
 * standardised, and wrapping them would be noise.
 *
 * WHAT DOES NOT BELONG HERE
 *
 * Product decisions. The adapter may reshape a call for an engine - see the
 * notification buttons in ./gecko.ts - but it never decides WHETHER to notify,
 * what to say, or when. Those live in src/background/notifier.ts and stay
 * shared.
 */

// ------------------------------------------------------------------ storage

/**
 * The extension's own key/value area, which survives a background restart.
 *
 * Deliberately the same shape `AsyncStorageArea` in src/background/storage.ts
 * already expects, so nothing downstream of it changes.
 */
export interface ExtensionStorageArea {
  get(keys: string | string[]): Promise<Record<string, unknown>>
  set(items: Record<string, unknown>): Promise<void>
  remove(keys: string | string[]): Promise<void>
}

// ----------------------------------------------------------------- identity

export interface ExtensionIdentity {
  /**
   * The redirect the OAuth flow comes back to.
   *
   * Engine-specific by nature and NOT interchangeable: Chromium returns
   * `https://<id>.chromiumapp.org/`, Gecko returns
   * `https://<hash-of-id>.extensions.allizom.org/`. Both must be registered
   * with Supabase before that browser can complete a sign-in. Watchside asks
   * for the value rather than constructing it, so neither can drift.
   */
  getRedirectURL(): string

  /**
   * Runs the interactive sign-in window and resolves with the redirected URL.
   *
   * Rejects if the user closes the window, so the caller never has to
   * distinguish "cancelled" from "succeeded with nothing".
   */
  launchWebAuthFlow(url: string): Promise<string>
}

// ------------------------------------------------------------ notifications

/**
 * What Watchside asks a notification to look like.
 *
 * `buttons` is optional because it is the one field the engines disagree on:
 * Chromium honours it, Gecko rejects the whole call for containing it. The
 * adapter for each engine decides what to do; the caller states its intent
 * once and does not branch.
 */
export interface ExtensionNotificationOptions {
  type: 'basic'
  iconUrl: string
  title: string
  message: string
  buttons?: Array<{ title: string }>
  silent?: boolean
}

export interface ExtensionNotifications {
  create(id: string, options: ExtensionNotificationOptions): void
  clear(id: string): void
  onClicked(handler: (id: string) => void): void
  /**
   * Buttons on a notification, where the engine has them.
   *
   * On an engine without buttons this is registered and simply never fires -
   * not an error, and not something the caller checks for. Watchside's button
   * and its notification body invoke the same action, so the affordance is what
   * is missing, never the capability.
   */
  onButtonClicked(handler: (id: string, buttonIndex: number) => void): void
}

// ------------------------------------------------------------------ runtime

/**
 * One end of the long-lived pipe between a Twitch tab and the background.
 *
 * STRUCTURAL, NOT WRAPPED. Both engines' port objects satisfy this shape
 * exactly, so the adapter hands back the REAL port rather than a wrapper.
 * That matters more than it looks: the background keeps a `Set` of ports and a
 * `WeakMap` keyed on them, using the port's own identity as the tab key -
 * which is how Watchside tracks tabs without the `tabs` permission. Wrapping
 * would put a new object between that invariant and the truth.
 */
export interface ExtensionPort {
  readonly name: string
  postMessage(message: unknown): void
  disconnect(): void
  onMessage: { addListener(handler: (message: never) => void): void }
  onDisconnect: { addListener(handler: () => void): void }
}

export interface ExtensionRuntime {
  /** An absolute URL for a file inside the package, e.g. an icon. */
  getURL(path: string): string
  /** Opens a port from a content script to the background context. */
  connect(name: string): ExtensionPort
  onConnect(handler: (port: ExtensionPort) => void): void
  onStartup(handler: () => void): void
  onInstalled(handler: () => void): void
}

// ------------------------------------------------------------------- alarms

export interface ExtensionAlarms {
  create(name: string, options: { periodInMinutes: number }): void
  /**
   * Narrower than either engine's own event, which passes an alarm object.
   * Watchside only ever reads the name, so the name is what crosses the
   * boundary.
   */
  onAlarm(handler: (name: string) => void): void
}

// --------------------------------------------------------------------- tabs

export interface ExtensionTabs {
  /** Opens a URL in a new tab. Needs no `tabs` permission in either engine. */
  create(url: string): void
}

// ---------------------------------------------------------------------- api

export interface BrowserExtensionApi {
  readonly storage: ExtensionStorageArea
  readonly identity: ExtensionIdentity
  readonly notifications: ExtensionNotifications
  readonly runtime: ExtensionRuntime
  readonly alarms: ExtensionAlarms
  readonly tabs: ExtensionTabs
}

/** Which engine an adapter speaks to. Used by the build and by tests. */
export type BrowserTarget = 'chromium' | 'gecko'
